/**
 * Signature-anchor detection (SPEC §3.4.7): find each signing party's
 * signature line in the document text. Pure and deterministic — this feeds
 * sign-here field placement at dispatch, so it follows the send-path rule:
 * heuristics in code, no model anywhere, and failure means "no anchor",
 * never an error.
 */

export interface SignatureParty {
  /** Party field key — recipients carry it as their `role`. */
  key: string;
  label: string;
  isSender: boolean;
}

export interface SignatureAnchor {
  partyKey: string;
  paragraphIndex: number;
  /** The line's text as parsed — the PDF locator searches for this. */
  text: string;
}

/** Where the execution block starts, else the tail of the document. */
const ZONE_START =
  /\bIN WITNESS WHEREOF\b|\bhave (?:caused this|executed this)\b|^SIGNATURES?\b|^EXECUTION\b/i;

/** A line a signature actually lands on. */
const SIGNATURE_LINE = /^by[:\s]|_{3,}|^signature\b/i;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The word a document actually uses for this party.
 *
 * Confirmed labels are descriptive — "Owner (the storage facility business)",
 * "Occupant (the renter)" — because they're written for the person setting
 * the template up. The document writes the bare role: "OWNER:". Matching the
 * whole label against the header therefore never hits, so match on the role
 * token instead: parentheticals dropped, leading words kept. The key
 * ("owner") is the second candidate, since keys are derived from the same
 * role word.
 */
function roleTokens(party: SignatureParty): string[] {
  const label = normalize(party.label.replace(/\([^)]*\)/g, " "));
  const tokens = new Set<string>();
  if (label) {
    tokens.add(label);
    // "design services provider" also answers to "design".
    const first = label.split(" ")[0];
    if (first && first.length > 2) tokens.add(first);
  }
  const key = normalize(party.key.replace(/_/g, " "));
  if (key.length > 2) tokens.add(key);
  return [...tokens];
}

/**
 * Find each party's signature line.
 *
 * Strategy, in order of confidence:
 *  1. Locate the execution zone (witness clause onward; else the last ~15%).
 *  2. A party whose LABEL appears in a zone paragraph owns the first
 *     signature-looking line within the next few paragraphs (contracts write
 *     "OCCUPANT:" then "By: ______").
 *  3. Any parties still unmatched are assigned the remaining signature lines
 *     in document order — but only when the counts line up exactly, because
 *     a guessed mismatch would put a tenant's sign-here on the landlord's
 *     line, and no fields is strictly better than wrong fields.
 */
export function findSignatureAnchors(
  paragraphs: { index: number; text: string }[],
  parties: SignatureParty[],
): SignatureAnchor[] {
  if (paragraphs.length === 0 || parties.length === 0) return [];

  let zoneAt = -1;
  for (const p of paragraphs) if (ZONE_START.test(p.text.trim())) zoneAt = p.index;
  if (zoneAt < 0) {
    const tail = paragraphs[Math.floor(paragraphs.length * 0.85)];
    zoneAt = tail ? tail.index : 0;
  }
  const zone = paragraphs.filter((p) => p.index >= zoneAt && p.text.trim() !== "");

  const signatureLines = zone.filter((p) => SIGNATURE_LINE.test(p.text.trim()));
  const claimed = new Set<number>();
  const anchors: SignatureAnchor[] = [];
  const unmatched: SignatureParty[] = [];

  for (const party of parties) {
    const tokens = roleTokens(party);
    // The header paragraph naming this party ("OCCUPANT:", "The Client").
    const header = zone.find((p) => {
      const text = normalize(p.text);
      return tokens.some((t) => text.includes(t));
    });
    let line: { index: number; text: string } | undefined;
    if (header) {
      line = signatureLines.find(
        (p) =>
          !claimed.has(p.index) &&
          p.index >= header.index &&
          p.index - header.index <= 8,
      );
      // "OCCUPANT: ________" — header and line are the same paragraph.
      if (!line && SIGNATURE_LINE.test(header.text.trim()) && !claimed.has(header.index))
        line = header;
    }
    if (line) {
      claimed.add(line.index);
      anchors.push({ partyKey: party.key, paragraphIndex: line.index, text: line.text });
    } else {
      unmatched.push(party);
    }
  }

  // Positional fallback: only when what's left maps one-to-one.
  const leftoverLines = signatureLines.filter((p) => !claimed.has(p.index));
  if (unmatched.length > 0 && unmatched.length === leftoverLines.length) {
    unmatched.forEach((party, i) => {
      const line = leftoverLines[i]!;
      anchors.push({ partyKey: party.key, paragraphIndex: line.index, text: line.text });
    });
  }

  return anchors.sort((a, b) => a.paragraphIndex - b.paragraphIndex);
}
