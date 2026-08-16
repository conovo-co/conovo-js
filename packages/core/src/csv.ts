/**
 * RFC 4180 CSV parsing — pure and dependency-free, like everything in core.
 * Handles quoted fields (embedded commas, quotes doubled as "", newlines
 * inside quotes), CRLF/LF, and a UTF-8 BOM. Deliberately NOT configurable:
 * comma-separated, double-quoted is the one dialect we accept; anything else
 * should fail loudly at upload, not resolve wrongly at send (invariant 6).
 */

export interface ParsedCsv {
  /** First row, trimmed — the column names the mapping UX works with. */
  headers: string[];
  /** Data rows, each padded/truncated to headers.length. */
  rows: string[][];
}

export class CsvError extends Error {
  constructor(
    message: string,
    /** 1-based line for user-facing messages. */
    public readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
  }
}

export function parseCsv(text: string): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // Skip fully blank records (trailing newline, stray empty lines).
    if (record.length > 1 || record[0]?.trim() !== "") records.push(record);
    record = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field !== "")
        throw new CsvError('unexpected quote in the middle of a field', line);
      inQuotes = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n") {
      endRecord();
      line++;
    } else if (c === "\r") {
      if (src[i + 1] === "\n") continue; // CRLF — the \n handles it
      endRecord();
      line++;
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new CsvError("unterminated quoted field", line);
  if (field !== "" || record.length > 0) endRecord();

  const [headerRow, ...dataRows] = records;
  if (!headerRow || headerRow.every((h) => h.trim() === ""))
    throw new CsvError("no header row", 1);

  const headers = headerRow.map((h) => h.trim());
  const rows = dataRows.map((r) => {
    const padded = r.slice(0, headers.length);
    while (padded.length < headers.length) padded.push("");
    return padded;
  });
  return { headers, rows };
}
