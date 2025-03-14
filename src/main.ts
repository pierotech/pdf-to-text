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
    // Extract JSON from triple backticks (` ```json ... ``` `)
    const match = responseText.match(/```json([\s\S]+?)```/);
    const jsonString = match ? match[1].trim() : responseText.trim();

    // Validate JSON structure before parsing
    JSON.parse(jsonString);
    return jsonString;
  } catch (error) {
    console.error("❌ OpenAI returned invalid JSON:", responseText);
    throw new Error("Invalid JSON response from OpenAI.");
  }
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

    // 4) Send to OpenAI for JSON extraction
    const OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    const openaiUrl = "https://api.openai.com/v1/chat/completions";

    const messages = [
      {
        role: "system",
        content:
          "You are a data extraction assistant. You must strictly format the output as a valid JSON array:\n\n" +
          "```json\n" +
          "[ { \"SucursalID\": \"string\", \"SucursalName\": \"string\", \"EAN\": \"string\", \"CantidadVendida\": \"integer\", \"Importe\": \"float\", \"NumPersonaVtas\": \"string\" } ]\n" +
          "```\n\n" +
          "Ensure that:\n" +
          "- Floating-point numbers always have a decimal (e.g., `49.90`, not `49`).\n" +
          "- The response must be valid JSON with no extra text.",
      },
      {
        role: "user",
        content: `Extracted text from PDF:\n\n${textContent}\n\nPlease extract and return a valid JSON array.`,
      },
    ];

    const chatBody = {
      model: "gpt-4-turbo",
      messages,
      temperature: 0,
      max_tokens: 2000, // ✅ Allow full response
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
    const rawJson = completion?.choices?.[0]?.message?.content;
    const cleanJson = extractJsonFromResponse(rawJson);

    // Store raw OpenAI response
    const jsonKey = crypto.randomUUID() + ".json";
    await c.env.BUCKET.put(jsonKey, new TextEncoder().encode(cleanJson), {
      httpMetadata: { contentType: "application/json" },
    });

    return c.html(`<p>JSON extracted! <a href="/file/${jsonKey}">Download JSON here</a>.</p>`);

  } catch (error) {
    console.error("Server Error:", error);
    return c.text(`Error processing file: ${error.message}`, 500);
  }
});

export default app;
