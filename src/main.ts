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
 * This replicates the logic used in the manual extraction:
 * 1) Detect lines that define the Sucursal ID and Name (e.g. "Sucursal   8422416200034         ( ECI GOYA 0003 )...")
 * 2) Detect lines that start with a 13-digit EAN followed by "Importe, CantidadVendida" in one numeric block
 *    (e.g., "8437021807011 119,763" => EAN="8437021807011", Importe="119.76", CantidadVendida="3").
 * 3) If the next line starts with "Num. Persona Vtas:", that belongs to the same EAN entry.
 */
function parseSalesReport(rawText: string) {
  // Split PDF text into lines, trim, and drop empty lines
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

  // Helper: parse out "Importe" (e.g., 119.76) vs. "CantidadVendida" (e.g., 3) from "119,763"
  function parseImporteAndQuantity(value: string) {
    // remove possible thousand-separating dots, if any
    const cleaned = value.replace(/\./g, "");
    const parts = cleaned.split(",");
    if (parts.length !== 2) {
      // fallback if it doesn't match the expected pattern
      return { importe: value, quantity: "1" };
    }
    const [integerPart, decimalPlusQty] = parts;
    // If more than 2 digits after the comma, the extras are the quantity
    if (decimalPlusQty.length > 2) {
      const decimalDigits = decimalPlusQty.slice(0, 2);
      const qtyDigits = decimalPlusQty.slice(2);
      return {
        importe: `${integerPart}.${decimalDigits}`,
        quantity: qtyDigits,
      };
    } else {
      // e.g. "49,91" => importe=49.91, quantity=1
      return {
        importe: `${integerPart}.${decimalPlusQty}`,
        quantity: "1",
      };
    }
  }

  // Walk each line, detecting either a "Sucursal" or an "EAN" line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) Detect Sucursal lines, e.g.:
    //    "Sucursal   8422416200034         ( ECI GOYA 0003 ) 263 09/03/2025   -  09/03/2025"
    const sucursalMatch = line.match(/^Sucursal\s+(\d+)\s+\(\s*(.*?)\s*\)/);
    if (sucursalMatch) {
      currentSucursalID = sucursalMatch[1];
      currentSucursalName = sucursalMatch[2];
      continue;
    }

    // 2) Detect lines that begin with 13-digit EAN, e.g. "8437021807011 119,763"
    const eanMatch = line.match(/^(\d{13})\s+([\d.,]+)/);
    if (eanMatch) {
      const ean = eanMatch[1];
      const combinedNumber = eanMatch[2];
      const { importe, quantity } = parseImporteAndQuantity(combinedNumber);

      // Check if next line starts with "Num. Persona Vtas:"
      let numPersona = "";
      if (
        i + 1 < lines.length &&
        lines[i + 1].startsWith("Num. Persona Vtas:")
      ) {
        const nextLine = lines[++i]; // consume it
        const personaMatch = nextLine.match(/Num\. Persona Vtas:\s*(\S+)/);
        if (personaMatch) {
          numPersona = personaMatch[1];
        }
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
      `"${r.SucursalID}"`,
      `"${r.SucursalName}"`,
      `"${r.EAN}"`,
      `"${r.CantidadVendida}"`,
      `"${r.Importe}"`,
      `"${r.NumPersonaVtas}"`,
    ].join(",");
  });
  return header + "\n" + lines.join("\n");
}
