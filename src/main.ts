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

  // (1) Convert file to ArrayBuffer
  const buffer = await (file as any).arrayBuffer();

  // (2) Extract text using unpdf
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: true });

  // unify text
  const rawText = Array.isArray(result.text)
    ? result.text.join("\n")
    : result.text;

  // **** DEBUG: Log the entire raw text in the console (Workers KV logs) to see if it's as expected ****
  console.log("=== PDF EXTRACTED TEXT START ===\n", rawText, "\n=== PDF EXTRACTED TEXT END ===");

  // (3) Parse raw text into structured rows
  const rows = parseSalesReport(rawText);

  // **** DEBUG: If no rows, also log the line-by-line view so you can see exactly how it was split ****
  if (!rows.length) {
    console.log("No rows were parsed. Let's see line-by-line...");
    rawText.split(/\r?\n/).forEach((line, idx) => {
      console.log(`${idx + 1}:`, line);
    });
  }

  // (4) Convert rows to CSV
  const csvString = buildCSV(rows);

  // (5) Store CSV in R2 bucket
  const key = crypto.randomUUID() + ".csv";
  await c.env.BUCKET.put(key, new TextEncoder().encode(csvString), {
    httpMetadata: { contentType: "text/csv" },
  });

  // (6) Return a link to download the CSV
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
 * *IMPORTANT:* This logic expects lines like:
 *    Sucursal   8422416200034  ( ECI GOYA 0003 ) ...
 *    8437021807011 49,91
 *    Num. Persona Vtas:  0051258002
 *
 * If your extracted text is different (e.g. broken across lines, missing parentheses, etc.),
 * you'll need to adjust the regex or line handling accordingly.
 */
function parseSalesReport(rawText: string) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
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

  // Regex to match a line with "Sucursal <13digits> ( <text> )"
  // e.g.: "Sucursal   8422416200034         ( ECI GOYA 0003 ) 263 09/03/2025"
  const sucursalRegex = /^Sucursal\s+(\d{13})\s*\(\s*([^)]*)\s*\)/i;

  // Regex to match a line that starts with 13 digits (the EAN), then a numeric block
  // e.g.: "8437021807011 119,763"
  const eanRegex = /^(\d{13})\s+([\d.,]+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // (A) Check if it's a Sucursal line
    const sm = line.match(sucursalRegex);
    if (sm) {
      currentSucursalID = sm[1];
      currentSucursalName = sm[2];
      continue;
    }

    // (B) Check if it's an EAN line
    const em = line.match(eanRegex);
    if (em) {
      const ean = em[1];
      const combined = em[2]; // e.g. "49,91" or "119,763"
      const { importe, quantity } = parseImporteAndQuantity(combined);

      // If next line is "Num. Persona Vtas:"
      let persona = "";
      if (i + 1 < lines.length && lines[i + 1].includes("Num. Persona Vtas:")) {
        const pm = lines[i + 1].match(/Num\. Persona Vtas:\s*(\S+)/);
        if (pm) {
          persona = pm[1];
        }
        i++; // consume that line
      }

      rows.push({
        SucursalID: currentSucursalID,
        SucursalName: currentSucursalName,
        EAN: ean,
        CantidadVendida: quantity,
        Importe: importe,
        NumPersonaVtas: persona,
      });
    }
  }

  return rows;
}

/**
 * parseImporteAndQuantity("119,763") => { importe: "119.76", quantity: "3" }
 * parseImporteAndQuantity("49,91") => { importe: "49.91", quantity: "1" }
 */
function parseImporteAndQuantity(value: string) {
  // remove thousand separators if any
  const cleaned = value.replace(/\./g, "");
  const [intPart, rest] = cleaned.split(",");
  if (!intPart || !rest) return { importe: cleaned, quantity: "1" };
  if (rest.length > 2) {
    // e.g. "76" + "3" => => "76" => quantity=3
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
 * buildCSV
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
