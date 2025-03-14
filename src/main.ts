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

    // 4) Smart split based on "Sucursal"
    const CHUNK_SIZE = 4000;
    const textChunks = splitTextBySucursal(textContent, CHUNK_SIZE);

    const OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    const openaiUrl = "https://api.openai.com/v1/chat/completions";

    let allJsonData: any[] = [];

    for (const chunk of textChunks) {
      const messages = [
        {
          role: "system",
          content:
            "You are a data extraction assistant. You must strictly format the output as a JSON array with the following structure:\n\n" +
            "{\n" +
            '  "SucursalID": "string",\n' +
            '  "SucursalName": "string",\n' +
            '  "EAN": "string",\n' +
            '  "CantidadVendida": "integer",\n' +
            '  "Importe": "float",\n' +
            '  "NumPersonaVtas": "string"\n' +
            "}\n\n" +
            "Ensure that:\n" +
            "- Each item in the array represents a sales record.\n" +
            "- All fields are correctly extracted.\n" +
            "- Do not include explanations or additional text, only return valid JSON.",
        },
        {
          role: "user",
          content: `
Extracted text from a PDF sales report:

${chunk}

Please extract the data and return a valid JSON array formatted exactly as described in the system instructions.
          `,
        },
      ];

      const chatBody = {
        model: "gpt-4",
        messages,
        temperature: 0,
        max_tokens: 1500, // 🔥 Allow for a larger structured JSON output
        response_format: { "type": "json_object" }
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
      const jsonData = completion?.choices?.[0]?.message?.content;
      allJsonData.push(...JSON.parse(jsonData));
    }

    // 5) Convert JSON to CSV
    const finalCsvOutput = convertJsonToCsv(allJsonData);

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

// Function to split text into chunks based on "Sucursal"
function splitTextBySucursal(text: string, maxTokens: number): string[] {
  const lines = text.split("\n");
  let chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentSize = 0;

  for (const line of lines) {
    if (line.toLowerCase().startsWith("sucursal") && currentSize > 0) {
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

// Function to convert JSON to CSV
function convertJsonToCsv(jsonData: any[]): string {
  const CSV_HEADERS = "SucursalID,SucursalName,EAN,CantidadVendida,Importe,NumPersonaVtas";

  const csvRows = jsonData.map((record) => {
    return [
      `"${record.SucursalID}"`,
      `"${record.SucursalName}"`,
      `"${record.EAN}"`,
      record.CantidadVendida,
      record.Importe.toFixed(2),
      `"${record.NumPersonaVtas}"`,
    ].join(",");
  });

  return CSV_HEADERS + "\n" + csvRows.join("\n");
}

export default app;
