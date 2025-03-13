import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getDocumentProxy, extractText } from "unpdf";
import index from "./index.html";

// We'll define the CSV column headers
const CSV_HEADERS = [
  "SucursalID",
  "SucursalName",
  "EAN",
  "CantidadVendida",
  "Importe",
  "NumPersonaVtas",
];

type Bindings = {
  BUCKET: R2Bucket;
  USER: string; // for basicAuth
  PASS: string; // for basicAuth
};

const app = new Hono<{ Bindings: Bindings }>();

// Basic auth for all routes
app.use("*", basicAuth({ username: "USER", password: "PASS" }));

// Serve an HTML form for PDF uploads
app.get("/", (c) => {
  return c.html(index);
});

app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("pdf");

  if (
    !file ||
    typeof file !== "object" ||
    !(file as any).arrayBuffer ||
    typeof (file as any).arrayBuffer !== "function"
  ) {
    return c.text("Please upload a PDF file.", 400);
  }

  // 1) Convert file to ArrayBuffer
  const buffer = await (file as any).arrayBuffer();
  // 2) Extract text using unpdf
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: true });

  // unify text
  const rawText = Array.isArray(result.text)
    ? result.text.join("\n")
    : result.text;

  // (Optional) Debug: see if the extracted text is as you expect
  console.log("=== EXTRACTED TEXT START ===");
  console.log(rawText);
  console.log("=== EXTRACTED TEXT END ===");

  // 3) Parse raw text into structured rows
  const rows = parseSalesReport(rawText);

  // If no rows, let's log a small warning
  if (!rows.length) {
    console.log("WARNING: No rows parsed from PDF. Possibly the text structure doesn't match the regex.");
  }

  // 4) Convert rows to CSV
  const csvString = buildCSV(rows);

  // 5) Store CSV in R2 bucket
  const key = crypto.randomUUID() + ".csv";
  await c.env.BUCKET.put(key, new TextEncoder().encode(csvString), {
    httpMetadata: { contentType: "text/csv" },
  });

  // 6) Return a link to download the CSV
  const filePath = `/file/${key}`;
  return c.html(`
    <p>CSV generated! <a href="${filePath}">Download here</a>.</p>
  `);
});

// Endpoint to download the CSV from R2
app.get("/file/:key", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.BUCKET.get(key);
  if (!object) {
    return c.text("File not found.", 404);
  }
  const data = await object.arrayBuffer();

  return c.body(data, 200, {
    "Content-Type": "text/csv",
    "Content-Disposition": `attachment; filename="${key}"`,
    "Cache-Control": "public, max-age=86400",
  });
});

export default app;

/**
 * parseSalesReport(rawText)
 *
 * 1) Join all lines into a single string (no \n or \r).
 * 2) Use a chunk-based regex to find each Sucursal block.
 *    The chunk goes from "Sucursal <13digits>" up to the next "Sucursal <13digits>" or end of text.
 * 3) Extract the SucursalID, SucursalName, then parse EAN lines inside that chunk with a separate regex.
 * 4) For each EAN line, parse out EAN (13 digits), Importe, CantidadVendida, optional "Num. Persona Vtas:".
 */
function parseSalesReport(rawText: string) {
  // Re-join everything into one line, removing line breaks & extra spaces.
  const singleLine = rawText.replace(/\s*\r?\n\s*/g, " ");

  // The store-chunk regex:
  // - "Sucursal\s+(\d{13})" => captures the store's 13-digit code
  // - ".*?\(\s*([^)]*?)\s*\)" => captures the text in parentheses as the store name
  // - Then "(.*?)" => lazily captures everything up to the next Sucursal or end-of-string
  const storeRegex = new RegExp(
    //  1) "Sucursal" + some whitespace + 13 digits
    //  2) Possibly other text up to "("
    //  3) Capture parentheses content as store name
    //  4) Then capture everything else lazily, stopping at next "Sucursal <13digits>" or end
    `Sucursal\\s+(\\d{13}).*?\$begin:math:text$\\\\s*([^)]*?)\\\\s*\\$end:math:text$([\\s\\S]*?)(?=Sucursal\\s+\\d{13}|$)`,
    "gi"
  );

  const rows: Array<{
    SucursalID: string;
    SucursalName: string;
    EAN: string;
    CantidadVendida: string;
    Importe: string;
    NumPersonaVtas: string;
  }> = [];

  // We'll match each store chunk in the entire text
  let match: RegExpExecArray | null;
  while ((match = storeRegex.exec(singleLine)) !== null) {
    const [_, sucursalID, sucursalName, storeBlock] = match;

    // Now parse all EAN lines within this chunk
    const eanEntries = parseEANLines(sucursalID, sucursalName, storeBlock);
    rows.push(...eanEntries);
  }

  return rows;
}

/**
 * parseEANLines
 * Within a single store block, find lines like:
 *   "8437021807011 119,763 ... maybe more text..."
 * Then parse out EAN, Importe, CantidadVendida, optional "Num. Persona Vtas: X".
 */
function parseEANLines(sucursalID: string, sucursalName: string, storeBlock: string) {
  const eanRegex = new RegExp(
    // 13 digits, then some spaces, then a numeric block
    `(\\d{13})\\s+([\\d.,]+)
     (?:      # Optional "Num. Persona Vtas:" after some text
       (?!Sucursal\\s+\\d{13})  # but not if a new Sucursal starts
       [^\\dN]*(Num\\. Persona Vtas:\\s*(\\S+))?
     )?`,
    "gix"
  );

  // We'll find all EAN lines
  const results: Array<{
    SucursalID: string;
    SucursalName: string;
    EAN: string;
    CantidadVendida: string;
    Importe: string;
    NumPersonaVtas: string;
  }> = [];

  let m: RegExpExecArray | null;
  while ((m = eanRegex.exec(storeBlock)) !== null) {
    const ean = m[1];
    const comboVal = m[2]; // e.g. "119,763"
    const personaFullStr = m[3] || ""; // "Num. Persona Vtas: 000000" or undefined
    const personaCaptured = m[4] || ""; // just the code after "Num. Persona Vtas:"

    // Parse the combined number (e.g. "119,763") => {importe: "119.76", quantity: "3"}
    const { importe, quantity } = parseImporteAndQuantity(comboVal);

    results.push({
      SucursalID: sucursalID,
      SucursalName: sucursalName,
      EAN: ean,
      CantidadVendida: quantity,
      Importe: importe,
      NumPersonaVtas: personaCaptured, // e.g. "0051258002"
    });
  }

  return results;
}

/**
 * parseImporteAndQuantity("119,763") => { importe: "119.76", quantity: "3" }
 * parseImporteAndQuantity("49,91") => { importe: "49.91", quantity: "1" }
 */
function parseImporteAndQuantity(value: string) {
  // remove thousand separators if any
  const cleaned = value.replace(/\./g, "");
  const [intPart, rest] = cleaned.split(",");
  if (!intPart || !rest) {
    // fallback
    return { importe: cleaned, quantity: "1" };
  }
  if (rest.length > 2) {
    return {
      importe: `${intPart}.${rest.slice(0, 2)}`,
      quantity: rest.slice(2),
    };
  } else {
    return {
      importe: `${intPart}.${rest}`,
      quantity: "1",
    };
  }
}

/**
 * buildCSV(rows)
 * Takes the array of row objects and converts them into a CSV string
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
  const header = CSV_HEADERS.join(",");
  const lines = rows.map((r) => {
    return [
      r.SucursalID,
      `"${r.SucursalName}"`,
      r.EAN,
      r.CantidadVendida,
      r.Importe,
      r.NumPersonaVtas,
    ].join(",");
  });
  return header + "\n" + lines.join("\n");
}
