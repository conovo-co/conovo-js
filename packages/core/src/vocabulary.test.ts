import { describe, expect, it } from "vitest";
import {
  applyVocabularyMatches,
  matchVocabularyExact,
  type VocabularyEntry,
} from "./vocabulary.js";
import type { FieldProposal } from "./proposals.js";

const vocab = (over: Partial<VocabularyEntry> = {}): VocabularyEntry => ({
  key: "payment_terms",
  label: "Payment terms",
  type: "duration",
  source: "workspace_default",
  hasStandingValue: true,
  ...over,
});

const field = (over: Partial<FieldProposal> = {}): FieldProposal => ({
  key: "payment_terms_days",
  label: "Payment terms",
  type: "duration",
  sourceGuess: "per_deal",
  confidence: 0.9,
  occurrences: [{ paragraphIndex: 3, snippet: "30 days" }],
  rationale: "Detected as a fill-in.",
  ...over,
});

describe("matchVocabularyExact", () => {
  it("matches an identical key without needing labels to agree", () => {
    const { matches, unmatched } = matchVocabularyExact(
      [field({ key: "payment_terms", label: "Terms of payment" })],
      [vocab()],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ fieldKey: "payment_terms", useKey: "payment_terms", confidence: 1 });
    expect(unmatched).toHaveLength(0);
  });

  it("matches an identical label across different keys, ignoring case and punctuation", () => {
    const { matches } = matchVocabularyExact(
      [field({ key: "terms", label: "Payment Terms." })],
      [vocab()],
    );
    expect(matches[0]).toMatchObject({ fieldKey: "terms", useKey: "payment_terms" });
  });

  it("never matches across types — a money value in a text field is silently wrong", () => {
    const { matches, unmatched } = matchVocabularyExact(
      [field({ type: "money" })],
      [vocab({ type: "duration" })],
    );
    expect(matches).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  it("gives an ambiguous vocabulary label to no one", () => {
    const { matches } = matchVocabularyExact(
      [field({ key: "rate", label: "Hourly rate", type: "money" })],
      [
        vocab({ key: "rate_a", label: "Hourly rate", type: "money" }),
        vocab({ key: "rate_b", label: "Hourly Rate", type: "money" }),
      ],
    );
    expect(matches).toHaveLength(0);
  });

  it("claims each vocabulary key at most once", () => {
    const { matches, unmatched } = matchVocabularyExact(
      [
        field({ key: "a", label: "Payment terms" }),
        field({ key: "b", label: "Payment terms" }),
      ],
      [vocab()],
    );
    expect(matches).toHaveLength(1);
    expect(unmatched.map((f) => f.key)).toEqual(["b"]);
  });
});

describe("applyVocabularyMatches", () => {
  it("rewrites the key and flips source to workspace_default when a standing value exists", () => {
    const out = applyVocabularyMatches(
      [field()],
      [{ fieldKey: "payment_terms_days", useKey: "payment_terms", confidence: 0.9, rationale: "same term" }],
      [vocab()],
    );
    expect(out[0]).toMatchObject({ key: "payment_terms", sourceGuess: "workspace_default" });
    expect(out[0]!.rationale).toContain("your saved value fills it");
  });

  it("keeps the extraction's source when the reused key has no standing value", () => {
    const out = applyVocabularyMatches(
      [field()],
      [{ fieldKey: "payment_terms_days", useKey: "payment_terms", confidence: 0.9, rationale: "" }],
      [vocab({ hasStandingValue: false })],
    );
    expect(out[0]).toMatchObject({ key: "payment_terms", sourceGuess: "per_deal" });
  });

  it("ignores matches below the apply threshold", () => {
    const out = applyVocabularyMatches(
      [field()],
      [{ fieldKey: "payment_terms_days", useKey: "payment_terms", confidence: 0.5, rationale: "" }],
      [vocab()],
    );
    expect(out[0]!.key).toBe("payment_terms_days");
  });

  it("refuses a rewrite whose target key another proposal already holds", () => {
    const out = applyVocabularyMatches(
      [field({ key: "payment_terms", label: "Existing" }), field({ key: "terms_b" })],
      [{ fieldKey: "terms_b", useKey: "payment_terms", confidence: 0.9, rationale: "" }],
      [vocab()],
    );
    expect(out.map((f) => f.key)).toEqual(["payment_terms", "terms_b"]);
  });

  it("re-checks types in code even when the match says otherwise", () => {
    const out = applyVocabularyMatches(
      [field({ type: "money" })],
      [{ fieldKey: "payment_terms_days", useKey: "payment_terms", confidence: 1, rationale: "" }],
      [vocab({ type: "duration" })],
    );
    expect(out[0]!.key).toBe("payment_terms_days");
  });

  it("leaves anchors and confidence untouched — reuse changes identity, not evidence", () => {
    const out = applyVocabularyMatches(
      [field()],
      [{ fieldKey: "payment_terms_days", useKey: "payment_terms", confidence: 0.9, rationale: "" }],
      [vocab()],
    );
    expect(out[0]!.occurrences).toEqual([{ paragraphIndex: 3, snippet: "30 days" }]);
    expect(out[0]!.confidence).toBe(0.9);
  });
});
