/**
 * Sensitive-data policy helpers (deterministic — no AI anywhere near this).
 *
 * Two jobs:
 * 1. `guessSensitive`: classify a FIELD as sensitive from its key/label, so
 *    downstream AI calls (anomaly check, pre-draft) can redact or refuse the
 *    field's VALUE. Over-flagging costs a redacted value in a read-only
 *    check; under-flagging sends a real SSN to a model — so patterns lean
 *    broad on identifiers and narrow on generic words.
 * 2. `maskCellShape` / `scanTextForPii`: shape-preserving masking for sample
 *    cells shown to the mapping model, and a document scan that warns when
 *    an UPLOAD looks like a filled example (real client data) rather than a
 *    blank template.
 */

export type SensitiveKind =
  | "ssn"
  | "ein"
  | "tax_id"
  | "bank"
  | "passport"
  | "license"
  | "dob"
  | "card";

const FIELD_PATTERNS: [SensitiveKind, RegExp][] = [
  ["ssn", /\bssn\b|social[ _-]?security/],
  ["ein", /\bein\b|employer[ _-]?identification/],
  ["tax_id", /\btax[ _-]?id\b|\btin\b|\bitin\b/],
  ["bank", /routing[ _-]?(number|no)|\biban\b|\bswift\b|bank[ _-]?account/],
  ["passport", /passport/],
  ["license", /(driver'?s?|drivers)[ _-]?licen[cs]e|\bdl[ _-]?(number|no)\b/],
  ["dob", /date[ _-]?of[ _-]?birth|\bdob\b|birth[ _-]?date/],
  ["card", /credit[ _-]?card|card[ _-]?number|\bcvv\b|\bcvc\b/],
];

/** Classify a field by key + label. Null = not sensitive. */
export function guessSensitive(key: string, label: string): SensitiveKind | null {
  const haystack = `${key} ${label}`.toLowerCase();
  for (const [kind, re] of FIELD_PATTERNS) if (re.test(haystack)) return kind;
  return null;
}

/**
 * Shape-preserving mask: digits → #, letters → x/X, punctuation and symbols
 * kept. "123-45-6789" → "###-##-####", "sarah.chen@x.co" → "xxxxx.xxxx@x.xx".
 * The mapping model needs the SHAPE of a cell, never its content.
 */
export function maskCellShape(value: string, maxLength = 60): string {
  const masked = value
    .slice(0, maxLength)
    .replace(/[0-9]/g, "#")
    .replace(/[a-z]/g, "x")
    .replace(/[A-Z]/g, "X");
  return value.length > maxLength ? `${masked}…` : masked;
}

export interface PiiScanResult {
  /** SSN-shaped values (###-##-####). */
  ssnLike: number;
  /** EIN-shaped values (##-#######). */
  einLike: number;
  /** 13–16 digit runs that pass Luhn — card-shaped. */
  cardLike: number;
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Deterministic scan for filled-in identifiers. Placeholder markers
 * ("___-__-____", "[SSN]") deliberately do NOT match: a blank template
 * scans clean, a filled example does not — that difference is the warning.
 */
export function scanTextForPii(text: string): PiiScanResult {
  const ssnLike = (text.match(/\b\d{3}-\d{2}-\d{4}\b/g) ?? []).length;
  const einLike = (text.match(/\b\d{2}-\d{7}\b/g) ?? []).length;
  let cardLike = 0;
  for (const m of text.match(/\b(?:\d[ -]?){13,16}\b/g) ?? []) {
    const digits = m.replace(/[^0-9]/g, "");
    if (digits.length >= 13 && digits.length <= 16 && luhnOk(digits)) cardLike += 1;
  }
  return { ssnLike, einLike, cardLike };
}

export function piiScanIsClean(scan: PiiScanResult): boolean {
  return scan.ssnLike === 0 && scan.einLike === 0 && scan.cardLike === 0;
}
