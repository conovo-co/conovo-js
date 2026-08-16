import { z } from "zod/v4";
import { fieldSourceSchema, fieldTypeSchema, spanSchema } from "./fields.js";

/**
 * AI proposal shapes (docs/AI-PIPELINE.md). These are *proposals*: nothing here
 * becomes a template field until a human confirms it. All AI structured outputs
 * validate against these schemas.
 */

export const fieldProposalSchema = z.object({
  /** snake_case identifier, stable across occurrences of the same logical value. */
  key: z.string(),
  /** Plain-English label a non-technical business owner understands. */
  label: z.string(),
  type: fieldTypeSchema,
  /** Best guess at where the value should come from (docs/SPEC.md §3.2). */
  sourceGuess: fieldSourceSchema,
  /** 0–1. Below threshold renders as a suggestion, not a pre-confirmed field. */
  confidence: z.number(),
  /** Every place this value appears in the document. */
  occurrences: z.array(spanSchema),
  /** One sentence: why this is a dynamic field. */
  rationale: z.string(),
});
export type FieldProposal = z.infer<typeof fieldProposalSchema>;

export const partyProposalSchema = z.object({
  key: z.string(),
  /** Role as named in the document, e.g. "Client", "Designer", "Buyer". */
  roleLabel: z.string(),
  /** True when this party is the business owner sending the contract. */
  isSender: z.boolean(),
  occurrences: z.array(spanSchema),
  confidence: z.number(),
});
export type PartyProposal = z.infer<typeof partyProposalSchema>;

export const repeatingGroupProposalSchema = z.object({
  key: z.string(),
  label: z.string(),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: fieldTypeSchema,
    }),
  ),
  span: spanSchema,
  confidence: z.number(),
});
export type RepeatingGroupProposal = z.infer<typeof repeatingGroupProposalSchema>;

export const conditionalSectionProposalSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Plain-English condition, e.g. "only applies when a deposit is required". */
  conditionDescription: z.string(),
  paragraphIndexes: z.array(z.number()),
  confidence: z.number(),
});
export type ConditionalSectionProposal = z.infer<
  typeof conditionalSectionProposalSchema
>;

export const extractionResultSchema = z.object({
  fields: z.array(fieldProposalSchema),
  parties: z.array(partyProposalSchema),
  repeatingGroups: z.array(repeatingGroupProposalSchema),
  conditionalSections: z.array(conditionalSectionProposalSchema),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/**
 * Version alignment (docs/AI-OPPORTUNITIES.md §1): matching a REVISED document
 * against the template already confirmed from its previous version, so a
 * revision doesn't restart setup from zero.
 *
 * The model's job here is matching, not inventing — "Client Name" in ¶3 of v1
 * and "Customer" in ¶4 of v2 are the same field, and only code can't tell.
 * Everything it carries forward was already human-confirmed once; what MOVED
 * or is NEW still goes through the normal confirm step (invariant 1).
 */
export const alignedFieldSchema = z.object({
  /** Field key from the prior version. */
  key: z.string(),
  /** Where the value appears in the REVISED document. Empty ⇒ dropped. */
  occurrences: z.array(spanSchema),
  /**
   * unchanged = same anchor text, same surrounding clause, nothing to review.
   * moved = still present but the wording or location changed — needs a look.
   * dropped = no longer in the document.
   */
  status: z.enum(["unchanged", "moved", "dropped"]),
  /** Why it's flagged moved, or why it looks dropped. One sentence. */
  note: z.string(),
  confidence: z.number(),
});
export type AlignedField = z.infer<typeof alignedFieldSchema>;

/** A clause-level change in the document's own language, independent of fields. */
export const proseChangeSchema = z.object({
  /** Paragraph index in the REVISED document. */
  paragraphIndex: z.number(),
  kind: z.enum(["added", "removed", "edited"]),
  /** Plain English for a business owner: what changed and why it matters. */
  summary: z.string(),
  /** material = changes an obligation, amount, or right. minor = wording. */
  severity: z.enum(["material", "minor"]),
});
export type ProseChange = z.infer<typeof proseChangeSchema>;

export const alignmentResultSchema = z.object({
  /** One entry per field of the prior version — none may be omitted. */
  fields: z.array(alignedFieldSchema),
  /** Clause changes in the contract language itself. */
  proseChanges: z.array(proseChangeSchema),
});
export type AlignmentResult = z.infer<typeof alignmentResultSchema>;

/**
 * Send-time anomaly flag (AI-PIPELINE.md `anomalyCheck`) — the ONLY send-time
 * AI output. Flags never carry values or corrections: they may demote an
 * auto-send to draft, never alter content (CLAUDE.md invariant 2).
 */
export const anomalyFlagSchema = z.object({
  /** Field the flag concerns, when it concerns one field. */
  fieldKey: z.string().optional(),
  /** Plain English, for the business owner reviewing the draft. */
  message: z.string(),
  /** 0–1 honest probability a careful reviewer would hold the send. */
  confidence: z.number(),
});
export type AnomalyFlag = z.infer<typeof anomalyFlagSchema>;

export const anomalyResultSchema = z.object({
  flags: z.array(anomalyFlagSchema),
});
export type AnomalyResult = z.infer<typeof anomalyResultSchema>;

/** Recipient Q&A over a filled contract (AI-PIPELINE): grounded or refused. */
export const explainAnswerSchema = z.object({
  /** Plain-language answer, or a plain statement that the document doesn't say. */
  answer: z.string(),
  /** True only when the answer comes from the document's own text. */
  grounded: z.boolean(),
  /** Short verbatim snippet(s) the answer rests on, when grounded. */
  quotes: z.array(z.string()).default([]),
});
export type ExplainAnswer = z.infer<typeof explainAnswerSchema>;

/** Template readiness brief (AI-PIPELINE): composed guidance after confirm. */
export const readinessBriefSchema = z.object({
  /** One plain sentence: how send-ready this template is and why. */
  headline: z.string(),
  /** Concrete next steps, best first — empty when nothing is worth doing. */
  actions: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
      }),
    )
    .max(5),
});
export type ReadinessBrief = z.infer<typeof readinessBriefSchema>;

export const formulaProposalSchema = z.object({
  /** The computed field's key (must exist among extracted fields). */
  fieldKey: z.string(),
  /** Expression per docs/EXPRESSIONS.md, e.g. "50% * total_fee". */
  expression: z.string(),
  /** Field keys the expression references. */
  dependsOn: z.array(z.string()),
  rationale: z.string(),
  confidence: z.number(),
});
export type FormulaProposal = z.infer<typeof formulaProposalSchema>;

export const formulaResultSchema = z.object({
  formulas: z.array(formulaProposalSchema),
});
export type FormulaResult = z.infer<typeof formulaResultSchema>;

/** AI-proposed CSV column → target mapping (SPEC §3.5 — same confirm UX as import). */
export const csvColumnMappingSchema = z.object({
  /** CSV header, verbatim. */
  column: z.string(),
  /** A field key, or "subjectRef" | "recipient.name" | "recipient.email". */
  target: z.string(),
  confidence: z.number(),
  /** Plain English for the mapping-confirmation UI. */
  rationale: z.string(),
});
export type CsvColumnMapping = z.infer<typeof csvColumnMappingSchema>;

export const csvMappingResultSchema = z.object({
  mappings: z.array(csvColumnMappingSchema),
});
export type CsvMappingResult = z.infer<typeof csvMappingResultSchema>;

/**
 * AI-proposed addition to the platform's registered payload schema
 * (docs/AI-OPPORTUNITIES.md §2). Derived from the payload gap report: fields
 * whose bindings keep missing, and fields businesses keep typing by hand.
 *
 * This proposes SHAPE, not contract content — it never touches a document, and
 * registering a patched schema stays an explicit admin action (invariant 1).
 */
export const payloadAdditionSchema = z.object({
  /** Dot path to add, e.g. "client.taxId". Must not already exist in the sample. */
  path: z.string(),
  /** JSON type of the value at that path. */
  type: z.enum(["string", "number", "boolean"]),
  /**
   * Example value, JSON-encoded — same convention as `flattenPayload`, which
   * keeps the model off typed-literal schemas it handles inconsistently.
   */
  example: z.string(),
  /** One plain-English sentence for the engineer deciding whether to add it. */
  rationale: z.string(),
  /** Gap field keys this addition would satisfy. Used to rank and explain. */
  fieldKeys: z.array(z.string()),
  confidence: z.number(),
});
export type PayloadAddition = z.infer<typeof payloadAdditionSchema>;

export const payloadPatchResultSchema = z.object({
  additions: z.array(payloadAdditionSchema),
});
export type PayloadPatchResult = z.infer<typeof payloadPatchResultSchema>;

/**
 * A field proposed for a NEW payload schema, inferred from whatever the
 * platform already describes its data with — a sample response, an OpenAPI
 * spec, a Prisma schema (docs/AI-OPPORTUNITIES.md §3).
 *
 * Same shape discipline as `payloadAdditionSchema`: the model proposes paths
 * and JSON-encoded examples, and `applyPayloadAdditions` builds the object in
 * code. A model never hands back the payload itself.
 */
export const inferredFieldSchema = z.object({
  path: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  /** JSON-encoded example value, matching `type`. */
  example: z.string(),
  /** Where in the source this came from, e.g. "Client.name" or "GET /jobs → customer". */
  source: z.string(),
  /** One sentence an engineer reads to decide whether it belongs. */
  rationale: z.string(),
  confidence: z.number(),
});
export type InferredField = z.infer<typeof inferredFieldSchema>;

export const payloadInferenceResultSchema = z.object({
  fields: z.array(inferredFieldSchema),
  /**
   * What was deliberately left out and why. A platform's data model has fifty
   * tables and the payload should carry four; saying what was dropped is what
   * makes the proposal trustworthy rather than lossy.
   */
  omitted: z.array(z.object({ name: z.string(), reason: z.string() })),
  /**
   * Anything about the source that would silently produce a WRONG contract —
   * money stored as integer cents being the one that matters, since a contract
   * that says $450,000 instead of $4,500 is a catastrophe the validator can't
   * catch. Empty when there's nothing to say.
   */
  warnings: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type PayloadInferenceResult = z.infer<typeof payloadInferenceResultSchema>;

/**
 * AI contract review (SPEC §3.6, Phase 5): gaps and risks flagged in plain
 * English, each optionally carrying a proposed clause as a REDLINE the user
 * accepts or rejects (invariant 1 — nothing enters the document without
 * explicit acceptance). Never legal advice; the UI frames it that way.
 */
export const reviewFindingSchema = z.object({
  /** Stable kebab-case id, e.g. "late-payment". */
  key: z.string(),
  /** Short title: "No late-payment clause". */
  title: z.string(),
  /** gap = something standard is missing; risk = present but one-sided/unclear; note = FYI. */
  severity: z.enum(["gap", "risk", "note"]),
  /** Plain English a non-lawyer business owner understands. */
  explanation: z.string(),
  /** Proposed clause text as a redline; omitted for flag-only findings. */
  proposedClause: z
    .object({
      /** Clause paragraphs, "\n\n"-separated. Generic commercial language only. */
      text: z.string(),
      /** Original-document paragraph index to insert after. */
      insertAfterParagraph: z.number(),
      rationale: z.string(),
    })
    .optional(),
  confidence: z.number(),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewResultSchema = z.object({
  findings: z.array(reviewFindingSchema),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;
