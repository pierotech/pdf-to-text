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

    // 2) Extract text from PDF
    const buffer = await (file as any).arrayBuffer();
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });

    // unify text
    let textContent = Array.isArray(result.text)
      ? result.text.join("\n")
      : result.text;

    // 3) Store raw extracted text in R2
    const rawTxtKey = crypto.randomUUID() + ".txt";
    await c.env.BUCKET.put(rawTxtKey, new TextEncoder().encode(textContent), {
      httpMetadata: { contentType: "text/plain" },
    });

    // 4) Smart split based on `SucursalID`
    const CHUNK_SIZE = 4000;
    const textChunks = splitTextBySucursalID(textContent, CHUNK_SIZE);

    const OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    const openaiUrl = "https://api.openai.com/v1/chat/completions";

    let allCsvData = [];

    for (const chunk of textChunks) {
      const messages = [
        {
          role: "system",
          content:
            "You are a data extraction assistant. You must strictly format the output as CSV with exactly these columns: SucursalID, SucursalName, EAN, CantidadVendida, Importe, NumPersonaVtas.",
        },
        {
          role: "user",
          content: `
Extracted text from a PDF sales report:

${chunk}

Please generate a CSV file with only these columns:
SucursalID, SucursalName, EAN, CantidadVendida, Importe, NumPersonaVtas

Rules:
- Do not add extra columns.
- Ensure all values are correctly aligned under their respective headers.
- The output should be formatted exactly as a CSV.
- Do not include explanations, only output the CSV content.
          `,
        },
      ];

      const chatBody = {
        model: "gpt-4",
        messages,
        temperature: 0,
        max_tokens: 1000,
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
      let csvChunk = completion?.choices?.[0]?.message?.content || "";
      allCsvData.push(csvChunk);
    }

    // 5) Merge all CSV parts and clean duplicates
    let finalCsvOutput = mergeCsvChunks(allCsvData);

    // 6) Store the CSV in R2
    const csvKey = crypto.randomUUID() + ".csv";
    await c.env.BUCKET.put(csvKey, new TextEncoder().encode(finalCsvOutput), {
      httpMetadata: { contentType: "text/csv" },
    });

    // 7) Return download links for CSV and extracted text
    return c.html(`
      <p>CSV generated! <a href="/file/${csvKey}">Download CSV here</a>.</p>
      <p>Raw extracted text: <a href="/file/${rawTxtKey}">View raw text</a>.</p>
    `);

  } catch (error) {
    console.error("Server Error:", error);
    return c.text(`Error processing file: ${error.message}`, 500);
  }
});

// Function to split text into chunks based on `SucursalID`
function splitTextBySucursalID(text: string, maxTokens: number): string[] {
  const lines = text.split("\n");
  let chunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const line of lines) {
    if (line.match(/^\d{13}$/) && currentSize > 0) {
      // New `SucursalID` found, start a new chunk if size is exceeded
      if (currentSize >= maxTokens) {
        chunks.push(currentChunk.join("\n"));
        currentChunk = [];
        currentSize = 0;
      }
    }

    currentChunk.push(line);
    currentSize += line.split(" ").length;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n"));
  }

  return chunks;
}

// Function to merge CSV parts and ensure only one header set
function mergeCsvChunks(csvChunks: string[]): string {
  const CSV_HEADERS = "SucursalID,SucursalName,EAN,CantidadVendida,Importe,NumPersonaVtas";
  let allRows = csvChunks.flatMap((csv) => csv.trim().split("\n"));
  
  // Remove duplicate headers
  allRows = allRows.filter((row, index) => index === 0 || row !== CSV_HEADERS);

  return CSV_HEADERS + "\n" + allRows.join("\n");
}

// Route to retrieve stored files
app.get("/file/:key", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.BUCKET.get(key);
  if (!object) {
    return c.text("File not found in R2 storage.", 404);
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
