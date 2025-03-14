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
  const filePath = `/file/${key}`; // Corrected line
  return c.html(
    `<p>CSV generated! <a href="${filePath}">Download here</a>.</p>`
  );
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
    "Content-Disposition": `attachment; filename="${key}"`, // Corrected line
    "Cache-Control": "public, max-age=86400",
  });
});

export default app;

/**
 * parseSalesReport(rawText)
 *
 * Based on the sample text you provided (with lines like "EAN" on one line,
 * then the actual code on the next, etc.). We'll read line by line and capture:
 *
 * - Sucursal lines:
 *      "Sucursal"
 *      [Sucursal ID]
 *      [( ECI NAME )]
 *
 * - EAN block:
 *      "EAN"
 *      [ean code, e.g. 8437021807011]
 *      [Importe, e.g. 49,9]
 *      [CantidadVendida, e.g. 1]
 *      optional line: "Num. Persona Vtas:  XXXXX"
 *
 * If your text has empty lines, we skip them carefully with readNextNonEmptyLine.
 */
function parseSalesReport(rawText: string) {
  const allLines = rawText.split(/\r?\n/);
  const lines = allLines.map((l) => l.trim());
  let i = 0;
  const rows: Array<{
    SucursalID: string;
    SucursalName: string;
    EAN: string;
    CantidadVendida: string;
    Importe: string;
    NumPersonaVtas: string;
  }> =;

  function readNextNonEmptyLine(): string | null {
    while (i < lines.length) {
      const line = lines[i];
      i++;
      if (line) return line;
    }
    return null;
  }

  while (i < lines.length) {
    let line = lines[i];
    i++;

    if (!line) continue;

    if (line.startsWith("Sucursal")) {
      const sucursalID = readNextNonEmptyLine() || "";
      let sucursalName = readNextNonEmptyLine() || "";

      // Extract SucursalName from Pto Venta lines
      if (sucursalName.startsWith("Pto Venta")) {
        sucursalName = lines[i++] || ""; // Get the next line
        sucursalName = sucursalName.replace(/^\(|\)$/g, "").trim();
      }

      let ean: string | null = null;
      let cantidadVendida: string | null = null;
      let importe: string | null = null;
      let numPersonaVtas: string | null = null;

      // Check for EAN table
      if (lines[i] && (lines[i].includes("EAN") || lines[i].includes("Ref. ECI"))) {
        i++; // Skip header line

        while (i < lines.length && lines[i] && !lines[i].startsWith("Cantidad Uds.")) {
          let dataLine = lines[i++];
          if (!dataLine) continue;

          const values = dataLine.split(",").map(v => v.trim());

          if (values && values.length > 0) {
            ean = values[0] || null;
            cantidadVendida = values[2] || null;
            importe = values[7] ? values[7].replace(",", ".") : null; // Normalize decimal

            // Check next line for Num. Persona Vtas
            if (lines[i] && lines[i].startsWith("Num. Persona Vtas:")) {
              numPersonaVtas = lines[i].split(":")[1]?.trim() || null;
              i++;
            }

            if (ean && cantidadVendida && importe) {
              rows.push({
                SucursalID: sucursalID,
                SucursalName: sucursalName,
                EAN: ean,
                CantidadVendida: cantidadVendida,
                Importe: importe,
                NumPersonaVtas: numPersonaVtas || "",
              });
            }
          }
        }
      }
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
      "${r.SucursalID}",
      "${r.SucursalName}",
      "${r.EAN}",
      "${r.CantidadVendida}",
      "${r.Importe}",
      "${r.NumPersonaVtas}",
    ].join(",");
  });
  return header + "\n" + lines.join("\n");
}
