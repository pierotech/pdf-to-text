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

  // 3) Parse raw text into structured rows
  const rows = parseSalesReport(rawText);

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
 * This improved parser uses a state‑machine style:
 * 1. When a line matches the Sucursal regex, we update the current store.
 * 2. When a line matches the EAN regex (e.g. "8437021807011 119,763"),
 *    we split the numeric part into Importe and CantidadVendida:
 *      - If more than 2 digits follow the comma, the extras represent the quantity.
 *      - Otherwise, quantity defaults to "1".
 * 3. Optionally, the next line (if it starts with "Num. Persona Vtas:")
 *    is captured and attached to the current record.
 */
function parseSalesReport(rawText: string) {
  // Normalize and filter lines
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let currentSucursalID = "";
  let currentSucursalName = "";
  const rows: Array<{
    SucursalID: string;
    SucursalName: string;
    EAN: string;
    CantidadVendida: string;
    Importe: string;
    NumPersonaVtas: string;
  }> = [];

  // Regex to capture Sucursal lines (e.g., "Sucursal   8422416200034         ( ECI GOYA 0003 ) ...")
  const sucursalRegex = /^Sucursal\s+(\d{13})\s+\(\s*([^)]*?)\s*\)/;
  // Regex to capture EAN lines (e.g., "8437021807011 119,763")
  const eanRegex = /^(\d{13})\s+([\d.,]+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Update current Sucursal if line matches
    const sucMatch = line.match(sucursalRegex);
    if (sucMatch) {
      currentSucursalID = sucMatch[1];
      currentSucursalName = sucMatch[2];
      continue;
    }

    // Process EAN lines
    const eanMatch = line.match(eanRegex);
    if (eanMatch) {
      const ean = eanMatch[1];
      const numBlock = eanMatch[2];
      const [intPart, fracPart] = numBlock.split(",");
      let importe = "";
      let cantidad = "";
      if (fracPart.length > 2) {
        importe = `${intPart}.${fracPart.slice(0, 2)}`;
        cantidad = fracPart.slice(2);
      } else {
        importe = `${intPart}.${fracPart}`;
        cantidad = "1";
      }

      // Capture optional Num. Persona Vtas line
      let numPersona = "";
      if (i + 1 < lines.length && lines[i + 1].startsWith("Num. Persona Vtas:")) {
        const personaMatch = lines[i + 1].match(/Num\. Persona Vtas:\s*(\S+)/);
        if (personaMatch) numPersona = personaMatch[1];
        i++; // Skip the persona line
      }

      rows.push({
        SucursalID: currentSucursalID,
        SucursalName: currentSucursalName,
        EAN: ean,
        CantidadVendida: cantidad,
        Importe: importe,
        NumPersonaVtas: numPersona,
      });
    }
  }

  return rows;
}

/**
 * buildCSV(rows)
 *
 * Converts row objects into a CSV string.
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
  const csvLines = rows.map(row =>
    [
      row.SucursalID,
      `"${row.SucursalName}"`, // Preserve quotes for SucursalName
      row.EAN,
      row.CantidadVendida,
      row.Importe,
      row.NumPersonaVtas,
    ].join(",")
  );
  return `${header}\n${csvLines.join("\n")}`;
}
