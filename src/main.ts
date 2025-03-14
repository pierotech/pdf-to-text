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
  const textContent = Array.isArray(result.text)
    ? result.text.join(" ")
    : result.text;

  // 2) Send extracted text to OpenAI Chat Completion for CSV conversion
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

Ensure all values are correctly formatted and escape any commas inside fields.

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

  // 3) Process OpenAI’s response to ensure correct CSV formatting
  const csvOutput = buildCSV(rawCsvOutput);

  // 4) Store the CSV in R2
  const csvKey = crypto.randomUUID() + ".csv";
  await c.env.BUCKET.put(csvKey, new TextEncoder().encode(csvOutput), {
    httpMetadata: { contentType: "text/csv" },
  });

  // 5) Also store the extracted raw text for reference
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
 * CSV Escaping Function
 * Ensures values containing commas, quotes, or newlines are properly formatted.
 */
function csvEscape(value: string): string {
  if (typeof value !== "string") value = String(value);
  const escaped = value.replace(/"/g, '""'); // Escape quotes
  return `"${escaped}"`; // Wrap in double quotes
}

/**
 * Ensures OpenAI’s response is correctly formatted as CSV.
 * If OpenAI sends unescaped commas or missing quotes, we fix it here.
 */
function buildCSV(rawCsvOutput: string): string {
  const lines = rawCsvOutput
    .split("\n")
    .map((line) => {
      const parts = line.split(",");
      return parts.map(csvEscape).join(",");
    });

  return lines.join("\n");
}
