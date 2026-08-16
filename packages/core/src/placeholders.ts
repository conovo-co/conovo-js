import type { FieldType } from "./fields.js";

/**
 * Blank-detection for uploaded contracts.
 *
 * People import two very different documents: a contract they already filled
 * in for a real client, and a blank template still carrying its fill-in
 * markers. Text lifted from the first is a usable value; text lifted from the
 * second is a BLANK, and treating it as a value silently prints "[STATE]" into
 * a real agreement.
 *
 * Deliberately conservative — anything not clearly a marker is treated as a
 * real value, because wrongly discarding a customer's actual standing term is
 * worse than leaving one placeholder for them to notice and fix.
 */

/** Bracketed markers: [State], {{client_name}}, <<DATE>>, ‹name›. */
const BRACKETED = /^[[{<‹（(]{1,2}\s*[^\]}>›）)]*\s*[\]}>›）)]{1,2}$/u;

/** Rules of underscores, dots, or dashes used as a signature/fill line. */
const RULE = /^[_.\-–—\s]{3,}$/u;

/** Bare markers people type into templates. */
const WORD_MARKERS = new Set([
  "tbd",
  "t.b.d.",
  "tba",
  "n/a",
  "na",
  "none",
  "xxx",
  "xxxx",
  "xxxxx",
  "insert",
  "fill in",
  "fill-in",
  "your name here",
  "name here",
  "date",
  "client name",
  "company name",
]);

/**
 * True when this snippet is a fill-in marker rather than a value. Used to keep
 * placeholders out of standing terms (they'd be saved as the business's real
 * answer) and to surface blanks the setup pass didn't turn into fields.
 */
export function isPlaceholderText(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (RULE.test(s)) return true;
  if (BRACKETED.test(s)) return true;
  // A repeated single character used as a blank: "XXXXXX", "______".
  if (s.length >= 3 && /^(.)\1+$/u.test(s)) return true;
  if (WORD_MARKERS.has(s.toLowerCase())) return true;
  // A marker wearing formatting: "$[RATE]", "([STATE])", "[X]%". If removing
  // the bracketed part leaves nothing but symbols, the snippet IS the marker —
  // "$[RATE]" pre-filled as a money value renders as an error on every import.
  // Words outside the brackets ("fee of [amount] dollars") stay a value, per
  // the conservative rule above.
  const stripped = s.replace(INLINE_MARKER, "");
  if (stripped !== s && !/[\p{L}\p{N}]/u.test(stripped)) return true;
  return false;
}

export interface FoundPlaceholder {
  /** The marker exactly as it appears, e.g. "[STATE]". */
  text: string;
  paragraphIndex: number;
  /** Character offset of the marker within the paragraph. */
  start: number;
  end: number;
}

/** Bracketed runs anywhere INSIDE a paragraph, e.g. "formed in [STATE] with". */
const INLINE_MARKER = /\[[^\][\n]{1,120}\]|\{\{[^}\n]{1,120}\}\}|<<[^>\n]{1,120}>>/gu;

/**
 * Every fill-in marker in a document, in reading order. Feeds the "blanks we
 * didn't turn into fields" report — a template's brackets are the author's own
 * list of what varies, so anything we failed to map is a real gap.
 */
export function findPlaceholders(
  paragraphs: { index: number; text: string }[],
): FoundPlaceholder[] {
  const out: FoundPlaceholder[] = [];
  for (const p of paragraphs) {
    for (const m of p.text.matchAll(INLINE_MARKER)) {
      if (m.index === undefined) continue;
      out.push({
        text: m[0],
        paragraphIndex: p.index,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return out;
}

/**
 * Markers that no confirmed field covers. `covered` is the set of spans the
 * proposals already claim, as {paragraphIndex, start, end}. Overlap — not
 * exact equality — counts as covered, since a field's span and the marker
 * rarely line up character-for-character.
 */
export function unmappedPlaceholders(
  paragraphs: { index: number; text: string }[],
  covered: { paragraphIndex: number; start: number; end: number }[],
): FoundPlaceholder[] {
  const byPara = new Map<number, { start: number; end: number }[]>();
  for (const c of covered) {
    const list = byPara.get(c.paragraphIndex) ?? [];
    list.push(c);
    byPara.set(c.paragraphIndex, list);
  }
  return findPlaceholders(paragraphs).filter((ph) => {
    const spans = byPara.get(ph.paragraphIndex) ?? [];
    return !spans.some((s) => s.start < ph.end && ph.start < s.end);
  });
}

/**
 * Turn a marker into a field the user can confirm.
 *
 * A blank the setup pass missed is only actionable if it can become a field in
 * one click — otherwise the "blanks we didn't map" report just names a problem
 * and leaves you to hand-build the field yourself. The guesses here are
 * deliberately shallow: the user confirms type and source on the card
 * afterwards (invariant 1), so being roughly right beats being clever.
 */

/** Strip the brackets and any trailing fill rule: "[Amount: ___ ]" → "Amount". */
export function placeholderLabel(marker: string): string {
  return marker
    .replace(/^[[{<]{1,2}\s*/u, "")
    .replace(/\s*[\]}>]{1,2}$/u, "")
    .replace(/[:\-–—]?\s*_{2,}\s*$/u, "")
    .trim();
}

/** A stable snake_case key from a label, unique against `taken`. */
export function keyFromLabel(label: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .split("_")
      .filter(Boolean)
      .slice(0, 5)
      .join("_") || "blank";
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** A stable snake_case key from a marker, unique against `taken`. */
export function placeholderKey(marker: string, taken: Iterable<string> = []): string {
  return keyFromLabel(placeholderLabel(marker), taken);
}

/**
 * Name a marker from where it SITS instead of what it says.
 *
 * "[AMOUNT]" tells you nothing; the "Design fee" row it lives in tells you
 * everything — and three [RATE] markers in three rows are three different
 * fields whose names are the rows'. Two context sources, both cheap and hard
 * to misread:
 *
 * 1. Table row: the first cell of the marker's row is the row's own label
 *    ("Design fee", "Hourly — principal"). The marker's word is appended
 *    unless the row label already says it ("Design fee" + amount →
 *    "Design fee amount").
 * 2. Colon lead-in: "Late fee: [AMOUNT]" → "Late fee".
 *
 * Returns null when neither applies — the caller falls back to the marker's
 * own text, exactly as before. Conservative on purpose: a wrong-but-plausible
 * name is worse than an ugly one, because nothing downstream questions it.
 */
export function contextLabel(
  marker: FoundPlaceholder,
  paragraphs: { index: number; text: string }[],
  tables?: {
    startIndex: number;
    rows: ({ paragraphs: number[] } | number[])[][];
  }[],
): string | null {
  const cellParagraphs = (c: { paragraphs: number[] } | number[]) =>
    Array.isArray(c) ? c : Array.isArray(c.paragraphs) ? c.paragraphs : [];
  const textOf = (i: number) => paragraphs.find((p) => p.index === i)?.text ?? "";

  // The marker's own word, for "Design fee" + "amount" → "Design fee amount".
  const word = placeholderLabel(marker.text).toLowerCase();

  for (const t of tables ?? []) {
    for (const row of t.rows) {
      const holds = row.some((c) => cellParagraphs(c).includes(marker.paragraphIndex));
      if (!holds) continue;
      const first = row[0];
      if (!first) return null;
      const firstParas = cellParagraphs(first);
      // The marker sitting in the row's FIRST cell has no label to its left.
      if (firstParas.includes(marker.paragraphIndex)) return null;
      const rowLabel = firstParas.map(textOf).join(" ").trim();
      if (!rowLabel || rowLabel.length > 60 || isPlaceholderText(rowLabel)) return null;
      if (!word || rowLabel.toLowerCase().includes(word)) return rowLabel;
      return `${rowLabel} ${word}`;
    }
  }

  // "Late fee: [AMOUNT]" — the words before the colon are the author's label.
  const before = textOf(marker.paragraphIndex).slice(0, marker.start);
  const lead = /([\p{L}][\p{L}\p{N} /()'&—-]{1,40}):\s*$/u.exec(before)?.[1]?.trim();
  if (lead && !isPlaceholderText(lead)) return lead;

  return null;
}

/**
 * A first guess at the field type from the marker's own words. Only patterns
 * that are hard to misread are matched; everything else falls to text, and a
 * marker long enough to be a drafting instruction ("[List each room / area]")
 * becomes long_text because that's what the author is asking for.
 */
export function placeholderFieldType(marker: string): FieldType {
  const s = placeholderLabel(marker).toLowerCase();
  if (/\$|\bamount\b|\bfee\b|\bprice\b|\bcost\b|\bdeposit\b|\brate\b/u.test(s)) return "money";
  if (/\bdate\b|\bday of\b/u.test(s)) return "date";
  if (/\b(days?|months?|years?|weeks?)\b/u.test(s)) return "duration";
  if (/\bstate\b|\bcounty\b|\baddress\b/u.test(s)) return "address";
  if (/\bname\b/u.test(s)) return "name";
  // A list, a slash-separated choice, or a long phrase is prose to write.
  if (s.length > 40 || /\blist\b|,/u.test(s)) return "long_text";
  return "text";
}

export interface Excerpt {
  paragraphIndex: number;
  /** Text just before the field's spot, elided at the front if trimmed. */
  before: string;
  /** The document's own text at that spot — the marker, or the old value. */
  match: string;
  /** Text just after, elided at the end if trimmed. */
  after: string;
}

/**
 * A window of the contract around one field, for answering "where does this
 * go?" without opening the document.
 *
 * A label alone ("Arbitration body") often isn't enough to know what to type;
 * the sentence it sits in usually is. Elision marks are added only when text
 * was actually cut, so a short paragraph reads as itself rather than as a
 * fragment.
 */
export function excerptAround(
  paragraphs: { index: number; text: string }[],
  span: { paragraphIndex: number; snippet: string },
  radius = 90,
): Excerpt | null {
  const text = paragraphs.find((p) => p.index === span.paragraphIndex)?.text;
  if (!text || !span.snippet) return null;
  const at = text.indexOf(span.snippet);
  if (at < 0) return null;
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + span.snippet.length + radius);
  return {
    paragraphIndex: span.paragraphIndex,
    before: (from > 0 ? "…" : "") + text.slice(from, at),
    match: span.snippet,
    after: text.slice(at + span.snippet.length, to) + (to < text.length ? "…" : ""),
  };
}
