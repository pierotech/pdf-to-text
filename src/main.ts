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
            "```json\n" +
            "[\n" +
            "  {\n" +
            '    "SucursalID": "string",\n' +
            '    "SucursalName": "string",\n' +
            '    "EAN": "string",\n' +
            '    "CantidadVendida": "integer",\n' +
            '    "Importe": "float",\n' +
            '    "NumPersonaVtas": "string"\n' +
            "  }\n" +
            "]\n" +
            "```\n\n" +
            "Ensure that:\n" +
            "- Each item in the array represents a sales record.\n" +
            "- All fields are correctly extracted.\n" +
            "- Do not include explanations or additional text, only return valid JSON inside triple backticks.",
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
        model: "gpt-4-turbo",
        messages,
        temperature: 0,
        max_tokens: 1500,
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
      const jsonData = extractJsonFromResponse(completion?.choices?.[0]?.message?.content);
      allJsonData.push(...JSON.parse(jsonData));
    }

    // 5) Convert JSON to CSV
    const finalCsvOutput = convertJsonToCsv(allJsonData);

    // 6) Store JSON response in R2
    const jsonKey = crypto.randomUUID() + ".json";
    await c.env.BUCKET.put(jsonKey, new TextEncoder().encode(JSON.stringify(allJsonData, null, 2)), {
      httpMetadata: { contentType: "application/json" },
    });

    // 7) Store the CSV in R2
    const csvKey = crypto.randomUUID() + ".csv";
    await c.env.BUCKET.put(csvKey, new TextEncoder().encode(finalCsvOutput), {
      httpMetadata: { contentType: "text/csv" },
    });

    // 8) Return download links for JSON, CSV, and raw extracted text
    return c.html(`
      <p>CSV generated! <a href="/file/${csvKey}">Download CSV here</a>.</p>
      <p>JSON extracted! <a href="/file/${jsonKey}">Download JSON here</a>.</p>
      <p>Raw extracted text: <a href="/file/${rawTxtKey}">View raw text</a>.</p>
    `);

  } catch (error) {
    console.error("Server Error:", error);
    return c.text(`Error processing file: ${error.message}`, 500);
  }
});

// Function to extract JSON from OpenAI response
function extractJsonFromResponse(responseText: string): string {
  return responseText.replace(/```json|```/g, "").trim();
}

export default app;
