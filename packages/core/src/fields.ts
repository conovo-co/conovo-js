import { z } from "zod/v4";

/**
 * The field taxonomy — the vocabulary of the whole product (docs/SPEC.md §3.2).
 * Every field has a `source` (where its value comes from) and a `type`
 * (how it renders and validates).
 */

export const fieldTypeSchema = z.enum([
  "text",
  "long_text",
  "name",
  "party",
  "money",
  "number",
  "date",
  "duration",
  "address",
  "choice",
  "repeating_group",
  "exhibit",
]);
export type FieldType = z.infer<typeof fieldTypeSchema>;

export const fieldSourceSchema = z.enum([
  "platform_bound",
  "workspace_default",
  "per_deal",
  "computed",
  "conditional",
]);
export type FieldSource = z.infer<typeof fieldSourceSchema>;

/**
 * Type-specific `fields.config` shapes. Structured types carry their structure
 * here — a party's role, a repeating group's columns — because they have no
 * scalar value.
 */
export const partyFieldConfigSchema = z.object({
  /** True when this party is the business owner sending the contract. */
  isSender: z.boolean().default(false),
});
export type PartyFieldConfig = z.infer<typeof partyFieldConfigSchema>;

export const repeatingGroupFieldConfigSchema = z.object({
  columns: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]*$/),
        label: z.string().min(1),
        type: fieldTypeSchema,
      }),
    )
    .min(1),
});
export type RepeatingGroupFieldConfig = z.infer<typeof repeatingGroupFieldConfigSchema>;

/**
 * A conditional SECTION: contiguous paragraphs included only when the
 * field's condition expression is true (SPEC §3.1 "this paragraph only
 * applies when there's a deposit"); false removes them from the generated
 * document. Conditional fields WITHOUT this config are fillable blanks whose
 * requiredness follows their condition.
 */
export const conditionalSectionFieldConfigSchema = z.object({
  paragraphIndexes: z.array(z.number().int().nonnegative()).min(1),
});
export type ConditionalSectionFieldConfig = z.infer<
  typeof conditionalSectionFieldConfigSchema
>;

/**
 * A location in a parsed document. `snippet` is the dynamic value's text copied
 * verbatim from the paragraph, so the UI can highlight it and the fill step can
 * anchor on it. Paragraph indexes refer to `ParsedDoc.paragraphs`.
 */
export const spanSchema = z.object({
  paragraphIndex: z.number(),
  snippet: z.string(),
});
export type Span = z.infer<typeof spanSchema>;

/**
 * Character-level formatting over a half-open [start, end) slice of a
 * paragraph's flat `text`. The text itself is untouched — anchors keep
 * searching the flat string — a run only says how a slice of it LOOKS.
 * Only styled slices are recorded; anything between runs is plain.
 */
export interface ParsedRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Rendered in capitals (w:caps) — formatting, the text itself is mixed case. */
  caps?: boolean;
  /** Font size in points, only when the run sets one explicitly. */
  size?: number;
  /** RRGGBB text colour. */
  color?: string;
}

/** A parsed document: ordered paragraphs (tables flattened in document order). */
export interface ParsedParagraph {
  index: number;
  text: string;
  /** True when the paragraph came from a table cell. */
  inTable: boolean;
  /**
   * Styled slices of `text`, for previews that want mixed formatting — the
   * "1.1 Services." bold lead-in every clause of a contract opens with.
   * Offsets index the flat `text`, so field anchors and runs coexist: a
   * renderer intersects the two span sets, the anchors never move. Absent on
   * documents parsed before runs were recorded, and on all-plain paragraphs.
   */
  runs?: ParsedRun[];
  /**
   * Where this line sits in a PDF source, so the fill step can write values
   * into the page without re-searching for them (SPEC §3.1.1). Recorded at
   * parse time because a PDF has many identical blanks and only the parse
   * knows which one this paragraph IS — searching by snippet later would
   * fill the wrong blank. Absent for DOCX and for PDFs parsed before this.
   */
  pdfBox?: {
    /** 0-based page index. */
    page: number;
    /** Text runs on this line, left to right, in PDF points (origin bottom-left). */
    items: { text: string; x: number; y: number; width: number; size: number }[];
  };
  /**
   * Paragraph-level appearance, so a preview can look like the document
   * instead of a wall of identical lines. All optional — documents parsed
   * before this carry none of it and render as plain text.
   */
  style?: {
    /** 1-6 from a Heading N style; absent for body text. */
    heading?: number;
    /** Every run in the paragraph is bold — a run-in heading or a label. */
    bold?: boolean;
    align?: "center" | "right" | "justify";
    /** Left indent in OOXML twips, as authored. */
    indent?: number;
    /** Paragraph is a numbered or bulleted list item. */
    list?: boolean;
    /** RRGGBB, only when EVERY run shares one colour. */
    color?: string;
    /** RRGGBB paragraph background. */
    shade?: string;
    /** Space above/below in OOXML twips (w:spacing), as authored. */
    spaceBefore?: number;
    spaceAfter?: number;
    /**
     * Bottom border from <w:pBdr> — how documents draw horizontal rules,
     * usually on an empty paragraph. `space` is the gap above the line in
     * points, as authored.
     */
    rule?: { color?: string; space?: number };
  };
}
/**
 * A table's shape, as paragraph indices. The flat `paragraphs` array is left
 * exactly as it is — field anchors address paragraphs by index, so grouping
 * them here rather than nesting them keeps every existing anchor valid.
 */
export interface ParsedTableCell {
  /** Paragraph indices inside this cell, in order. */
  paragraphs: number[];
  /** RRGGBB background fill, when the cell sets one. */
  shade?: string;
}

export interface ParsedTable {
  /** First paragraph the table contains, for ordering against body text. */
  startIndex: number;
  rows: ParsedTableCell[][];
  /**
   * False when the table explicitly draws no borders. Contracts use
   * borderless tables for layout constantly — party blocks, signature blocks —
   * and drawing grid lines on those makes an agreement look like a spreadsheet.
   */
  bordered: boolean;
  /**
   * Column widths in twips from <w:tblGrid>, as authored. Relative widths are
   * what matter — a label/value table reads wrong at 50/50. Absent on
   * documents parsed before this was recorded.
   */
  columns?: number[];
}

export interface ParsedDoc {
  paragraphs: ParsedParagraph[];
  /** Present when the document has tables; absent on documents parsed before. */
  tables?: ParsedTable[];
  /**
   * The default page header's paragraphs, when the document has one. Indexes
   * are NEGATIVE — header paragraphs are display-only and must never collide
   * with the body indexes that field anchors address.
   */
  header?: ParsedParagraph[];
  /**
   * Document-wide defaults from styles.xml docDefaults — the typeface the
   * author actually chose. Absent on documents parsed before this, and on
   * PDFs.
   */
  defaults?: {
    /** Font family name, e.g. "Georgia". */
    font?: string;
    /** Base font size in points. */
    size?: number;
  };
}
