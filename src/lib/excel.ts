/** Convert Excel workbooks to CSV text for the same import path as .csv files. */

function sheetSectionBanner(sheetName: string) {
  const name = sheetName.trim().toLowerCase();
  if (/click/.test(name)) return "CLICKERS — Opened & Clicked a Link";
  if (/open/.test(name)) return "OPENS ONLY — Opened Email, No Click";
  if (/sent|deliver/.test(name)) return "SENT — All Emails Delivered";
  return "";
}

export function isExcelFile(name: string, type = "") {
  const lower = name.toLowerCase();
  return (
    /\.xlsx?$/i.test(lower) ||
    /\.xlsm$/i.test(lower) ||
    type.includes("spreadsheetml") ||
    type.includes("ms-excel") ||
    type === "application/vnd.ms-excel"
  );
}

export async function excelBufferToCsvText(bytes: Uint8Array, fileName = "workbook.xlsx") {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  if (!workbook.SheetNames.length) {
    throw new Error(`Excel file "${fileName}" has no sheets.`);
  }

  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (!csv.trim()) continue;
    const banner = sheetSectionBanner(sheetName);
    if (banner && workbook.SheetNames.length > 1) {
      parts.push(banner);
    }
    parts.push(csv);
  }

  if (!parts.length) {
    throw new Error(`Excel file "${fileName}" had no readable rows.`);
  }
  return parts.join("\n");
}
