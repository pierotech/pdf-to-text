import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getDocumentProxy, extractText } from "unpdf";
import index from "./index.html";

// Add OPENAI_API_KEY to your Worker’s Environment Variables
type Bindings = {
  BUCKET: R2Bucket;
  USER: string;
  PASS: string;
  OPENAI_API_KEY: string; // <--- We'll need this
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

  // 2) Send extracted text to OpenAI Chat Completion
  //    telling GPT to parse it into CSV
  const OPENAI_API_KEY = c.env.OPENAI_API_KEY; // ensure you've set this in your Worker’s env
  const openaiUrl = "https://api.openai.com/v1/chat/completions";

  // Provide instructions for GPT to parse the text into CSV
  // Adjust your "system" or "user" prompts as needed, depending on how your text is structured.
  const messages = [
    {
      role: "system",
      content:
        "You are a helpful assistant that can parse text from a PDF sales report into structured CSV data.",
    },
    {
      role: "user",
      content: `
Here is the text extracted from a PDF daily sales report. 
Please parse and return only CSV lines with the columns:
SucursalID,SucursalName,EAN,CantidadVendida,Importe,NumPersonaVtas

Extract the data carefully:
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
  // GPT's returned CSV
  const csvOutput = completion?.choices?.[0]?.message?.content || "";

  // 3) Store the CSV in R2
  const csvKey = crypto.randomUUID() + ".csv";
  await c.env.BUCKET.put(csvKey, new TextEncoder().encode(csvOutput), {
    httpMetadata: { contentType: "text/csv" },
  });

  // 4) Also store the extracted text if you like (not mandatory)
  // e.g. create a .txt copy for reference
  const txtKey = csvKey.replace(".csv", ".txt");
  await c.env.BUCKET.put(txtKey, new TextEncoder().encode(textContent), {
    httpMetadata: { contentType: "text/plain" },
  });

  // 5) Return an HTML response with a link to download the CSV
  return c.html(`
    <p>CSV generated! <a href="/file/${csvKey}">Download CSV here</a>.</p>
    <p>Raw text stored at: <a href="/file/${txtKey}">/${txtKey}</a></p>
  `);
});

// Route to retrieve the stored files
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
    "Cache-Control": "public, max-age=86400", // 1 day caching
  });
});

export default app;
