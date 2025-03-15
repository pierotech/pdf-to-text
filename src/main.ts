import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getDocumentProxy, extractText } from "unpdf";
import index from "./index.html";

type Bindings = {
  BUCKET: R2Bucket;
  USER: string;         // For basicAuth
  PASS: string;         // For basicAuth
  OPENAI_API_KEY: string; 
};

const app = new Hono<{ Bindings: Bindings }>();

// 1) BasicAuth for all routes
app.use("*", basicAuth({ username: "USER", password: "PASS" }));

//
// ────────────────────────────────────────────────────────────
//   ::::: FUNCTIONS FOR PDF → BLOCKS, BLOCKS → OPENAI, MERGE JSON, ETC. : :  
// ────────────────────────────────────────────────────────────
//

// Extract JSON safely from OpenAI's triple‐backticked response
function extractJsonFromResponse(responseText: string): string {
  try {
    // Match "```json ... ```" block
    const match = responseText.match(/```json([\s\S]+?)```/);
    const jsonString = match ? match[1].trim() : responseText.trim();
    JSON.parse(jsonString); // Validate
    return jsonString;
  } catch (error) {
    console.error("❌ OpenAI returned invalid JSON:", responseText);
    throw new Error("Invalid JSON response from OpenAI.");
  }
}

// Convert final JSON to CSV
function convertJsonToCsv(jsonData: any[]): string {
  const CSV_HEADERS = "SucursalName,EAN,CantidadVendida,Importe";

  const csvRows = jsonData.map((record) => {
    // Safely convert numeric fields
    const cantidad = parseInt(record.CantidadVendida, 10) || 0;
    const importeVal = parseFloat(record.Importe) || 0; // fallback to 0 if parse fails

    return [
      `"${record.SucursalName}"`,
      `"${record.EAN}"`,
      cantidad,
      importeVal.toFixed(2),
    ].join(",");
  });

  return CSV_HEADERS + "\n" + csvRows.join("\n");
}

/**
 * Extract Sucursal blocks from the entire PDF text:
 * Each block:
 *   starts with: "Sucursal" (case-insensitive)
 *   ends with:   "* Total importe en la sucursal: XX.XX"
 * 
 * Example:
 *   Sucursal ... lines ...
 *   * Total importe en la sucursal: 49.90
 * 
 * We'll gather each block as a single string, push it into an array.
 */
function extractBlocksFromPDFText(fullText: string): string[] {
  const blocks: string[] = [];
  
  const lines = fullText.split("\n");
  let currentBlock: string[] = [];
  let capturing = false;
  
  for (const line of lines) {
    // If line starts with "Sucursal" (ignore case), we begin capturing a new block
    if (line.toLowerCase().startsWith("sucursal")) {
      // If there was a block in progress, push it first
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join("\n"));
      }
      // Start a fresh block
      currentBlock = [line];
      capturing = true;
      continue;
    }
    
    if (capturing) {
      currentBlock.push(line);
      // If line includes "* Total importe en la sucursal:"
      // we consider that as the end of the block
      if (/\* total importe en la sucursal:\s*\d+(\.\d+)?/i.test(line)) {
        // End of this block
        blocks.push(currentBlock.join("\n"));
        currentBlock = [];
        capturing = false;
      }
    }
  }
  
  // If final block didn't end with "* Total importe en la sucursal", push it anyway
  if (capturing && currentBlock.length > 0) {
    blocks.push(currentBlock.join("\n"));
  }
  
  return blocks;
}

/**
 * If we have more blocks than we can safely handle in one chunk, 
 * we split them into multiple arrays. For instance, if we have 40 blocks
 * and we think the token limit is ~some value, we might do 20 blocks in chunk1, 20 in chunk2, etc.
 */
function splitBlocksForOpenAI(blocks: string[], maxBlocksPerRequest: number): string[][] {
  // We'll just chunk the blocks array into subarrays of length maxBlocksPerRequest
  const splitted: string[][] = [];
  
  for (let i = 0; i < blocks.length; i += maxBlocksPerRequest) {
    splitted.push(blocks.slice(i, i + maxBlocksPerRequest));
  }
  return splitted;
}

//
// ──────────────────────────────────────────────────────────────────────────────────
//   ::::: PDF UPLOAD HANDLING + R2 STORAGE + OPENAI PARTS : :  
// ──────────────────────────────────────────────────────────────────────────────────
//
app.get("/", (c) => c.html(index));

app.post("/upload", async (c) => {
  try {
    // 1) Validate PDF
    const formData = await c.req.formData();
    const file = formData.get("pdf");
    if (
      !file ||
      typeof file !== "object" ||
      !(file as any).arrayBuffer ||
      typeof (file as any).arrayBuffer !== "function"
    ) {
      return c.text("Error: Please upload a valid PDF file.", 400);
    }
    
    // 2) Convert PDF → text
    const buffer = await (file as any).arrayBuffer();
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    
    let textContent = Array.isArray(result.text)
      ? result.text.join("\n")
      : result.text;
    
    // 3) Save raw extracted text in R2
    const rawTxtKey = crypto.randomUUID() + ".txt";
    await c.env.BUCKET.put(rawTxtKey, new TextEncoder().encode(textContent), {
      httpMetadata: { contentType: "text/plain" },
    });
    
    // 4) Extract blocks from PDF text
    const blocks = extractBlocksFromPDFText(textContent);
    
    // 5) Decide how many blocks per request. We'll set, for example, 5 blocks per request
    const MAX_BLOCKS_PER_REQUEST = 10; // tweak as needed
    const splittedBlocks = splitBlocksForOpenAI(blocks, MAX_BLOCKS_PER_REQUEST);
    
    // 6) Send each splittedBlocks array to OpenAI, accumulate JSON
    const allJsonData: any[] = [];
    const OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    const openaiUrl = "https://api.openai.com/v1/chat/completions";
    
    for (const blockGroup of splittedBlocks) {
      // Build a single string from these blocks
      // We'll just join them with a delimiter
      const chunkText = blockGroup.join("\n\n");
      
      const messages = [
        {
          role: "system",
          content:
            "You are a data extraction assistant. Return a valid JSON array with the structure:\n\n" +
            "```json\n" +
            "[\n" +
            "  {\n" +
            '    "SucursalName": "string",\n' +
            '    "EAN": "string",\n' +
            '    "CantidadVendida": "integer",\n' +
            '    "Importe": "float",\n' +
            "  }\n" +
            "]\n" +
            "```\n\n" +
            "- The response must be valid JSON inside triple backticks.\n" +
            "- No additional text or explanations.\n" +
            "- Each item is a single sale record from these blocks.\n" +
            "- If some block has no sales, skip it or return an empty array.\n" +
            "- Floating‐point numbers always have decimal digits (e.g. 49.90).",
        },
        {
          role: "user",
          content: `Here are some Sucursal blocks:\n\n${chunkText}\n\nPlease parse them and return only a valid JSON array with all the records.`,
        },
      ];
      
      const chatBody = {
        model: "gpt-4-turbo",
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
        console.error("❌ OpenAI API Error:", err);
        return c.text(`Error: OpenAI API failed: ${err}`, 500);
      }
      
      const completion = await response.json();
      const rawJson = completion?.choices?.[0]?.message?.content ?? "";
      const cleanJson = extractJsonFromResponse(rawJson);
      
      // Merge partial JSON into allJsonData
      allJsonData.push(...JSON.parse(cleanJson));
    }
    
    // 7) Now we have all JSON in allJsonData
    // Convert to CSV
    const finalCsvOutput = convertJsonToCsv(allJsonData);
    
    // Save JSON in R2
    const jsonKey = crypto.randomUUID() + ".json";
    await c.env.BUCKET.put(jsonKey, new TextEncoder().encode(JSON.stringify(allJsonData, null, 2)), {
      httpMetadata: { contentType: "application/json" },
    });
    
    // Save CSV in R2
    const csvKey = crypto.randomUUID() + ".csv";
    await c.env.BUCKET.put(csvKey, new TextEncoder().encode(finalCsvOutput), {
      httpMetadata: { contentType: "text/csv" },
    });
    
    // Return final HTML
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

// Route to retrieve stored files from R2
app.get("/file/:key", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.BUCKET.get(key);

  if (!object) {
    return c.text("❌ File not found.", 404);
  }

  const data = await object.arrayBuffer();
  
  // We'll set a generic content type or detect from extension
  let contentType = "application/octet-stream";
  if (key.endsWith(".txt")) contentType = "text/plain";
  if (key.endsWith(".json")) contentType = "application/json";
  if (key.endsWith(".csv")) contentType = "text/csv";

  return c.body(data, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400",
    "Content-Disposition": `attachment; filename="${key}"`,
  });
});

export default app;
