import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getDocumentProxy, extractText } from "unpdf";
import index from "./index.html";

// Add OPENAI_API_KEY to your Worker’s Environment Variables
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

// Handle PDF uploads
app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("pdf");

  // Validate the file
  if (
    !file ||
    typeof file !== "object" ||
    !(file as any).arrayBuffer ||
    typeof (file as any).arrayBuffer !== "function"
  ) {
    return c.text("Please upload a PDF file.", 400);
  }

  // 1) Convert PDF to text using unpdf
  const buffer = await (file as any).arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: true });

  // unify text
  let textContent = Array.isArray(result.text)
    ? result.text.join("\n")
    : result.text;

  // 2) Pre-process the text to optimize token usage & improve OpenAI parsing
  textContent = preprocessExtractedText(textContent);

  // 3) Send cleaned text to OpenAI for CSV conversion
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
- The output contains no extra text, only pure CSV rows

${textContent}
      `,
    },
  ];

  const chatBody = {
    model: "gpt-4", // or "gpt-3.5-turbo" if needed
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
    return c.text(`OpenAI API error: ${err}`, 500);
  }

  const completion = await response.json();
  const rawCsvOutput = completion?.choices?.[0]?.message?.content || "";

  // 4) Store the CSV in R2
  const csvKey = crypto.randomUUID() + ".csv";
  await c.env.BUCKET.put(csvKey, new TextEncoder().encode(rawCsvOutput), {
    httpMetadata: { contentType: "text/csv" },
  });

  // 5) Also store the cleaned raw text for reference
  const txtKey = csvKey.replace(".csv", ".txt");
  await c.env.BUCKET.put(txtKey, new TextEncoder().encode(textContent), {
    httpMetadata: { contentType: "text/plain" },
  });

  // 6) Return an HTML response with links to download both the CSV and raw text
  return c.html(`
    <p>CSV generated! <a href="/file/${csvKey}">Download CSV here</a>.</p>
    <p>Raw extracted text: <a href="/file/${txtKey}">View raw text</a>.</p>
  `);
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

  // Return the file
  const data = await object.arrayBuffer();
  return c.body(data, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400",
  });
});

export default app;

/**
 * **Pre-process extracted text to reduce token usage**
 * - Removes unnecessary blank lines.
 * - Merges broken Sucursal Names into a single line.
 * - Keeps only relevant sales data.
 */
function preprocessExtractedText(text: string): string {
  // (1) Remove excessive whitespace & normalize spaces
  let cleanedText = text.replace(/\s+/g, " ").trim();

  // (2) Normalize multi-line Sucursal Names (joins lines inside parentheses)
  cleanedText.replace(/\(\s*([^\n)]*?)\s*\)/g, (match, inner) => {
    return `(${inner.replace(/\s*\n\s*/g, " ")})`;
  });

  // (3) Keep only relevant sales data
  // Assuming sales data always contains "Sucursal", "EAN", "CantidadVendida", or "Importe"
  const lines = cleanedText.split("\n");
  const relevantLines = lines.filter(line =>
    line.match(/Sucursal|EAN|CantidadVendida|Importe|Num\. Persona Vtas/i)
  );

  return relevantLines.join("\n"); // Return cleaned, relevant text
}
