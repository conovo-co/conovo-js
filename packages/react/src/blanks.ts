import {
  contextLabel,
  keyFromLabel,
  placeholderFieldType,
  placeholderLabel,
  unmappedPlaceholders,
  type FieldSource,
  type FieldType,
  type ParsedTable,
} from "@conovo/core";

/**
 * Fill-in markers, and turning the ones nothing covers into fields.
 *
 * A bracketed marker is the document's author saying "something goes here".
 * Left alone it prints verbatim — "[AMOUNT]" in a signed agreement — so the
 * default has to be a field the user can switch OFF, not a report asking them
 * to add twenty-nine by hand. Nothing is saved until they confirm either way
 * (invariant 1).
 *
 * Pure so it can be unit-tested; the component only renders what comes back.
 */

export interface Occurrence {
  paragraphIndex: number;
  snippet: string;
}

export interface Claimable {
  accepted: boolean;
  key: string;
  occurrences: Occurrence[];
}

export interface Span {
  paragraphIndex: number;
  start: number;
  end: number;
}

export interface SynthesizedField {
  accepted: boolean;
  key: string;
  label: string;
  type: FieldType;
  source: FieldSource;
  confidence: number;
  rationale: string;
  occurrences: Occurrence[];
}

/**
 * Where an item's occurrence sits in its paragraph. Occurrences carry a
 * snippet rather than an offset, so the snippet is located by search; one that
 * no longer matches its paragraph is skipped rather than guessed at.
 */
export function claimedSpans(
  paragraphs: { index: number; text: string }[],
  groups: Claimable[][],
  onlyAccepted: boolean,
): Span[] {
  const byIndex = new Map(paragraphs.map((p) => [p.index, p.text]));
  const out: Span[] = [];
  for (const items of groups)
    for (const it of items) {
      if (onlyAccepted && !it.accepted) continue;
      for (const o of it.occurrences) {
        const text = byIndex.get(o.paragraphIndex) ?? "";
        const start = o.snippet ? text.indexOf(o.snippet) : -1;
        if (start >= 0)
          out.push({
            paragraphIndex: o.paragraphIndex,
            start,
            end: start + o.snippet.length,
          });
      }
    }
  return out;
}

/**
 * A field for every marker no proposal touched.
 *
 * Coverage here counts proposals whether or not they're accepted: a
 * low-confidence proposal already owns its marker, and synthesizing a second
 * field beside it would leave the user reconciling duplicates. Those markers
 * instead show up in the blanks panel, where the fix is switching the existing
 * field back on.
 */
export function fieldsForUnmappedBlanks(
  paragraphs: { index: number; text: string }[],
  existing: Claimable[],
  others: Claimable[][],
  tables?: ParsedTable[],
): SynthesizedField[] {
  if (paragraphs.length === 0) return [];
  const covered = claimedSpans(paragraphs, [existing, ...others], false);
  const taken = new Set(existing.map((f) => f.key));
  const made: SynthesizedField[] = [];
  for (const b of unmappedPlaceholders(paragraphs, covered)) {
    // Named from where it sits when the context allows — "[AMOUNT]" in the
    // "Design fee" row is "Design fee amount", and three [RATE] markers in
    // three rows become three distinctly named fields instead of a name
    // collision. Key follows the label, so the vocabulary pass and standing
    // values key on the meaningful name too.
    const label = contextLabel(b, paragraphs, tables) ?? placeholderLabel(b.text) ?? b.text;
    const key = keyFromLabel(label, taken);
    taken.add(key);
    made.push({
      accepted: true,
      key,
      label: label || b.text,
      type: placeholderFieldType(b.text),
      // per_deal is the safe default: worst case they're asked each time,
      // whereas a wrong binding or standing value fills in silently.
      source: "per_deal",
      confidence: 1,
      rationale: `Your document has ${b.text} here and nothing else filled it, so this asks you for it. Uncheck it if that text is part of the wording.`,
      occurrences: [{ paragraphIndex: b.paragraphIndex, snippet: b.text }],
    });
  }
  return made;
}

/**
 * The field whose occurrence overlaps this marker — the card to send someone
 * to when a blank is showing because its field is switched off.
 *
 * Overlap, not equality: an extraction snippet is usually the surrounding
 * phrase ("Freight includes [delivery to the receiving warehouse].") rather
 * than the marker alone, so exact matching finds nothing.
 */
export function fieldOwningBlank<T extends Claimable>(
  paragraphs: { index: number; text: string }[],
  fields: T[],
  blank: { paragraphIndex: number; start: number; end: number },
): T | undefined {
  const text = paragraphs.find((p) => p.index === blank.paragraphIndex)?.text ?? "";
  return fields.find((f) =>
    f.occurrences.some((o) => {
      if (o.paragraphIndex !== blank.paragraphIndex || !o.snippet) return false;
      const start = text.indexOf(o.snippet);
      if (start < 0) return false;
      return start < blank.end && blank.start < start + o.snippet.length;
    }),
  );
}
