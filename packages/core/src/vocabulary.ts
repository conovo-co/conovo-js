import { z } from "zod/v4";
import type { FieldProposal } from "./proposals.js";
import { fieldSourceSchema, fieldTypeSchema } from "./fields.js";

/**
 * The workspace's established field vocabulary: every key its confirmed
 * templates already use, and whether a standing value exists for it.
 *
 * A fresh import mints its own keys, so the SAME concept gets a NEW key on
 * every contract — and the standing value the business already saved never
 * pre-fills, because standing values are keyed. Matching new proposals onto
 * this vocabulary is what makes the second contract cheaper to set up than
 * the first (SPEC §3.1.4: the wizard drives the auto-fill score UP).
 */
export const vocabularyEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  type: fieldTypeSchema,
  /** The source it was most recently confirmed as. */
  source: fieldSourceSchema,
  /** A standing value is saved for this key — reusing it fills for free. */
  hasStandingValue: z.boolean(),
});
export type VocabularyEntry = z.infer<typeof vocabularyEntrySchema>;

export const vocabularyMatchSchema = z.object({
  /** The freshly proposed field's key. */
  fieldKey: z.string(),
  /** The established vocabulary key it should reuse. */
  useKey: z.string(),
  /** 0–1: probability a careful reviewer agrees these are the same concept. */
  confidence: z.number().min(0).max(1),
  /** One plain-English sentence. */
  rationale: z.string(),
});
export type VocabularyMatch = z.infer<typeof vocabularyMatchSchema>;

export const vocabularyAlignmentSchema = z.object({
  matches: z.array(vocabularyMatchSchema),
});
export type VocabularyAlignment = z.infer<typeof vocabularyAlignmentSchema>;

/** Below this, a match is not applied — a wrong reuse pre-fills a wrong value. */
export const VOCABULARY_APPLY_THRESHOLD = 0.7;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * The deterministic pass: identical keys, or identical normalized labels, on
 * the SAME type. These need no model call — and on a workspace importing its
 * second copy of a similar contract they cover most of the overlap. Types
 * must agree exactly: a money standing value landing in a text field (or
 * vice versa) is a silently wrong contract, which no amount of key similarity
 * justifies.
 *
 * One proposal per vocabulary key: two fields both claiming `payment_terms`
 * would collide the moment the key is rewritten.
 */
export function matchVocabularyExact(
  fields: Pick<FieldProposal, "key" | "label" | "type">[],
  vocabulary: VocabularyEntry[],
): { matches: VocabularyMatch[]; unmatched: typeof fields } {
  const byKey = new Map(vocabulary.map((v) => [v.key, v]));
  const byLabel = new Map<string, VocabularyEntry>();
  for (const v of vocabulary) {
    const n = norm(v.label);
    // An ambiguous label (two vocabulary keys named the same) matches nothing.
    if (byLabel.has(n)) byLabel.set(n, undefined as unknown as VocabularyEntry);
    else byLabel.set(n, v);
  }

  const matches: VocabularyMatch[] = [];
  const unmatched: typeof fields = [];
  const used = new Set<string>();
  for (const f of fields) {
    const candidate = byKey.get(f.key) ?? byLabel.get(norm(f.label));
    if (candidate && candidate.type === f.type && !used.has(candidate.key)) {
      used.add(candidate.key);
      matches.push({
        fieldKey: f.key,
        useKey: candidate.key,
        confidence: 1,
        rationale:
          candidate.key === f.key
            ? "same key as your existing field"
            : `same name as your existing “${candidate.label}”`,
      });
    } else {
      unmatched.push(f);
    }
  }
  return { matches, unmatched };
}

/**
 * Rewrite proposals to reuse matched vocabulary keys.
 *
 * Guards belong here, not in the model: a match is dropped unless the types
 * agree, the target key is free (no other proposal holds it, before or after
 * rewriting), and confidence clears the apply threshold. A field whose reused
 * key has a standing value becomes `workspace_default` — that value pre-fills
 * in the review UI and the field counts as automatic, which is the point.
 * Everything else about the proposal (label, anchors, confidence) is the
 * extraction's own; reuse changes identity, never evidence.
 */
export function applyVocabularyMatches(
  fields: FieldProposal[],
  matches: VocabularyMatch[],
  vocabulary: VocabularyEntry[],
): FieldProposal[] {
  const vocab = new Map(vocabulary.map((v) => [v.key, v]));
  const byFieldKey = new Map<string, VocabularyMatch>();
  for (const m of matches)
    if (m.confidence >= VOCABULARY_APPLY_THRESHOLD) byFieldKey.set(m.fieldKey, m);

  // Keys already in use after this pass: every unrewritten proposal key, plus
  // each rewrite as it is claimed. First claim wins; a second proposal aiming
  // at the same vocabulary key keeps its own.
  const taken = new Set(
    fields.map((f) => (byFieldKey.has(f.key) ? undefined : f.key)).filter(Boolean) as string[],
  );

  return fields.map((f) => {
    const m = byFieldKey.get(f.key);
    const v = m ? vocab.get(m.useKey) : undefined;
    if (!m || !v || v.type !== f.type || taken.has(v.key)) return f;
    taken.add(v.key);
    return {
      ...f,
      key: v.key,
      sourceGuess: v.hasStandingValue ? "workspace_default" : f.sourceGuess,
      rationale: `${f.rationale} ${
        v.hasStandingValue
          ? `Matches your existing “${v.label}” — your saved value fills it.`
          : `Matches “${v.label}” from your other templates.`
      }`.trim(),
    };
  });
}
