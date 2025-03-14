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

// Function to extract JSON from OpenAI response safely
function extractJsonFromResponse(responseText: string): string {
  try {
    const match = responseText.match(/```json([\s\S]+?)```/);
    const jsonString = match ? match[1].trim() : responseText.trim();
    JSON.parse(jsonString);
    return jsonString;
  } catch (error) {
    console.error("❌ OpenAI returned invalid JSON:", responseText);
    throw new Error("Invalid JSON response from OpenAI.");
  }
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

// Serve an HTML form for PDF uploads
app.get("/", (c) => c.html(index));

app.post("/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("pdf");

    if (!file || typeof file !== "object" || !(file as any).arrayBuffer) {
      return c.text("Error: Please upload a valid PDF file.", 400);
    }

    // 1) Extract text from PDF
    const buffer = await (file as any).arrayBuffer();
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });

    let textContent = Array.isArray(result.text)
      ? result.text.join("\n")
      : result.text;

    // 2) Store raw extracted text in R2
    const rawTxtKey = crypto.randomUUID() + ".txt";
    await c.env.BUCKET.put(rawTxtKey, new TextEncoder().encode(textContent), {
      httpMetadata: { contentType: "text/plain" },
    });

    // 3) Smartly split text if it's too large
    const MAX_CHARACTERS = 8000; // OpenAI limit per request
    const textChunks =
      textContent.length > MAX_CHARACTERS ? splitTextBySucursal(textContent, 2000) : [textContent];

    // 4) Send each chunk separately to OpenAI & merge results
    const OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    const openaiUrl = "https://api.openai.com/v1/chat/completions";
    let allJsonData: any[] = [];

    for (const chunk of textChunks) {
      const messages = [
        {
          role: "system",
          content:
            "Extract sales data as a valid JSON array:\n\n" +
            "```json\n" +
            "[ { \"SucursalID\": \"string\", \"SucursalName\": \"string\", \"EAN\": \"string\", \"CantidadVendida\": \"integer\", \"Importe\": \"float\", \"NumPersonaVtas\": \"string\" } ]\n" +
            "```\n\n" +
            "**Important:**\n" +
            "- Always return valid JSON inside triple backticks.\n" +
            "- No extra text or explanations.",
        },
        { role: "user", content: chunk },
      ];

      const response = await fetch(openaiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4-turbo",
          messages,
          temperature: 0,
          max_tokens: 2000,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error("❌ OpenAI API Error:", err);
        return c.text(`Error: OpenAI API failed: ${err}`, 500);
      }

      const completion = await response.json();
      const rawJson = completion?.choices?.[0]?.message?.content;
      const cleanJson = extractJsonFromResponse(rawJson);

      allJsonData.push(...JSON.parse(cleanJson));
    }

    // 5) Store JSON in R2
    const jsonKey = crypto.randomUUID() + ".json";
    await c.env.BUCKET.put(jsonKey, new TextEncoder().encode(JSON.stringify(allJsonData, null, 2)), {
      httpMetadata: { contentType: "application/json" },
    });

    // 6) Convert JSON to CSV
    const finalCsvOutput = convertJsonToCsv(allJsonData);

    // 7) Store CSV in R2
    const csvKey = crypto.randomUUID() + ".csv";
    await c.env.BUCKET.put(csvKey, new TextEncoder().encode(finalCsvOutput), {
      httpMetadata: { contentType: "text/csv" },
    });

    // 8) Return download links
    return c.html(`
      <p>✅ <strong>CSV generated:</strong> <a href="/file/${csvKey}">Download CSV</a></p>
      <p>✅ <strong>JSON extracted:</strong> <a href="/file/${jsonKey}">Download JSON</a></p>
      <p>✅ <strong>Raw extracted text:</strong> <a href="/file/${rawTxtKey}">Download TXT</a></p>
    `);
  } catch (error) {
    console.error("Server Error:", error);
    return c.text(`Error processing file: ${error.message}`, 500);
  }
});

// **🔥 Fix: Route to Serve R2 Files 🔥**
app.get("/file/:key", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.BUCKET.get(key);

  if (!object) {
    return c.text("❌ File not found.", 404);
  }

  const data = await object.arrayBuffer();
  return c.body(data, 200, { "Content-Type": "application/octet-stream" });
});

export default app;
