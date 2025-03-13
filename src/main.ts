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
 * This parser scans the extracted PDF text and:
 * 1. Updates the current store when a line matching a Sucursal pattern is found.
 * 2. Captures EAN lines that start with 13 digits and a numeric block (e.g. "8437021807011 49,91").
 *    It splits the numeric block into an Importe (with two decimals) and CantidadVendida.
 * 3. If the next line starts with "Num. Persona Vtas:", that value is added.
 */
function parseSalesReport(rawText: string) {
  // Split text into lines and trim whitespace; discard empty lines.
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

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

  // Improved regex: allow any leading spaces; case-insensitive for "Sucursal".
  const sucursalRegex = /^\s*Sucursal\s+(\d{13})\s+.*\(\s*([^)]*?)\s*\)/i;
  // EAN regex: allow leading spaces.
  const eanRegex = /^\s*(\d{13})\s+([\d.,]+)/;

  // Helper: parse a number block like "119,763" into importe and quantity.
  function parseImporteAndQuantity(value: string) {
    const cleaned = value.replace(/\./g, ""); // remove thousand separators if any
    const parts = cleaned.split(",");
    if (parts.length !== 2) {
      return { importe: value, quantity: "1" };
    }
    const [intPart, fracPart] = parts;
    if (fracPart.length > 2) {
      return {
        importe: `${intPart}.${fracPart.slice(0, 2)}`,
        quantity: fracPart.slice(2),
      };
    } else {
      return {
        importe: `${intPart}.${fracPart}`,
        quantity: "1",
      };
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Update current Sucursal if the line matches.
    const sucMatch = line.match(sucursalRegex);
    if (sucMatch) {
      currentSucursalID = sucMatch[1];
      currentSucursalName = sucMatch[2];
      continue;
    }

    // Look for an EAN line.
    const eanMatch = line.match(eanRegex);
    if (eanMatch) {
      const ean = eanMatch[1];
      const numBlock = eanMatch[2];
      const { importe, quantity } = parseImporteAndQuantity(numBlock);
      let numPersona = "";
      // If the next line contains "Num. Persona Vtas:", capture its value.
      if (
        i + 1 < lines.length &&
        lines[i + 1].startsWith("Num. Persona Vtas:")
      ) {
        const personaMatch = lines[i + 1].match(/Num\. Persona Vtas:\s*(\S+)/);
        if (personaMatch) {
          numPersona = personaMatch[1];
        }
        i++; // Skip the persona line.
      }
      rows.push({
        SucursalID: currentSucursalID,
        SucursalName: currentSucursalName,
        EAN: ean,
        CantidadVendida: quantity,
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
 * Converts the row objects into a CSV string.
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
  const csvLines = rows.map((row) =>
    [
      row.SucursalID,
      `"${row.SucursalName}"`,
      row.EAN,
      row.CantidadVendida,
      row.Importe,
      row.NumPersonaVtas,
    ].join(",")
  );
  return `${header}\n${csvLines.join("\n")}`;
}
