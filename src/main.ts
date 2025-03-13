// We'll define the CSV column headers
const CSV_HEADERS = [
  "SucursalID",
  "SucursalName",
  "EAN",
  "CantidadVendida",
  "Importe",
  "NumPersonaVtas",
];

/**
 * parseSalesReport(rawText)
 *
 * This version replicates the logic where we:
 * 1) Identify lines that define the Sucursal ID & Sucursal Name (both on one line).
 *    Example line:
 *    Sucursal   8422416200034         ( ECI GOYA 0003 ) 263 09/03/2025   -  09/03/2025
 *
 * 2) Identify lines that start with a 13-digit EAN, followed by a numeric string
 *    that includes a comma, e.g. "8437021807011 119,763".
 *    - We parse out the EAN (13 digits).
 *    - We parse out the Importe (e.g. 119.76).
 *    - We parse out the CantidadVendida (e.g. 3).
 *    - If the next line starts with "Num. Persona Vtas:", we grab that code.
 *
 * 3) Return array of objects with the columns:
 *    { SucursalID, SucursalName, EAN, CantidadVendida, Importe, NumPersonaVtas }
 */
function parseSalesReport(rawText: string) {
  // Split and trim lines, discard empty lines
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l);

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

  // Helper function to parse something like "49,91" => { importe: "49.91", quantity: "1" }
  // or "119,763" => { importe: "119.76", quantity: "3" },
  // or "423,1411" => { importe: "423.14", quantity: "11" }
  function parseImporteAndQuantity(value: string) {
    // Remove any thousand separators (dots), if present
    const cleaned = value.replace(/\./g, "");
    // We expect at least a "X,XX" part for the decimal portion. Anything after that is the quantity.
    const parts = cleaned.split(",");
    if (parts.length !== 2) {
      // Fallback if we can’t split properly. This generally shouldn't happen given the PDF format.
      return { importe: value, quantity: "1" };
    }

    const [integerPart, decimalPlusQty] = parts;
    // If there are more than 2 digits after the comma, the extras are the quantity.
    if (decimalPlusQty.length > 2) {
      // example: "76" + "3" => 76. -> 3, or "14" + "11" => 14. -> 11
      const decimalDigits = decimalPlusQty.slice(0, 2);
      const qtyDigits = decimalPlusQty.slice(2);
      return {
        importe: `${integerPart}.${decimalDigits}`, // e.g. "119.76"
        quantity: qtyDigits, // e.g. "3"
      };
    } else {
      // e.g. "49,91" => 49.91 => quantity=1
      return {
        importe: `${integerPart}.${decimalPlusQty}`,
        quantity: "1",
      };
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) Detect Sucursal line:
    //    e.g.: "Sucursal   8422416200034         ( ECI GOYA 0003 ) 263 09/03/2025 - 09/03/2025"
    // We'll capture the 8422416200034 as group1, the name ECI GOYA 0003 as group2.
    const sucursalMatch = line.match(
      /^Sucursal\s+(\d+)\s+\(\s*(.*?)\s*\)\s+/
    );
    if (sucursalMatch) {
      currentSucursalID = sucursalMatch[1];
      currentSucursalName = sucursalMatch[2];
      continue;
    }

    // 2) Detect lines that begin with a 13-digit EAN followed by the numeric part
    //    e.g. "8437021807011 119,763"
    const eanMatch = line.match(/^(\d{13})\s+([\d.,]+)/);
    if (eanMatch) {
      const ean = eanMatch[1];
      const combinedNumber = eanMatch[2]; // e.g. "119,763"

      // Extract Importe & CantidadVendida
      const { importe, quantity } = parseImporteAndQuantity(combinedNumber);

      // Next line might be "Num. Persona Vtas:  0051258002"
      let numPersona = "";
      if (
        i + 1 < lines.length &&
        lines[i + 1].startsWith("Num. Persona Vtas:")
      ) {
        const personaLine = lines[i + 1];
        const pm = personaLine.match(/Num\. Persona Vtas:\s*(\S+)/);
        if (pm) {
          numPersona = pm[1];
        }
        i++; // Skip that line in the loop
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
 * Takes the array of row objects and converts them into a CSV string.
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

// Exported for convenience in your original code
export { parseSalesReport, buildCSV, CSV_HEADERS };
