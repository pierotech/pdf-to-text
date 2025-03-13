import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getDocumentProxy, extractText } from "unpdf";
import index from "./index.html";

// We assume these columns for each row in the CSV.
// Adjust them to match your actual reporting needs.
const CSV_HEADERS = [
  "SucursalID",
  "SucursalName",
  "EAN",
  "CantidadVendida",
  "Importe",
  "NumPersonaVtas",
];

// The Hono environment bindings
// - BUCKET: R2 bucket
// - USER, PASS: for basicAuth
type Bindings = {
  BUCKET: R2Bucket;
  USER: string;
  PASS: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Apply basic authentication to all routes
app.use("*", basicAuth({ username: "USER", password: "PASS" }));

// Serve an HTML form for PDF uploads
app.get("/", (c) => {
  return c.html(index);
});

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

  // 1) Extract text from the uploaded PDF
  const buffer = await (file as any).arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: true });

  // The unpdf library might return arrays or strings, so we unify it:
  const rawText = Array.isArray(result.text)
    ? result.text.join("\n")
    : result.text;

  // 2) Parse the text into a structured array of rows
  const rows = parseSalesReport(rawText);

  // 3) Convert those rows to CSV
  const csvString = buildCSV(rows);

  // 4) Store the CSV file in R2 with a .csv extension
  const key = crypto.randomUUID() + ".csv";
  await c.env.BUCKET.put(key, new TextEncoder().encode(csvString), {
    httpMetadata: { contentType: "text/csv" },
  });

  // 5) Return an HTML link so the user can download the CSV
  const filePath = `/file/${key}`;
  return c.html(`
    <p>CSV generated! <a href="${filePath}">Download here</a>.</p>
  `);
});

// Route to retrieve the uploaded CSV file by key
app.get("/file/:key", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.BUCKET.get(key);
  if (!object) {
    return c.text("File not found.", 404);
  }
  const data = await object.arrayBuffer();

  // Return it with headers so browser sees it as CSV
  return c.body(data, 200, {
    "Content-Type": "text/csv",
    "Content-Disposition": `attachment; filename="${key}"`,
    "Cache-Control": "public, max-age=86400",
  });
});

export default app;

/**
 * parseSalesReport(rawText)
 * -------------------------
 * Given the plain text from unpdf, this function attempts to:
 *  1) Detect blocks for each "Sucursal"
 *  2) Extract EAN lines, the quantity sold, the import (price), and Num Persona Vtas
 *  3) Return an array of row objects, each representing a single line in the final CSV
 */
function parseSalesReport(rawText: string) {

  console.log("---- RAW TEXT ----\n", rawText);
  const lines = rawText.split(/\r?\n/).map((l) => l.trim());
  lines.forEach((l, idx) => console.log(`${idx}: [${l}]`));
  
  // 1) Break the big text into lines
  // const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // We'll accumulate results here
  const rows: Array<{
    SucursalID: string;
    SucursalName: string;
    EAN: string;
    CantidadVendida: string;
    Importe: string;
    NumPersonaVtas: string;
  }> = [];

  let currentSucursalID = "";
  let currentSucursalName = "";

  // 2) We'll walk through the lines and watch for patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A) Detect "Sucursal" lines:
    //    Typically "Sucursal" is followed by a numeric code or parentheses with store info
    //    e.g. "8422416200034" and then "( ECI GOYA 0003 )"
    if (line.match(/^Sucursal$/i)) {
      // Next line might be the numeric code
      const possibleID = lines[i + 1] || "";
      // Next next line might be the store name in parentheses
      const possibleName = lines[i + 2] || "";

      // We'll do some naive checks
      if (possibleID.match(/^\d{10,}/)) {
        currentSucursalID = possibleID;
      } else {
        currentSucursalID = "";
      }

      if (possibleName.startsWith("(")) {
        currentSucursalName = possibleName.replace(/[()]/g, "").trim();
      } else {
        currentSucursalName = "";
      }
    }

    // B) Detect EAN lines:
    //    After an "EAN" label, we see a numeric code (like 8437021807011),
    //    then on the next line we might see "49,9" (the amount) and then "1" (the quantity).
    if (line.match(/^EAN$/i)) {
      // In the sample text, after the line "EAN", the next line might be "8437021807011"
      // Then next line might be "49,9" (importe?), next line "1" (quantity).
      // Sometimes you might see multiple EAN blocks in the same sucursal.

      const eanLine = lines[i + 1] || "";
      // The line after that might be the import
      const importLine = lines[i + 2] || "";
      // The line after that might be the quantity
      const qtyLine = lines[i + 3] || "";

      // We also might find a line "Num. Persona Vtas:  0051258002"
      // We'll search a few lines ahead for that pattern
      let personaLine = "";
      for (let j = 1; j < 6; j++) {
        const lookahead = lines[i + j];
        if (!lookahead) break;
        if (lookahead.startsWith("Num. Persona Vtas:")) {
          personaLine = lookahead;
          break;
        }
      }

      const ean = eanLine.match(/^\d{10,}/) ? eanLine : "";
      const importe = importLine || ""; // e.g. "49,9"
      const qty = qtyLine || "";        // e.g. "1"

      // Extract persona number if present
      let numPersonaVtas = "";
      const personaMatch = personaLine.match(/Num\. Persona Vtas:\s*(\S+)/);
      if (personaMatch) {
        numPersonaVtas = personaMatch[1];
      }

      // We'll store a row in our CSV result, even if some fields are blank
      if (ean) {
        rows.push({
          SucursalID: currentSucursalID,
          SucursalName: currentSucursalName,
          EAN: ean,
          CantidadVendida: qty,
          Importe: importe,
          NumPersonaVtas: numPersonaVtas,
        });
      }
    }
  }

  return rows;
}

/**
 * buildCSV(rows)
 * --------------
 * Takes an array of row objects (from parseSalesReport) and builds a CSV string.
 */
function buildCSV(
  rows: Array<{
    SucursalID: string;
    SucursalName: string;
    EAN: string;
    CantidadVendida: string;
    Importe: string;
    NumPersonaVtas: string;
  }>
) {
  // Join the headers
  const header = CSV_HEADERS.join(",");

  // Build each line
  const lines = rows.map((r) => {
    // Make sure to quote/escape strings if they might contain commas
    return [
      `"${r.SucursalID}"`,
      `"${r.SucursalName}"`,
      `"${r.EAN}"`,
      `"${r.CantidadVendida}"`,
      `"${r.Importe}"`,
      `"${r.NumPersonaVtas}"`,
    ].join(",");
  });

  // Join them with newlines
  return header + "\n" + lines.join("\n");
}
