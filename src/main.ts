import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getDocumentProxy, extractText } from "unpdf";
import index from "./index.html";

type Bindings = {
  BUCKET: R2Bucket;
  USER: string;
  PASS: string;
  OPENAI_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Apply basic authentication to all routes
app.use("*", basicAuth({ username: "USER", password: "PASS" }));

// Serve an HTML form for PDF uploads
app.get("/", (c) => c.html(index));

app.post("/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("pdf");

    if (!file || typeof file !== "object" || !(file as any).arrayBuffer) {
      return c.text("Error: Please upload a valid PDF file.", 400);
    }

    // 1) Check File Size (Limit ~750KB to prevent exceeding 1MB)
    const MAX_SIZE = 750 * 1024; // 750KB
    if ((file as any).size > MAX_SIZE) {
      return c.text("Error: File too large. Max allowed size is 750KB.", 400);
    }

    // 2) Stream PDF instead of fully buffering
    const buffer = await (file as any).arrayBuffer();
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });

    // unify text
    let textContent = Array.isArray(result.text)
      ? result.text.join("\n")
      : result.text;

    // 3) Pre-process text before sending it to OpenAI
    textContent = preprocessExtractedText(textContent);
    textContent = replaceCommasWithDots(textContent);

    // 4) Store Raw Extracted Text in R2 (for debugging)
    const rawTxtKey = crypto.randomUUID() + ".txt";
    await c.env.BUCKET.put(rawTxtKey, new TextEncoder().encode(textContent), {
      httpMetadata: { contentType: "text/plain" },
    });

    // 5) Send cleaned text to OpenAI
    const OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    const openaiUrl = "https://api.openai.com/v1/chat/completions";

    const messages = [
      {
        role: "system",
        content:
          "You are a helpful assistant that converts extracted text from a PDF sales report into structured CSV data.",
      },
      {
        role: "user",
        content: `
Here is the text extracted from a PDF daily sales report. 
Please parse and return only CSV lines with the columns:
SucursalID,SucursalName,EAN,CantidadVendida,Importe,NumPersonaVtas

Ensure:
- Each value is separated by commas
- SucursalName is correctly formatted without extra line breaks
- Replace decimal separators correctly (use dots instead of commas)
- The output contains no extra text, only pure CSV rows

${textContent}
        `,
      },
    ];

    const chatBody = {
      model: "gpt-4",
      messages,
      temperature: 0,
      max_tokens: 2000,
    };

    const response = await fetch(openaiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(chatBody),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenAI API Error:", err);
      return c.text(`Error: OpenAI API failed: ${err}`, 500);
    }

    const completion = await response.json();
    const rawCsvOutput = completion?.choices?.[0]?.message?.content || "";

    // 6) Add Headers to the CSV before storing
    const CSV_HEADERS = "SucursalID,SucursalName,EAN,CantidadVendida,Importe,NumPersonaVtas";
    const finalCsvOutput = CSV_HEADERS + "\n" + rawCsvOutput.trim();

    // 7) Store the CSV in R2
    const csvKey = crypto.randomUUID() + ".csv";
    await c.env.BUCKET.put(csvKey, new TextEncoder().encode(finalCsvOutput), {
      httpMetadata: { contentType: "text/csv" },
    });

    return c.html(`
      <p>CSV generated! <a href="/file/${csvKey}">Download CSV here</a>.</p>
      <p>Raw extracted text: <a href="/file/${rawTxtKey}">View raw text</a>.</p>
    `);

  } catch (error) {
    console.error("Server Error:", error);
    return c.text(`Error processing file: ${error.message}`, 500);
  }
});

// Route to retrieve stored files
app.get("/file/:key", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.BUCKET.get(key);
  if (!object) {
    return c.text("File not found.", 404);
  }

  const extension = key.split(".").pop()?.toLowerCase() || "";
  let contentType = "text/plain";
  if (extension === "csv") {
    contentType = "text/csv";
  }

  const data = await object.arrayBuffer();
  return c.body(data, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400",
  });
});

export default app;

/**
 * **Pre-process extracted text to fix nested parentheses and clean formatting**
 */
function preprocessExtractedText(text: string): string {
  let cleanedText = text.replace(/\s+/g, " ").trim();

  // Handle nested parentheses correctly
  cleanedText = cleanedText.replace(/\(([^()]*\([^()]*\)[^()]*)\)/g, (match, inner) => {
    return `(${inner.replace(/\s*\n\s*/g, " ")})`;
  });

  const lines = cleanedText.split("\n");
  const relevantLines = lines.filter(line =>
    line.match(/Sucursal|EAN|CantidadVendida|Importe|Num\. Persona Vtas/i)
  );

  return relevantLines.join("\n");
}

/**
 * **Replace commas with dots before sending text to OpenAI**
 */
function replaceCommasWithDots(text: string): string {
  return text.replace(/,/g, ".");
}
