"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * The contract as it currently reads, beside the form that fills it.
 *
 * Not the source document: every field with a value shows THAT value, so this
 * is the agreement as it stands right now, updating as you type. Fields still
 * waiting keep the document's own marker, which is what makes an unfilled
 * blank obvious without going looking for it.
 *
 * Hovering a field in the form lights up its spot here. A label like
 * "Arbitration body" means very little until you see the sentence it lands in,
 * and that was the whole complaint an excerpt never really answered.
 */

/** A styled slice of a paragraph's text — [start, end) into the flat string. */
export interface DocRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Rendered in capitals — the text itself stays mixed case. */
  caps?: boolean;
  /** Points. */
  size?: number;
  /** RRGGBB. */
  color?: string;
}

export interface DocParagraph {
  index: number;
  text: string;
  inTable?: boolean;
  /** Styled slices of `text`; absent on documents parsed before runs. */
  runs?: DocRun[];
  style?: {
    heading?: number;
    bold?: boolean;
    align?: "center" | "right" | "justify";
    /** OOXML twips: 1440 per inch. */
    indent?: number;
    list?: boolean;
    /** RRGGBB text colour. */
    color?: string;
    /** RRGGBB paragraph background. */
    shade?: string;
    /** OOXML twips: 20 per point. */
    spaceBefore?: number;
    spaceAfter?: number;
    /** Bottom border — a document's horizontal rule. `space` in points. */
    rule?: { color?: string; space?: number };
  };
}

export interface DocCell {
  paragraphs: number[];
  /** RRGGBB fill. */
  shade?: string;
}

export interface DocTable {
  startIndex: number;
  /**
   * Cells are {paragraphs, shade} now, but documents parsed before shading
   * stored them as a bare number[] of paragraph indices. Both shapes are in
   * the database and neither can be migrated away — doc_structure is a
   * snapshot of what a template was cut from. Read through normaliseCell.
   */
  rows: (DocCell | number[])[][];
  /** False for a borderless layout table — draw no grid lines. */
  bordered?: boolean;
  /** Column widths in twips; only their ratios matter here. */
  columns?: number[];
}

/** What the whole document looks like before any style touches it. */
export interface DocDefaults {
  /** Font family name, e.g. "Georgia". */
  font?: string;
  /** Base size in points. */
  size?: number;
}

/**
 * One cell, whichever shape it was stored in.
 *
 * This is the whole cost of having changed a PERSISTED shape: the type can
 * move on, the rows already written cannot. Anything unrecognised becomes an
 * empty cell rather than throwing — a stored document is not worth crashing a
 * page over, and an empty cell is visibly wrong in a way an exception isn't.
 */
export function normaliseCell(cell: DocCell | number[] | null | undefined): DocCell {
  if (Array.isArray(cell)) return { paragraphs: cell };
  if (cell && Array.isArray(cell.paragraphs)) return cell;
  return { paragraphs: [] };
}

export interface Marked {
  key: string;
  occurrences: { paragraphIndex: number; snippet: string }[];
  /**
   * Traffic-light state for the highlight: `good` — confirmed and healthy;
   * `check` — an open call either answer could settle; `fix` — saving as-is
   * bakes in something wrong. Absent = the default mark styling.
   */
  status?: "good" | "check" | "fix";
}

/** Inline CSS for one run's character formatting. */
function runCss(r: DocRun): CSSProperties {
  const s: CSSProperties = {};
  if (r.bold) s.fontWeight = 600;
  if (r.italic) s.fontStyle = "italic";
  if (r.underline) s.textDecoration = "underline";
  if (r.caps) s.textTransform = "uppercase";
  if (r.size) s.fontSize = `${r.size}pt`;
  if (r.color) s.color = `#${r.color}`;
  return s;
}

export interface Segment {
  start: number;
  end: number;
  /** Field mark covering this slice, if any. */
  key?: string;
  /** Run styling covering this slice, if any. */
  run?: DocRun;
}

/**
 * Cut [0, textLength) at every mark and run boundary, so each piece has ONE
 * mark (or none) and ONE run (or none). This is how field highlights and
 * character formatting coexist without either owning the text: the mark spans
 * never move, the formatting drapes over whatever slices it covers — a bold
 * lead-in can end mid-highlight and both still render.
 */
export function segmentText(
  textLength: number,
  spans: { start: number; end: number; key: string }[],
  runs: DocRun[],
): Segment[] {
  const cuts = new Set<number>([0, textLength]);
  for (const s of spans) cuts.add(s.start).add(s.end);
  // A run written against a longer text than we were given (it shouldn't
  // happen, but this is persisted data) clamps rather than segments past the
  // end.
  for (const r of runs) cuts.add(Math.min(r.start, textLength)).add(Math.min(r.end, textLength));
  const points = [...cuts]
    .filter((n) => n >= 0 && n <= textLength)
    .sort((a, b) => a - b);

  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    const span = spans.find((s) => s.start <= start && end <= s.end);
    const run = runs.find((r) => r.start <= start && end <= r.end);
    out.push({
      start,
      end,
      ...(span ? { key: span.key } : {}),
      ...(run ? { run } : {}),
    });
  }
  return out;
}

function Highlighted({
  text,
  runs = [],
  paragraphIndex,
  marks,
  values,
  active,
  onHover,
  onPick,
}: {
  text: string;
  runs?: DocRun[];
  paragraphIndex: number;
  marks: Marked[];
  values: Record<string, string>;
  active: string | null;
  onHover?: (key: string | null) => void;
  onPick?: (key: string) => void;
}) {
  // Non-overlapping [start, end, key] spans for this paragraph. First match
  // wins: two fields claiming the same characters would nest their marks.
  const spans: { start: number; end: number; key: string }[] = [];
  for (const m of marks)
    for (const o of m.occurrences) {
      if (o.paragraphIndex !== paragraphIndex || !o.snippet) continue;
      const start = text.indexOf(o.snippet);
      if (start < 0) continue;
      const end = start + o.snippet.length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ start, end, key: m.key });
    }
  if (spans.length === 0 && runs.length === 0) return <>{text}</>;
  spans.sort((a, b) => a.start - b.start);

  const piece = (seg: Segment) => {
    const slice = text.slice(seg.start, seg.end);
    return seg.run ? (
      <span key={seg.start} style={runCss(seg.run)}>
        {slice}
      </span>
    ) : (
      slice
    );
  };

  const segs = segmentText(text.length, spans, runs);
  const out: ReactNode[] = [];
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i]!;
    if (!seg.key) {
      out.push(piece(seg));
      i++;
      continue;
    }
    // Every consecutive segment of the same field renders inside ONE mark, so
    // a highlight crossed by a formatting boundary stays a single highlight.
    let j = i;
    while (j < segs.length && segs[j]!.key === seg.key) j++;
    const group = segs.slice(i, j);
    const filled = values[seg.key];
    const status = marks.find((m) => m.key === seg.key)?.status;
    out.push(
      <mark
        key={`${seg.key}-${seg.start}`}
        // Not "filled"/"empty": .conovo .filled is the send panel's row
        // grid, and it matched these marks too — every value rendered as a
        // full-width block that broke its own sentence in half.
        className={[
          active === seg.key ? "active" : "",
          filled ? "hasvalue" : "novalue",
          status ? `st-${status}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
        // A value typed over a styled slice keeps that slice's look — a name
        // filled into a bold title should render bold, at the title's size.
        {...(filled && group[0]!.run ? { style: runCss(group[0]!.run) } : {})}
        {...(onHover
          ? {
              onMouseEnter: () => onHover(seg.key!),
              onMouseLeave: () => onHover(null),
            }
          : {})}
        {...(onPick ? { onClick: () => onPick(seg.key!) } : {})}
      >
        {filled || group.map(piece)}
      </mark>,
    );
    i = j;
  }
  return <>{out}</>;
}

/**
 * The document's own typeface with a generic fallback of the same species —
 * a missing serif must not fall back to the UI's sans and vice versa.
 */
const SANS =
  /^(arial|helvetica|calibri|carlito|verdana|tahoma|segoe|roboto|open sans|lato|inter|futura|gill sans|century gothic|franklin gothic|avenir|aptos)/i;
function fontStack(font: string): string {
  return `"${font}", ${SANS.test(font) ? "Helvetica, Arial, sans-serif" : 'Georgia, "Times New Roman", serif'}`;
}

export function DocumentPane({
  paragraphs,
  tables = [],
  defaults,
  header = [],
  marks,
  values = {},
  active,
  onHover,
  onPick,
  className = "",
  scrollOnActive = true,
}: {
  paragraphs: DocParagraph[];
  /** Table structure by paragraph index; absent on older documents. */
  tables?: DocTable[];
  /** Document-wide font defaults; absent on older documents and PDFs. */
  defaults?: DocDefaults;
  /**
   * Page-header paragraphs (negative indexes, display-only). No field ever
   * anchors here, so they render without marks.
   */
  header?: DocParagraph[];
  marks: Marked[];
  /** Display value per field key; absent means it still shows its marker. */
  values?: Record<string, string>;
  /** Field to highlight and scroll to. */
  active: string | null;
  onHover?: (key: string | null) => void;
  /** Clicking a mark selects that field — the import screen's behaviour. */
  onPick?: (key: string) => void;
  className?: string;
  /**
   * The import screen drives scrolling itself (it aligns the card and the
   * paragraph together), so it opts out rather than fighting this pane.
   */
  scrollOnActive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Bring the active field into view WITHOUT scrollIntoView, which walks up
   * and scrolls every scrollable ancestor — hovering a field dragged the page
   * and the form column along with it. Setting scrollTop on this pane can only
   * ever move this pane.
   *
   * And only when the mark is actually outside the visible area: a field the
   * user can already see doesn't need the document to move under them.
   * Keyed on `active` alone, so typing a value doesn't re-trigger it.
   */
  useEffect(() => {
    if (!active || !scrollOnActive) return;
    const pane = ref.current;
    const el = pane?.querySelector("mark.active");
    if (!pane || !el) return;
    const paneBox = pane.getBoundingClientRect();
    const markBox = el.getBoundingClientRect();
    const above = markBox.top < paneBox.top;
    const below = markBox.bottom > paneBox.bottom;
    if (!above && !below) return;
    const delta =
      markBox.top - paneBox.top - (pane.clientHeight - markBox.height) / 2;
    pane.scrollTo({ top: pane.scrollTop + delta, behavior: "smooth" });
  }, [active, scrollOnActive]);

  // Which paragraphs belong to a table, and which table each one opens. Legal
  // contracts are largely tables — party blocks, clause grids, signature
  // blocks — and rendering their cells as stacked paragraphs is most of why a
  // preview stops looking like the document.
  const tableAt = new Map<number, DocTable>();
  const insideTable = new Set<number>();
  for (const t of tables) {
    tableAt.set(t.startIndex, t);
    for (const c of t.rows.flat())
      for (const i of normaliseCell(c).paragraphs) insideTable.add(i);
  }

  const para = (p: DocParagraph) => (
    <Para key={p.index} p={p} marks={marks} values={values} active={active}
      {...(onHover ? { onHover } : {})} {...(onPick ? { onPick } : {})} />
  );
  const byIndex = new Map(paragraphs.map((p) => [p.index, p]));

  // The document's own typeface, applied at the pane so every paragraph,
  // cell and mark inherits it. Word's 100% zoom is pt-for-pt what CSS pt
  // renders, so the base size carries over directly.
  const paneStyle: CSSProperties | undefined = defaults
    ? {
        ...(defaults.font ? { fontFamily: fontStack(defaults.font) } : {}),
        ...(defaults.size ? { fontSize: `${defaults.size}pt` } : {}),
      }
    : undefined;

  return (
    <div className={`docpane ${className}`.trim()} ref={ref} style={paneStyle}>
      {header.length > 0 && (
        <div className="docheader">
          {header.map((p) => (
            <Para key={p.index} p={p} marks={[]} values={{}} active={null} />
          ))}
        </div>
      )}
      {paragraphs.map((p) => {
        const table = tableAt.get(p.index);
        const colTotal = (table?.columns ?? []).reduce((a, b) => a + b, 0);
        if (table)
          return (
            <table
              // "sized" switches to fixed layout so the document's column
              // ratios actually hold — percentage cols are only hints when
              // the browser lays the table out from content.
              className={`doctable${table.bordered === false ? " bare" : ""}${
                table.columns && colTotal > 0 ? " sized" : ""
              }`}
              key={`t${p.index}`}
            >
              {table.columns && colTotal > 0 && (
                <colgroup>
                  {table.columns.map((w, i) => (
                    <col key={i} style={{ width: `${(w / colTotal) * 100}%` }} />
                  ))}
                </colgroup>
              )}
              <tbody>
                {table.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((raw, ci) => {
                      const cell = normaliseCell(raw);
                      return (
                      <td
                        key={ci}
                        {...(cell.shade
                          ? { style: { background: `#${cell.shade}` } }
                          : {})}
                      >
                        {cell.paragraphs
                          .map((i) => byIndex.get(i))
                          .filter((x): x is DocParagraph => !!x && !!x.text.trim())
                          .map(para)}
                      </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        // Cells are rendered by their table; skip them in the main flow.
        if (insideTable.has(p.index)) return null;
        // Empty paragraphs usually add nothing — EXCEPT when they carry a
        // bottom border, which is how a document draws a horizontal rule.
        return p.text.trim() || p.style?.rule ? para(p) : null;
      })}
    </div>
  );
}

function Para({
  p, marks, values, active, onHover, onPick,
}: {
  p: DocParagraph;
  marks: Marked[];
  values: Record<string, string>;
  active: string | null;
  onHover?: (key: string | null) => void;
  onPick?: (key: string) => void;
}) {
  return (
    <>
      {[p].map((q) => (
          <p
            key={q.index}
            className={[
              q.style?.heading ? `h${Math.min(q.style.heading, 6)}` : "",
              q.style?.bold ? "b" : "",
              q.style?.list ? "li" : "",
              q.style?.align ? `al-${q.style.align}` : "",
            ]
              .filter(Boolean)
              .join(" ")}
            // Twips to em: 1440 twips = 1 inch, and an indent reads better
            // relative to the text size than pinned to inches in a side pane.
            // Spacing is twips to pt (20 per pt), capped so a decorative
            // spacer paragraph can't open a page-sized hole; the cap is far
            // above anything a document authored for reading uses.
            style={{
              ...(q.style?.indent
                ? { marginLeft: `${Math.min(q.style.indent / 720, 6)}em` }
                : {}),
              ...(q.style?.color ? { color: `#${q.style.color}` } : {}),
              ...(q.style?.shade ? { background: `#${q.style.shade}` } : {}),
              ...(q.style?.spaceBefore
                ? { marginTop: `${Math.min(q.style.spaceBefore / 20, 40)}pt` }
                : {}),
              ...(q.style?.spaceAfter
                ? { marginBottom: `${Math.min(q.style.spaceAfter / 20, 40)}pt` }
                : {}),
              ...(q.style?.rule
                ? {
                    borderBottom: `1px solid #${q.style.rule.color ?? "B9B2A6"}`,
                    paddingBottom: `${Math.min(q.style.rule.space ?? 2, 24)}pt`,
                  }
                : {}),
            }}
            data-para={q.index}
          >
            <Highlighted
              text={q.text}
              {...(q.runs ? { runs: q.runs } : {})}
              paragraphIndex={q.index}
              marks={marks}
              values={values}
              active={active}
              {...(onHover ? { onHover } : {})}
              {...(onPick ? { onPick } : {})}
            />
          </p>
      ))}
    </>
  );
}
