"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  BindingProposal,
  ExtractionResult,
  FieldSource,
  FieldType,
  FormulaProposal,
  ParsedDoc,
  SerializedValue,
} from "@conovo/core";
import {
  isPlaceholderText,
  placeholderFieldType,
  placeholderKey,
  placeholderLabel,
  unmappedPlaceholders,
} from "@conovo/core";
import {
  bindingPreview,
  computeFormulaPreviews,
  editStringForValue,
  tryParseInput,
  type FormulaPreview,
} from "./values.js";
import { BLANKS_CARD, collectAttention, nextAttentionCard } from "./attention.js";
import { claimedSpans, fieldOwningBlank, fieldsForUnmappedBlanks } from "./blanks.js";
import { DocumentPane } from "./DocumentPane.js";
import { LockedGate, useConovo } from "./context.js";

/**
 * <ContractStudio> — the whole template-import loop in one component
 * (SPEC §3.1): upload a contract → AI proposals → highlight-and-confirm
 * review → saved template with an auto-fill score. Nothing is saved until
 * the user confirms (invariant 1).
 */

/** Confidence below this renders as a suggestion needing explicit acceptance. */
const ACCEPT_THRESHOLD = 0.7;

const FIELD_TYPES: FieldType[] = [
  "text", "long_text", "name", "money", "number", "date", "duration", "address", "choice",
];
const FIELD_SOURCES: { value: FieldSource; label: string }[] = [
  { value: "platform_bound", label: "Filled from your data" },
  { value: "workspace_default", label: "Your standing terms" },
  { value: "per_deal", label: "You enter per contract" },
  { value: "computed", label: "Calculated" },
  { value: "conditional", label: "Depends on a clause" },
];

interface ImportResponse {
  id: string;
  filename: string;
  status: "processing" | "proposed" | "confirmed" | "failed";
  error: string | null;
  doc: ParsedDoc | null;
  proposals: {
    extraction: ExtractionResult;
    formulas: { formulas: FormulaProposal[] };
    bindings: { bindings: BindingProposal[] };
    /** Present only when this import revises an existing template. */
    alignment?: RevisionAlignment;
    /** Deterministic scan found filled-in identifiers — looks like a real
     * client's document rather than a blank template. */
    piiScan?: { ssnLike: number; einLike: number; cardLike: number };
  } | null;
  samplePayload: unknown;
  workspaceDefaults: Record<string, SerializedValue>;
}

/**
 * What the API returns when an import supersedes a template: which confirmed
 * fields carried onto the revised document, the metadata to pre-fill them
 * from, and what changed in the contract language itself.
 */
interface RevisionAlignment {
  priorTemplate: { id: string; name: string; version: number; reviewedSendCount: number };
  result: {
    fields: {
      key: string;
      status: "unchanged" | "moved" | "dropped";
      note: string;
      confidence: number;
      occurrences: { paragraphIndex: number; snippet: string }[];
    }[];
    proseChanges: {
      paragraphIndex: number;
      kind: "added" | "removed" | "edited";
      summary: string;
      severity: "material" | "minor";
    }[];
  };
  carried: {
    key: string;
    label: string;
    type: FieldType;
    source: FieldSource;
    bindingPath: string | null;
    expression: string | null;
    defaultValue: SerializedValue | null;
    config: Record<string, unknown> | null;
    required: boolean;
    position: number;
  }[];
}

interface EditableField {
  accepted: boolean;
  key: string;
  label: string;
  type: FieldType;
  source: FieldSource;
  confidence: number;
  rationale: string;
  occurrences: { paragraphIndex: number; snippet: string }[];
  binding?: { path: string; confidence: number; accepted: boolean };
  expression?: string;
  /** What the user typed for a workspace_default standing value. */
  defaultRaw?: string;
  /** True when this key already has a saved workspace default. */
  hasSavedDefault?: boolean;
  /** The document's own marker ("[STATE]"), shown as a hint, never a value. */
  defaultHint?: string;
  /**
   * Only set on a revision. "carried" was confirmed on the previous version and
   * still sits in the same clause; "moved" needs a look; "new" wasn't there
   * before and gets the normal cold-import treatment.
   */
  revision?: "carried" | "moved" | "new";
  /** The alignment's plain-English note about what happened to this field. */
  revisionNote?: string;
}

interface EditableParty {
  accepted: boolean;
  key: string;
  roleLabel: string;
  isSender: boolean;
  confidence: number;
  occurrences: { paragraphIndex: number; snippet: string }[];
}

interface EditableGroup {
  accepted: boolean;
  key: string;
  label: string;
  columns: { key: string; label: string; type: FieldType }[];
  confidence: number;
  occurrences: { paragraphIndex: number; snippet: string }[];
}

interface EditableFinding {
  accepted: boolean;
  key: string;
  title: string;
  severity: "gap" | "risk" | "note";
  explanation: string;
  /** Editable clause text; undefined = flag-only finding. */
  clauseText?: string;
  insertAfterParagraph?: number;
  confidence: number;
}

interface EditableSection {
  accepted: boolean;
  key: string;
  label: string;
  /** AI's plain-English condition ("only applies when there's a deposit"). */
  conditionDescription: string;
  /** The condition the user confirms (EXPRESSIONS.md boolean, e.g. "deposit > $0"). */
  expression: string;
  paragraphIndexes: number[];
  confidence: number;
  occurrences: { paragraphIndex: number; snippet: string }[];
}

/** Anything that can be highlighted in the document pane. */
interface Highlightable {
  key: string;
  accepted: boolean;
  occurrences: { paragraphIndex: number; snippet: string }[];
}

function buildEditable(
  p: NonNullable<ImportResponse["proposals"]>,
  saved: Record<string, SerializedValue>,
): EditableField[] {
  const bindingByKey = new Map(p.bindings.bindings.map((b) => [b.fieldKey, b]));
  const formulaByKey = new Map(p.formulas.formulas.map((f) => [f.fieldKey, f]));

  // On a revision, a carried field arrives already decided — its source,
  // binding, formula and standing value were confirmed against the previous
  // version. Re-deriving any of that from the cold proposals would throw away
  // the human's earlier answer, which is the whole point of re-import.
  const carriedByKey = new Map(
    (p.alignment?.carried ?? []).map((c) => [c.key, c] as const),
  );
  const statusByKey = new Map(
    (p.alignment?.result.fields ?? []).map((f) => [f.key, f] as const),
  );

  return p.extraction.fields.map((f) => {
    const binding = bindingByKey.get(f.key);
    const formula = formulaByKey.get(f.key);
    const carried = carriedByKey.get(f.key);

    if (carried) {
      const status = statusByKey.get(f.key);
      const moved = status?.status === "moved";
      const field: EditableField = {
        // Carried fields were confirmed once already; what MOVED is called out
        // separately rather than re-asked from scratch.
        accepted: true,
        key: carried.key,
        label: carried.label,
        type: carried.type,
        source: carried.source,
        confidence: status?.confidence ?? 1,
        rationale: status?.note ?? "",
        occurrences: f.occurrences,
        revision: moved ? "moved" : "carried",
        revisionNote: status?.note ?? "",
      };
      if (carried.bindingPath)
        field.binding = { path: carried.bindingPath, confidence: 1, accepted: true };
      if (carried.expression) field.expression = carried.expression;
      if (carried.defaultValue) {
        field.hasSavedDefault = true;
        field.defaultRaw = editStringForValue(carried.defaultValue);
      }
      return field;
    }

    const field: EditableField = {
      accepted: f.confidence >= ACCEPT_THRESHOLD,
      key: f.key,
      label: f.label,
      type: f.type as FieldType,
      source: f.sourceGuess as FieldSource,
      confidence: f.confidence,
      rationale: f.rationale,
      occurrences: f.occurrences,
      ...(p.alignment ? { revision: "new" as const } : {}),
    };
    if (binding) {
      field.binding = {
        path: binding.path,
        confidence: binding.confidence,
        accepted: binding.confidence >= ACCEPT_THRESHOLD,
      };
      if (field.binding.accepted) field.source = "platform_bound";
    }
    if (formula) {
      field.expression = formula.expression;
      if (formula.confidence >= ACCEPT_THRESHOLD) field.source = "computed";
    }
    // Standing value: pre-fill from the saved workspace default, else from the
    // document — a contract someone already filled in usually contains it. But
    // a BLANK template's snippet is the marker itself ("[STATE]"), and saving
    // that as a standing term prints it into every future contract. Keep the
    // marker as a hint instead.
    const savedValue = saved[f.key];
    const snippet = f.occurrences[0]?.snippet ?? "";
    if (savedValue) {
      field.hasSavedDefault = true;
      field.defaultRaw = editStringForValue(savedValue);
    } else if (field.source === "workspace_default") {
      if (isPlaceholderText(snippet)) field.defaultHint = snippet;
      else field.defaultRaw = snippet;
    }
    return field;
  });
}

function buildParties(p: NonNullable<ImportResponse["proposals"]>): EditableParty[] {
  return p.extraction.parties.map((pt) => ({
    accepted: pt.confidence >= ACCEPT_THRESHOLD,
    key: pt.key,
    roleLabel: pt.roleLabel,
    isSender: pt.isSender,
    confidence: pt.confidence,
    occurrences: pt.occurrences,
  }));
}

function buildGroups(p: NonNullable<ImportResponse["proposals"]>): EditableGroup[] {
  return p.extraction.repeatingGroups.map((g) => ({
    accepted: g.confidence >= ACCEPT_THRESHOLD,
    key: g.key,
    label: g.label,
    columns: g.columns.map((c) => ({ key: c.key, label: c.label, type: c.type as FieldType })),
    confidence: g.confidence,
    occurrences: [g.span],
  }));
}

function buildSections(
  p: NonNullable<ImportResponse["proposals"]>,
  doc: ParsedDoc | null,
): EditableSection[] {
  const paraText = (i: number) => doc?.paragraphs[i]?.text ?? "";
  return p.extraction.conditionalSections.map((s) => ({
    // Altering document structure is a bigger call than accepting a field —
    // sections are suggestions until explicitly accepted (invariant 1).
    accepted: false,
    key: s.key,
    label: s.label,
    conditionDescription: s.conditionDescription,
    expression: "",
    paragraphIndexes: s.paragraphIndexes,
    confidence: s.confidence,
    occurrences: s.paragraphIndexes
      .filter((i) => paraText(i) !== "")
      .map((i) => ({ paragraphIndex: i, snippet: paraText(i) })),
  }));
}

interface Readiness {
  generatable: boolean;
  fieldCount: number;
  autoFillCount: number;
  perDeal: { key: string; label: string; type: string }[];
  missingDefaults: { key: string; label: string; type: string }[];
  unanchored: { key: string; label: string }[];
  brief: { headline: string; actions: { title: string; detail: string }[] } | null;
}

/**
 * The setup copilot's closing move: after confirm, fetch the readiness
 * aggregate + composed brief and show what to do next. Loads quietly —
 * a failure here never dims the success screen.
 */
function ReadinessCard({ versionId }: { versionId: string }) {
  const { apiFetch } = useConovo();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [state, setState] = useState<"loading" | "done" | "failed">("loading");

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const res = await apiFetch(`/v1/template-versions/${versionId}/readiness`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as Readiness;
        if (!stop) {
          setReadiness(d);
          setState("done");
        }
      } catch {
        if (!stop) setState("failed");
      }
    })();
    return () => {
      stop = true;
    };
  }, [apiFetch, versionId]);

  if (state === "loading")
    return (
      <p className="sub">
        <span className="spinner" />
        Checking how send-ready this template is…
      </p>
    );
  if (state === "failed" || !readiness) return null;

  return (
    <div className="readiness">
      {readiness.brief && <p className="readiness-headline">{readiness.brief.headline}</p>}
      {readiness.brief?.actions.map((a) => (
        <div key={a.title} className="readiness-action">
          <strong>{a.title}</strong>
          <p className="sub" style={{ margin: 0 }}>{a.detail}</p>
        </div>
      ))}
      {!readiness.brief && (
        <>
          {readiness.perDeal.length > 0 && (
            <p className="sub">
              Asked on each contract: {readiness.perDeal.map((f) => f.label).join(", ")}
            </p>
          )}
          {readiness.missingDefaults.length > 0 && (
            <p className="sub">
              Worth saving as standing values: {readiness.missingDefaults.map((f) => f.label).join(", ")}
            </p>
          )}
        </>
      )}
      {readiness.unanchored.length > 0 && (
        <p className="sub" style={{ color: "var(--cv-warn, #b54708)" }}>
          Won&apos;t fill into the document (no anchor found):{" "}
          {readiness.unanchored.map((f) => f.label).join(", ")} — re-import if the
          document has changed, or remove these fields.
        </p>
      )}
    </div>
  );
}

export function ContractStudio({
  onConfirmed,
  revisionOf,
  resumeImportId,
  onImportChanged,
  variant,
  uploadTitle,
  uploadIntro,
}: {
  /** Called after the user confirms and the template version is saved. */
  onConfirmed?: (result: { autoFillCount: number; fieldCount: number }) => void;
  /**
   * Set to revise a template this workspace already has: the upload is matched
   * against the confirmed previous version, and saving cuts the next version of
   * THAT template rather than creating a second one — so its presets and its
   * earned auto-send unlock survive the revision.
   */
  revisionOf?: { templateId: string; name: string };
  /**
   * Re-open an import that's already underway. Processing continues server-side
   * whether or not this component is mounted, so a host that stores the id from
   * `onImportChanged` (in its URL, typically) can deep-link the user straight
   * back to their in-flight or ready-to-review import.
   */
  resumeImportId?: string;
  /**
   * Fires with the import id when an upload starts, and null when the user
   * starts over. Persist it (e.g. in the page URL) to make imports resumable
   * across navigation.
   */
  onImportChanged?: (importId: string | null) => void;
  /**
   * "panel" renders the UPLOAD step as a self-contained choice card —
   * title, intro, drop target, CTA — for hosts laying it out beside
   * <TemplateGallery variant="panel"> in a `.chooser` grid. Only the upload
   * step is affected; processing and review always take the full width, so
   * pair this with `onImportChanged` to collapse the grid while building.
   */
  variant?: "panel";
  /** Panel title override (default "Upload your contract"). */
  uploadTitle?: string;
  /** Panel intro override. */
  uploadIntro?: string;
}) {
  const [importId, setImportId] = useState<string | null>(resumeImportId ?? null);
  const setImport = (id: string | null) => {
    setImportId(id);
    onImportChanged?.(id);
  };
  return (
    <LockedGate>
      <div className="conovo">
        {importId ? (
          <Review
            id={importId}
            onRestart={() => setImport(null)}
            {...(onConfirmed ? { onConfirmed } : {})}
          />
        ) : (
          <Upload
            onCreated={setImport}
            {...(revisionOf ? { revisionOf } : {})}
            {...(variant ? { variant } : {})}
            {...(uploadTitle ? { title: uploadTitle } : {})}
            {...(uploadIntro ? { intro: uploadIntro } : {})}
          />
        )}
      </div>
    </LockedGate>
  );
}

const ACCEPTED = [".docx", ".pdf"];

function Upload({
  onCreated,
  revisionOf,
  variant,
  title,
  intro,
}: {
  onCreated: (importId: string) => void;
  revisionOf?: { templateId: string; name: string };
  variant?: "panel";
  title?: string;
  intro?: string;
}) {
  const { apiFetch } = useConovo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** The file currently uploading; null = idle. Upload starts on pick. */
  const [uploading, setUploading] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The native input stays hidden and is driven by the buttons — a bare
   * <input type="file"> is easy for a host platform's global CSS to shrink or
   * hide, and users reach for the prominent button expecting a file dialog.
   */
  const choose = () => fileRef.current?.click();

  /**
   * Picking a file IS the go signal — there's no confirm step, so the
   * type check has to happen here, before anything leaves the browser.
   */
  function accept(picked: File | null | undefined) {
    if (!picked || uploading) return;
    const ok = ACCEPTED.some((ext) => picked.name.toLowerCase().endsWith(ext));
    if (!ok) {
      setError("That file type isn't supported — upload a .docx or .pdf.");
      return;
    }
    setError(null);
    void upload(picked);
  }

  async function upload(file: File) {
    setUploading(file);
    try {
      const form = new FormData();
      form.append("file", file);
      if (revisionOf) form.append("supersedesTemplateId", revisionOf.templateId);
      const res = await apiFetch(`/v1/imports`, { method: "POST", body: form });
      const data = (await res.json()) as { importId?: string; error?: string };
      if (!res.ok || !data.importId) throw new Error(data.error ?? "upload failed");
      onCreated(data.importId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUploading(null);
    }
  }

  const dropzone = (
    <div
      className={`dropzone${variant === "panel" ? " compact" : ""}${dragging ? " dragging" : ""}${uploading ? " busy" : ""}`}
      {...(variant === "panel" ? {} : { style: { maxWidth: 560 } })}
      // The whole zone is the target — clicking anywhere opens the picker,
      // matching what the dashed border already promises.
      onClick={() => !uploading && choose()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!uploading) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        accept(e.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".docx,.pdf"
        // Inline, so a host stylesheet can't reveal it accidentally.
        style={{ display: "none" }}
        onChange={(e) => accept(e.target.files?.[0])}
      />
      {uploading ? (
        <>
          <p className="filename">
            <span className="spinner" />
            {uploading.name}
          </p>
          <p className="dz-hint">Uploading…</p>
        </>
      ) : (
        <>
          <svg
            className="dz-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M12 18v-6" />
            <path d="m9 15 3-3 3 3" />
          </svg>
          <p className="dz-title">
            {variant === "panel" ? (
              "Drag and drop it here"
            ) : (
              <>
                Drag a contract here, or{" "}
                <button
                  className="dz-choose"
                  onClick={(e) => {
                    e.stopPropagation();
                    choose();
                  }}
                >
                  choose a file…
                </button>
              </>
            )}
          </p>
          <p className="dz-hint">
            Word (.docx) or PDF. Word gives the best fill fidelity; PDFs work
            too.
          </p>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );

  // Choice-card form: same skeleton as the gallery panel next to it —
  // title, subtext, content, CTA — so the two options read as siblings.
  if (variant === "panel")
    return (
      <section className="panel">
        <h2 className="panel-title">
          {title ?? (revisionOf ? "Upload the new version" : "Upload your contract")}
        </h2>
        <p className="panel-sub">
          {intro ??
            (revisionOf
              ? "We'll match it against your confirmed setup and carry it forward — you only review what changed."
              : "The agreement you send to clients today. We'll find everything that changes from client to client — you just confirm.")}
        </p>
        {dropzone}
        <button
          className="primary panel-cta"
          disabled={!!uploading}
          onClick={choose}
        >
          {uploading ? "Uploading…" : "Choose a file…"}
        </button>
      </section>
    );

  return (
    <>
      <h1>{revisionOf ? "Upload the new version" : "Set up your contract"}</h1>
      <p className="sub">
        {revisionOf ? (
          <>
            We&apos;ll match it against <strong>{revisionOf.name}</strong> and carry
            your setup forward — your saved details, calculations and presets stay
            put. You only review what changed.
          </>
        ) : (
          <>
            Upload the contract you send to clients today. We&apos;ll find everything
            that changes from client to client — you just confirm.
          </>
        )}
      </p>
      {dropzone}
    </>
  );
}

function Review({
  id,
  onRestart,
  onConfirmed,
}: {
  id: string;
  onRestart: () => void;
  onConfirmed?: (result: { autoFillCount: number; fieldCount: number }) => void;
}) {
  const { apiFetch } = useConovo();
  const [data, setData] = useState<ImportResponse | null>(null);
  const [fields, setFields] = useState<EditableField[] | null>(null);
  const [parties, setParties] = useState<EditableParty[]>([]);
  const [groups, setGroups] = useState<EditableGroup[]>([]);
  const [sections, setSections] = useState<EditableSection[]>([]);
  const [findings, setFindings] = useState<EditableFinding[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{
    autoFillCount: number;
    fieldCount: number;
    demotedBindings: string[];
    templateVersionId: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Long lists make the attention panel taller than the work it points at.
  const [showAllAttention, setShowAllAttention] = useState(false);
  // What carried needs no review, so it starts collapsed — the point of a
  // revision screen is to show what CHANGED.
  const [showCarried, setShowCarried] = useState(false);
  const alignment = data?.proposals?.alignment ?? null;
  const docRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  /**
   * Desktop notification for the reader who left. Processing continues
   * server-side whether this tab is open or not; if it's still open in the
   * background when proposals land, tell them. Permission is only ever
   * requested from the button below (a browser prompt out of nowhere reads
   * as hostile), and the initial value is set post-mount because the server
   * render has no Notification global.
   */
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );
  useEffect(() => {
    if (typeof Notification !== "undefined") setNotifyPerm(Notification.permission);
  }, []);
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = data?.status ?? null;
    if (
      prev === "processing" &&
      data?.status === "proposed" &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      document.visibilityState === "hidden"
    ) {
      const n = new Notification("Your contract is ready to review", {
        body: `We finished reading ${data.filename}. Come back to confirm what we found.`,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  }, [data?.status, data?.filename]);

  // Poll while processing
  useEffect(() => {
    let stop = false;
    async function tick() {
      const res = await apiFetch(`/v1/imports/${id}`);
      const d = (await res.json()) as ImportResponse;
      if (stop) return;
      setData(d);
      if (d.status === "proposed" && d.proposals) {
        const nextParties = buildParties(d.proposals!);
        const nextGroups = buildGroups(d.proposals!);
        const nextSections = buildSections(d.proposals!, d.doc);
        setFields((prev) => {
          if (prev) return prev;
          const built = buildEditable(d.proposals!, d.workspaceDefaults ?? {});
          // Markers nothing claimed become fields too — an unfilled blank
          // prints verbatim and makes the contract unusable.
          return [
            ...built,
            ...(fieldsForUnmappedBlanks(
              d.doc?.paragraphs ?? [],
              built,
              [nextParties, nextGroups, nextSections],
              d.doc?.tables,
            ) as EditableField[]),
          ];
        });
        setParties((prev) => (prev.length ? prev : nextParties));
        setGroups((prev) => (prev.length ? prev : nextGroups));
        setSections((prev) => (prev.length ? prev : nextSections));
        // A revision keeps the template's name — defaulting to the uploaded
        // filename would quietly rename "Storage Rental Agreement" to
        // "storage-rental-v2" on save. Still editable.
        setTemplateName(
          (prev) =>
            prev ||
            d.proposals?.alignment?.priorTemplate.name ||
            d.filename.replace(/\.(docx|pdf)$/i, ""),
        );
      } else if (d.status === "processing") {
        setTimeout(() => void tick(), 3000);
      }
    }
    void tick();
    return () => { stop = true; };
  }, [id]);

  const update = useCallback((key: string, patch: Partial<EditableField>) => {
    setFields((fs) => fs?.map((f) => (f.key === key ? { ...f, ...patch } : f)) ?? null);
  }, []);

  /** AI review (SPEC §3.6) — on demand; findings are accept/reject redlines. */
  async function runReview() {
    setReviewing(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/imports/${id}/review`, { method: "POST" });
      const d = (await res.json()) as {
        findings?: {
          key: string; title: string; severity: "gap" | "risk" | "note";
          explanation: string; confidence: number;
          proposedClause?: { text: string; insertAfterParagraph: number };
        }[];
        error?: unknown;
      };
      if (!res.ok || !d.findings)
        throw new Error(typeof d.error === "string" ? d.error : "review failed");
      setFindings(
        d.findings.map((f) => ({
          accepted: false,
          key: f.key,
          title: f.title,
          severity: f.severity,
          explanation: f.explanation,
          confidence: f.confidence,
          ...(f.proposedClause
            ? {
                clauseText: f.proposedClause.text,
                insertAfterParagraph: f.proposedClause.insertAfterParagraph,
              }
            : {}),
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(false);
    }
  }

  const score = useMemo(() => {
    const accepted = fields?.filter((f) => f.accepted) ?? [];
    // Matches server semantics: platform_bound counts only with an accepted
    // binding; computed only with a formula (unbound fields demote to per_deal);
    // workspace_default only with a valid standing value (new or saved).
    const auto = accepted.filter(
      (f) =>
        (f.source === "platform_bound" && f.binding?.accepted) ||
        (f.source === "computed" && !!f.expression) ||
        ((f.source === "workspace_default" || f.source === "per_deal") &&
          ((!!f.defaultRaw?.trim() && "value" in tryParseInput(f.type, f.defaultRaw)) ||
            (!f.defaultRaw?.trim() && !!f.hasSavedDefault))),
    );
    // Parties and repeating groups become fields too; they have no scalar
    // value yet in Phase 1, so they add to the total but never to auto.
    const structured =
      parties.filter((p) => p.accepted).length +
      groups.filter((g) => g.accepted).length +
      sections.filter((s) => s.accepted).length;
    return { auto: auto.length, total: accepted.length + structured };
  }, [fields, parties, groups, sections]);

  const previews = useMemo(
    () => computeFormulaPreviews(fields ?? [], data?.samplePayload),
    [fields, data?.samplePayload],
  );

  /**
   * Fill-in markers ("[STATE]") that nothing you're about to save will fill.
   * A template's own brackets are the author's list of what varies, so an
   * unclaimed one is a blank that would print literally into a contract.
   * Counts only ACCEPTED items as covering — a rejected proposal leaves its
   * blank genuinely unfilled.
   */
  const missedBlanks = useMemo(() => {
    const paras = data?.doc?.paragraphs ?? [];
    if (paras.length === 0) return [];
    // Accepted only: every marker starts life as a field, so what lands here
    // is what the user switched OFF — a deliberate "that's wording", which is
    // still worth showing because it will print exactly as written.
    return unmappedPlaceholders(
      paras,
      claimedSpans(paras, [fields ?? [], parties, groups, sections], true),
    );
  }, [data?.doc, fields, parties, groups, sections]);

  /**
   * Everything still wanting a human, hoisted to the top of the pane. A 60-page
   * contract yields a field list you have to scroll to audit, and the items
   * that matter look like the ones that don't (SPEC §3.1.5). Each entry jumps
   * to its card, so nothing has to be hunted for.
   */
  const attention = useMemo(
    () =>
      collectAttention({
        fields: fields ?? [],
        sections,
        // Distinct markers, matching the chips rendered below.
        blankCount: new Set(missedBlanks.map((b) => b.text)).size,
      }),
    [fields, parties, groups, sections, missedBlanks],
  );

  /**
   * Which cards are unresolved, and how badly.
   *
   * Derived from `attention` rather than tracked separately, which is the whole
   * trick: collectAttention re-runs on every edit, so a card's outline clears
   * the instant its reason stops being true. Holding a parallel "invalid" set
   * would let the two disagree, and an outline that lingers after a fix is
   * worse than none — it teaches people to ignore it.
   */
  const attentionByCard = useMemo(() => {
    const m = new Map<string, "fix" | "check">();
    for (const a of attention) if (!m.has(a.cardKey)) m.set(a.cardKey, a.tone);
    return m;
  }, [attention]);

  /** The card the bar last jumped to, so "next" advances instead of sticking. */
  const [targetCard, setTargetCard] = useState<string | null>(null);

  /**
   * Why saving is blocked, in the user's words — a disabled primary button
   * with no explanation is indistinguishable from a broken one. Also catches
   * a bad standing value here rather than throwing mid-confirm, where the
   * message used to land off-screen under the sticky footer.
   */
  const saveBlockedReason = useMemo(() => {
    if (!templateName.trim()) return "Give the template a name to save it.";
    if (score.total === 0) return "Accept at least one field to save a template.";
    for (const f of fields ?? []) {
      if (!f.accepted || !f.defaultRaw?.trim()) continue;
      if (f.source !== "workspace_default" && f.source !== "per_deal") continue;
      const parsed = tryParseInput(f.type, f.defaultRaw);
      if ("error" in parsed) return `"${f.label}": ${parsed.error}`;
    }
    return null;
  }, [templateName, score.total, fields]);

  const canSave = saveBlockedReason === null;

  async function confirm() {
    if (!fields) return;
    setConfirming(true);
    setError(null);
    try {
      // A typed-but-invalid standing value blocks confirm — silently dropping
      // it would save a template that quietly asks at send time instead.
      const accepted = fields.filter((f) => f.accepted);
      const defaults = new Map<string, SerializedValue>();
      for (const f of accepted) {
        if (f.source !== "workspace_default" && f.source !== "per_deal") continue;
        if (!f.defaultRaw?.trim()) continue;
        const parsed = tryParseInput(f.type, f.defaultRaw);
        if ("error" in parsed)
          throw new Error(`"${f.label}": ${parsed.error}`);
        defaults.set(f.key, parsed.value);
      }
      const fieldRows = accepted.map((f, i) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        source: f.source,
        ...(f.source === "platform_bound" && f.binding?.accepted
          ? { bindingPath: f.binding.path }
          : {}),
        ...(f.source === "computed" && f.expression
          ? { expression: f.expression }
          : {}),
        ...(defaults.has(f.key) ? { defaultValue: defaults.get(f.key) } : {}),
        occurrences: f.occurrences,
        required: true,
        config: {} as Record<string, unknown>,
        position: i,
      }));

      // Parties and repeating groups persist as fields of their own type,
      // structure in config. Guard against key collisions with plain fields.
      const usedKeys = new Set(fieldRows.map((f) => f.key));
      const uniqueKey = (key: string, suffix: string) => {
        const k = usedKeys.has(key) ? `${key}_${suffix}` : key;
        usedKeys.add(k);
        return k;
      };
      let position = fieldRows.length;
      for (const p of parties.filter((p) => p.accepted)) {
        fieldRows.push({
          key: uniqueKey(p.key, "party"),
          label: p.roleLabel,
          type: "party",
          // The sender is the business's own standing identity; the other
          // side arrives per contract.
          source: p.isSender ? "workspace_default" : "per_deal",
          occurrences: p.occurrences,
          required: true,
          config: { isSender: p.isSender },
          position: position++,
        });
      }
      for (const g of groups.filter((g) => g.accepted)) {
        fieldRows.push({
          key: uniqueKey(g.key, "table"),
          label: g.label,
          type: "repeating_group",
          source: "per_deal",
          occurrences: g.occurrences,
          required: true,
          config: { columns: g.columns },
          position: position++,
        });
      }
      // Conditional sections carry their paragraph extent in config; no
      // spans — the section's text is never REPLACED, only kept or removed.
      for (const s of sections.filter((s) => s.accepted)) {
        fieldRows.push({
          key: uniqueKey(s.key, "section"),
          label: s.label,
          type: "text",
          source: "conditional",
          ...(s.expression.trim() ? { expression: s.expression.trim() } : {}),
          occurrences: [],
          required: false,
          config: { paragraphIndexes: s.paragraphIndexes },
          position: position++,
        });
      }

      const acceptedClauses = (findings ?? [])
        .filter((f) => f.accepted && f.clauseText?.trim())
        .map((f) => ({
          key: f.key,
          text: f.clauseText!.trim(),
          insertAfterParagraph: f.insertAfterParagraph ?? 0,
        }));

      const body = { templateName, fields: fieldRows, acceptedClauses };
      const res = await apiFetch(`/v1/imports/${id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as {
        autoFillCount?: number; fieldCount?: number; demotedBindings?: string[];
        templateVersionId?: string; error?: unknown;
      };
      if (!res.ok) throw new Error(typeof d.error === "string" ? d.error : "confirm failed");
      setResult({
        autoFillCount: d.autoFillCount ?? 0,
        fieldCount: d.fieldCount ?? 0,
        demotedBindings: d.demotedBindings ?? [],
        templateVersionId: d.templateVersionId ?? null,
      });
      onConfirmed?.({ autoFillCount: d.autoFillCount ?? 0, fieldCount: d.fieldCount ?? 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  }

  if (!data) return <p><span className="spinner" />Loading…</p>;
  if (data.status === "failed")
    return <p className="error">Import failed: {data.error}</p>;
  if (data.status === "confirmed" && !result)
    return (
      <div className="success" style={{ maxWidth: 560 }}>
        <h1>Already saved</h1>
        <p>This contract has been confirmed as a template.</p>
      </div>
    );
  if (data.status === "processing") {
    // The document itself parsed at upload — show it right away and let the
    // AI pass finish behind this banner. The wait feels like reading, not
    // like a broken page.
    return (
      <>
        <h1>Reading your contract…</h1>
        <div className="card processing-note" style={{ maxWidth: 720 }}>
          <p style={{ margin: 0 }}>
            <span className="spinner" />
            Finding everything that changes from client to client — usually a
            minute or two.
          </p>
          <p className="sub" style={{ margin: "6px 0 0" }}>
            You don&apos;t have to wait here. Leave or close this page and
            we&apos;ll keep working — it&apos;ll be ready to review when you
            come back.
          </p>
          {notifyPerm === "default" && (
            <button
              style={{ marginTop: 10 }}
              onClick={() =>
                void Notification.requestPermission().then(setNotifyPerm)
              }
            >
              Notify me when it&apos;s ready
            </button>
          )}
          {notifyPerm === "granted" && (
            <p className="sub" style={{ margin: "6px 0 0" }}>
              We&apos;ll send a notification when it&apos;s ready.
            </p>
          )}
          {/* Say it before the setup work, not after — a PDF gets all the
              way through review and then can't be sent. */}
          {/\.pdf$/i.test(data.filename) && (
            <p className="notice" style={{ marginTop: 10, marginBottom: 0 }}>
              <strong>Heads up:</strong> we fill PDFs by writing values into
              the page, which can&apos;t reflow text the way a Word file can.
              If you have the <code>.docx</code>, it fills more faithfully.
            </p>
          )}
        </div>
        {data.doc && (
          <div className="docpane-host processing-doc">
            <DocumentPane
              paragraphs={data.doc.paragraphs}
              tables={data.doc.tables ?? []}
              {...(data.doc.defaults ? { defaults: data.doc.defaults } : {})}
              {...(data.doc.header ? { header: data.doc.header } : {})}
              marks={[]}
              active={null}
            />
          </div>
        )}
      </>
    );
  }

  if (result)
    return (
      <div className="success" style={{ maxWidth: 560 }}>
        <h1>Template saved 🎉</h1>
        <p>
          <strong>{result.autoFillCount} of {result.fieldCount}</strong> fields will
          fill automatically on every contract you send.
        </p>
        {result.demotedBindings.length > 0 && (
          <p className="sub">
            {result.demotedBindings.join(", ")}: the data connection didn&apos;t match
            your platform&apos;s data, so you&apos;ll be asked for
            {result.demotedBindings.length === 1 ? " this value" : " these values"} on
            each contract instead.
          </p>
        )}
        {result.templateVersionId && (
          <ReadinessCard versionId={result.templateVersionId} />
        )}
        <button onClick={onRestart}>Import another contract</button>
      </div>
    );

  const doc = data.doc;
  if (!doc || !fields) return null;

  const highlightables: Highlightable[] = [...fields, ...parties, ...groups, ...sections];
  const scrollTo = (h: Highlightable) => {
    setActive(h.key);
    const first = h.occurrences[0];
    if (first !== undefined) {
      docRef.current
        ?.querySelector(`[data-para="${first.paragraphIndex}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  /**
   * Jump from an attention entry to the card it names — the fields pane scrolls
   * to the card, and the document pane follows to the matching passage so the
   * user sees the wording they're deciding about.
   */
  const focusCard = (cardKey: string) => {
    setActive(cardKey);
    paneRef.current
      ?.querySelector(`[data-card="${cardKey}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    const target = highlightables.find((h) => h.key === cardKey);
    if (target) scrollTo(target);
  };

  /**
   * Jump to the next thing still needing a decision.
   *
   * Order, wrapping, and what happens to a card that was fixed mid-pass all
   * live in nextAttentionCard, which is pure and unit-tested.
   */
  const fixNext = () => {
    const next = nextAttentionCard(attention, targetCard);
    if (!next) return;
    setTargetCard(next);
    focusCard(next);
  };

  const fixCount = attention.filter((a) => a.tone === "fix").length;

  /**
   * Clicking a highlight in the contract brings its card into view — the
   * inverse of focusCard. The document does NOT scroll: the user just chose
   * that spot, and moving the text under their click reads as the page
   * jumping away.
   */
  const pickFromDocument = (key: string) => {
    setActive(key);
    paneRef.current
      ?.querySelector(`[data-card="${key}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <>
      <h1>{alignment ? "Review what changed" : "Review your contract"}</h1>
      <p className="sub">
        {alignment ? (
          <>
            Matched against <strong>{alignment.priorTemplate.name}</strong> version{" "}
            {alignment.priorTemplate.version}. Saving makes this version{" "}
            {alignment.priorTemplate.version + 1} of the same template — your presets
            and your send history stay with it.
          </>
        ) : (
          <>
            We highlighted everything that changes per client. Confirm, rename, or
            turn off anything we got wrong — nothing is saved until you confirm.
          </>
        )}
      </p>
      {data?.proposals?.piiScan && (
        <p className="notice" style={{ maxWidth: 720 }}>
          <strong>This looks like a filled-in contract, not a blank template.</strong>{" "}
          It contains what appear to be real identifiers
          {data.proposals.piiScan.ssnLike > 0 && " (Social Security numbers)"}
          {data.proposals.piiScan.einLike > 0 && " (EINs)"}
          {data.proposals.piiScan.cardLike > 0 && " (card numbers)"}. If you have
          the blank version your clients actually start from, upload that instead —
          the saved template shouldn&apos;t carry anyone&apos;s personal details.
        </p>
      )}
      <div className="review">
        {/* Same renderer as the send panel's pane, so the document looks the
            same wherever you meet it — including the paragraph formatting
            carried over from the DOCX. This screen scrolls the document
            itself, in step with the field cards, so it opts out of the pane's
            own scrolling. */}
        <div ref={docRef} className="docpane-host">
          <DocumentPane
            paragraphs={doc.paragraphs}
            tables={doc.tables ?? []}
            {...(doc.defaults ? { defaults: doc.defaults } : {})}
            {...(doc.header ? { header: doc.header } : {})}
            // Traffic-light state rides on each mark: the attention tone when
            // the card has one, green otherwise — derived, so a highlight
            // turns green the instant its reason is fixed.
            marks={highlightables
              .filter((h) => h.accepted)
              .map((h) => ({ ...h, status: attentionByCard.get(h.key) ?? ("good" as const) }))}
            active={active}
            onPick={pickFromDocument}
            scrollOnActive={false}
          />
        </div>

        <div className="fieldspane" ref={paneRef}>
          {/* Score and bar share one sticky container — two siblings both
              pinned to top:0 would sit on top of each other. */}
          <div className="panehead">
            <div className="score">
              {score.auto} of {score.total} fields fill automatically
            </div>

            {attention.length > 0 && (
              <div className="fixbar">
                <span className="fixbar-count">
                  {fixCount > 0
                    ? `${fixCount} ${fixCount === 1 ? "thing" : "things"} to fix`
                    : `${attention.length} to check`}
                  {fixCount > 0 && attention.length > fixCount && (
                    <span className="fixbar-rest">
                      {" "}· {attention.length - fixCount} to check
                    </span>
                  )}
                </span>
                <button type="button" className="primary" onClick={fixNext}>
                  Fix next one
                </button>
              </div>
            )}
          </div>

          {attention.length > 0 && (
            <div className="attention">
              <div className="attention-head">
                {attention.length === 1
                  ? "1 thing needs your attention"
                  : `${attention.length} things need your attention`}
              </div>
              <ul className="attention-list">
                {(showAllAttention ? attention : attention.slice(0, 5)).map((a) => (
                  <li key={`${a.cardKey}:${a.reason}`}>
                    <button
                      type="button"
                      className={`attention-item ${a.tone}`}
                      onClick={() => focusCard(a.cardKey)}
                    >
                      <span className="attention-label">{a.label}</span>
                      <span className="attention-reason">{a.reason}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {attention.length > 5 && (
                <button
                  type="button"
                  className="attention-more"
                  onClick={() => setShowAllAttention((v) => !v)}
                >
                  {showAllAttention
                    ? "Show fewer"
                    : `Show all ${attention.length}`}
                </button>
              )}
            </div>
          )}

          {alignment && alignment.result.proseChanges.length > 0 && (
            <div className="rev-prose">
              <div className="section-title">What changed in the contract</div>
              <p className="rev-hint">
                Changes to the legal language itself, separate from the fields.
              </p>
              <ul>
                {alignment.result.proseChanges.map((c) => (
                  <li
                    key={`${c.paragraphIndex}-${c.kind}`}
                    className={`rev-change rev-${c.severity}`}
                  >
                    <span className="rev-chip">{c.kind}</span>
                    <span className="rev-sev">{c.severity}</span>
                    <span>{c.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {parties.length > 0 && (
            <>
              <div className="section-title">Who signs</div>
              {parties.map((p) => (
                <PartyCard
                  key={p.key}
                  party={p}
                  status={attentionByCard.get(p.key) ?? (p.accepted ? "good" : undefined)}
                  isTarget={targetCard === p.key}
                  isActive={active === p.key}
                  onSelect={() => scrollTo(p)}
                  onChange={(patch) =>
                    setParties((ps) =>
                      ps.map((x) =>
                        x.key === p.key
                          ? { ...x, ...patch }
                          : // Only one sender: picking a new one unpicks the rest.
                            patch.isSender
                            ? { ...x, isSender: false }
                            : x,
                      ),
                    )
                  }
                />
              ))}
            </>
          )}

          {(() => {
            const card = (f: EditableField) => (
              <FieldCard
                key={f.key}
                field={f}
                status={attentionByCard.get(f.key) ?? (f.accepted ? "good" : undefined)}
                isTarget={targetCard === f.key}
                preview={previews[f.key]}
                isActive={active === f.key}
                onSelect={() => scrollTo(f)}
                onChange={(patch) => update(f.key, patch)}
                allFields={fields.map((x) => ({ key: x.key, label: x.label, type: x.type }))}
                samplePayload={data?.samplePayload}
              />
            );

            // A cold import is one flat list. A revision is three, because the
            // groups want different amounts of attention: what carried needs
            // none, what moved needs a look, what's new needs the full review a
            // first import gets.
            if (!alignment) {
              return (
                <>
                  <div className="section-title">Detected fields</div>
                  {fields.map(card)}
                </>
              );
            }

            const carried = fields.filter((f) => f.revision === "carried");
            const moved = fields.filter((f) => f.revision === "moved");
            const fresh = fields.filter(
              (f) => f.revision !== "carried" && f.revision !== "moved",
            );
            return (
              <>
                {carried.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="section-title rev-toggle"
                      onClick={() => setShowCarried((v) => !v)}
                    >
                      Carried forward ({carried.length}){" "}
                      <span className="rev-caret">{showCarried ? "▾" : "▸"}</span>
                    </button>
                    {!showCarried && (
                      <p className="rev-hint">
                        Already set up on version {alignment.priorTemplate.version} and
                        unchanged here — nothing to do.
                      </p>
                    )}
                    {showCarried && carried.map(card)}
                  </>
                )}
                {moved.length > 0 && (
                  <>
                    <div className="section-title">Moved or changed ({moved.length})</div>
                    <p className="rev-hint">
                      Still in the contract, but the wording around them changed. Worth a
                      look before you save.
                    </p>
                    {moved.map(card)}
                  </>
                )}
                {fresh.length > 0 && (
                  <>
                    <div className="section-title">New in this version ({fresh.length})</div>
                    {fresh.map(card)}
                  </>
                )}
              </>
            );
          })()}

          {groups.length > 0 && (
            <>
              <div className="section-title">Repeating tables</div>
              {groups.map((g) => (
                <GroupCard
                  key={g.key}
                  group={g}
                  status={attentionByCard.get(g.key) ?? (g.accepted ? "good" : undefined)}
                  isTarget={targetCard === g.key}
                  isActive={active === g.key}
                  onSelect={() => scrollTo(g)}
                  onChange={(patch) =>
                    setGroups((gs) =>
                      gs.map((x) => (x.key === g.key ? { ...x, ...patch } : x)),
                    )
                  }
                />
              ))}
            </>
          )}

          {sections.length > 0 && (
            <>
              <div className="section-title">Sections that don&apos;t always apply</div>
              {sections.map((s) => (
                <SectionCard
                  key={s.key}
                  section={s}
                  status={attentionByCard.get(s.key) ?? (s.accepted ? "good" : undefined)}
                  isTarget={targetCard === s.key}
                  isActive={active === s.key}
                  onSelect={() => scrollTo(s)}
                  onChange={(patch) =>
                    setSections((ss) =>
                      ss.map((x) => (x.key === s.key ? { ...x, ...patch } : x)),
                    )
                  }
                />
              ))}
            </>
          )}

          {missedBlanks.length > 0 && (
            <div
              data-card={BLANKS_CARD}
              data-status={attentionByCard.get(BLANKS_CARD)}
              className={targetCard === BLANKS_CARD ? "targeted" : undefined}
            >
              <div className="section-title" style={{ marginTop: 16 }}>
                Blanks you&apos;re leaving as-is
                <span className="sub" style={{ margin: 0, fontWeight: 400, textTransform: "none" }}>
                  {" "}— {missedBlanks.length} will print exactly as written
                </span>
              </div>
              <div className="notice">
                Every fill-in marker in your document became a field above.
                These are the ones you switched off, so they&apos;ll appear in
                the contract literally — fine if they&apos;re part of the
                wording, a problem if someone was meant to fill them in.
                <div className="blanklist">
                  {[...new Map(missedBlanks.map((b) => [b.text, b])).values()].map((b) => {
                    // Every marker has a card; this one is switched off. Send
                    // them to it rather than making a second field for it.
                    const owner = fieldOwningBlank(
                      data?.doc?.paragraphs ?? [],
                      fields ?? [],
                      b,
                    );
                    return (
                      <div className="blankrow" key={`${b.text}-${b.paragraphIndex}`}>
                        <button
                          className="chip"
                          title={`Show paragraph ${b.paragraphIndex + 1}`}
                          onClick={() => setActive(`para-${b.paragraphIndex}`)}
                        >
                          {b.text}
                        </button>
                        {owner && (
                          <button
                            className="linkish"
                            title="Go to its field and switch it back on"
                            onClick={() => focusCard(owner.key)}
                          >
                            turn its field back on
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div className="section-title" style={{ marginTop: 16 }}>Contract check-up</div>
          {findings === null ? (
            <div className="fieldcard off">
              <div className="row">
                <button disabled={reviewing} onClick={() => void runReview()}>
                  {reviewing ? "Reviewing…" : "Check for gaps & risks"}
                </button>
                <span className="sub-inline">
                  Flags missing protections and proposes clauses you can accept
                  or ignore. Automated suggestions — not legal advice.
                </span>
              </div>
            </div>
          ) : findings.length === 0 ? (
            <p className="sub">No gaps flagged. Still worth a pass by your attorney.</p>
          ) : (
            <>
              {findings.map((f) => (
                <FindingCard
                  key={f.key}
                  finding={f}
                  onChange={(patch) =>
                    setFindings((fs) =>
                      fs?.map((x) => (x.key === f.key ? { ...x, ...patch } : x)) ?? null,
                    )
                  }
                />
              ))}
              <p className="sub" style={{ fontSize: 12 }}>
                Automated suggestions, not legal advice — have your attorney
                review anything you accept.
              </p>
            </>
          )}

          {/* Messages live INSIDE the sticky bar. The bar pins to the viewport,
              so the button can be pressed from any scroll position — anything
              rendered outside it sits thousands of pixels away at the document
              end, and a failed save reads as the button doing nothing. */}
          <div className="footerbar">
            {error && (
              <p className="error" role="alert">
                Couldn&apos;t save: {error}
              </p>
            )}
            {/* A disabled button with no explanation is the same dead end. */}
            {!error && saveBlockedReason && (
              <p className="blocked">{saveBlockedReason}</p>
            )}
            <div className="footerbar-row">
              <input
                className="expr"
                style={{ flex: 1, fontFamily: "inherit" }}
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Template name"
              />
              <button
                className="primary"
                disabled={confirming || !canSave}
                onClick={() => void confirm()}
                {...(saveBlockedReason ? { title: saveBlockedReason } : {})}
              >
                {confirming ? "Saving…" : `Save template (${score.total} fields)`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function PartyCard({
  party: p, status, isTarget, isActive, onSelect, onChange,
}: {
  party: EditableParty;
  status: "fix" | "check" | "good" | undefined;
  isTarget: boolean;
  isActive: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<EditableParty>) => void;
}) {
  return (
    <div
      className={`fieldcard ${p.accepted ? "" : "off"} ${isActive ? "active" : ""} ${isTarget ? "targeted" : ""}`}
      data-card={p.key}
      data-status={status}
      onClick={onSelect}
    >
      <div className="row">
        <input
          type="checkbox"
          checked={p.accepted}
          onChange={(e) => onChange({ accepted: e.target.checked })}
          onClick={(e) => e.stopPropagation()}
        />
        <input
          className="label-input"
          value={p.roleLabel}
          onChange={(e) => onChange({ roleLabel: e.target.value })}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="conf">
          {p.confidence < ACCEPT_THRESHOLD ? <span className="lowconf">suggestion </span> : null}
          {Math.round(p.confidence * 100)}%
        </span>
      </div>
      <div className="meta">
        <label className="sender-toggle" onClick={(e) => e.stopPropagation()}>
          <input
            type="radio"
            name="sender-party"
            checked={p.isSender}
            onChange={() => onChange({ isSender: true })}
          />
          {" "}this is you (the sender)
        </label>
      </div>
    </div>
  );
}

function GroupCard({
  group: g, status, isTarget, isActive, onSelect, onChange,
}: {
  group: EditableGroup;
  status: "fix" | "check" | "good" | undefined;
  isTarget: boolean;
  isActive: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<EditableGroup>) => void;
}) {
  return (
    <div
      className={`fieldcard ${g.accepted ? "" : "off"} ${isActive ? "active" : ""} ${isTarget ? "targeted" : ""}`}
      data-card={g.key}
      data-status={status}
      onClick={onSelect}
    >
      <div className="row">
        <input
          type="checkbox"
          checked={g.accepted}
          onChange={(e) => onChange({ accepted: e.target.checked })}
          onClick={(e) => e.stopPropagation()}
        />
        <input
          className="label-input"
          value={g.label}
          onChange={(e) => onChange({ label: e.target.value })}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="conf">
          {g.confidence < ACCEPT_THRESHOLD ? <span className="lowconf">suggestion </span> : null}
          {Math.round(g.confidence * 100)}%
        </span>
      </div>
      <div className="meta">
        <span className="columns">
          {g.columns.map((c) => `${c.label} (${c.type.replace("_", " ")})`).join(" · ")}
        </span>
      </div>
      <div className="rationale" style={{ display: isActive ? "block" : "none" }}>
        A table whose rows repeat per contract — you&apos;ll fill the rows when sending.
      </div>
    </div>
  );
}

const SEVERITY_LABEL: Record<EditableFinding["severity"], string> = {
  gap: "missing",
  risk: "risky",
  note: "note",
};

function FindingCard({
  finding: f, onChange,
}: {
  finding: EditableFinding;
  onChange: (patch: Partial<EditableFinding>) => void;
}) {
  const hasClause = f.clauseText !== undefined;
  return (
    <div className={`fieldcard ${f.accepted ? "" : "off"}`}>
      <div className="row">
        {hasClause ? (
          <input
            type="checkbox"
            checked={f.accepted}
            onChange={(e) => onChange({ accepted: e.target.checked })}
          />
        ) : (
          <span style={{ width: 13 }} />
        )}
        <strong style={{ fontSize: 13.5 }}>{f.title}</strong>
        <span className="conf">
          <span className="lowconf">{SEVERITY_LABEL[f.severity]} </span>
          {Math.round(f.confidence * 100)}%
        </span>
      </div>
      <div className="meta">
        <span className="columns">{f.explanation}</span>
      </div>
      {hasClause && (
        <div className="meta">
          {f.accepted ? (
            <textarea
              className="expr"
              style={{ width: "100%", minHeight: 72, fontFamily: "inherit", fontSize: 12.5 }}
              value={f.clauseText}
              onChange={(e) => onChange({ clauseText: e.target.value })}
            />
          ) : (
            <div
              className="columns"
              style={{
                borderLeft: "3px solid var(--cv-good, #067647)",
                paddingLeft: 8,
                whiteSpace: "pre-wrap",
                fontSize: 12.5,
              }}
            >
              {f.clauseText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionCard({
  section: s, status, isTarget, isActive, onSelect, onChange,
}: {
  section: EditableSection;
  status: "fix" | "check" | "good" | undefined;
  isTarget: boolean;
  isActive: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<EditableSection>) => void;
}) {
  return (
    <div
      className={`fieldcard ${s.accepted ? "" : "off"} ${isActive ? "active" : ""} ${isTarget ? "targeted" : ""}`}
      data-card={s.key}
      data-status={status}
      onClick={onSelect}
    >
      <div className="row">
        <input
          type="checkbox"
          checked={s.accepted}
          onChange={(e) => onChange({ accepted: e.target.checked })}
          onClick={(e) => e.stopPropagation()}
        />
        <input
          className="label-input"
          value={s.label}
          onChange={(e) => onChange({ label: e.target.value })}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="conf">
          <span className="lowconf">suggestion </span>
          {Math.round(s.confidence * 100)}%
        </span>
      </div>
      <div className="meta">
        <span className="columns">
          {s.paragraphIndexes.length} paragraph
          {s.paragraphIndexes.length === 1 ? "" : "s"} — {s.conditionDescription}
        </span>
      </div>
      {s.accepted && (
        <div className="meta" onClick={(e) => e.stopPropagation()}>
          <input
            className="expr"
            style={{ width: "100%" }}
            value={s.expression}
            placeholder='when does it apply? e.g. deposit > $0'
            onChange={(e) => onChange({ expression: e.target.value })}
          />
        </div>
      )}
      <div className="rationale" style={{ display: isActive ? "block" : "none" }}>
        These paragraphs stay in the contract when the condition is true and
        are removed when it&apos;s false. Leave the condition blank to keep
        them always (you&apos;ll get a reminder at send time).
      </div>
    </div>
  );
}


/**
 * Plain-English formula editing (AI-PIPELINE `translateFormula`): "make the
 * deposit a third" → a real expression, validated server-side, dropped into
 * the formula input where the live preview shows what it computes. The user
 * still confirms — this only types for them.
 */
function FormulaInPlainEnglish({
  field: f, allFields, onChange,
}: {
  field: EditableField;
  allFields: { key: string; label: string; type: string }[];
  onChange: (patch: Partial<EditableField>) => void;
}) {
  const { apiFetch } = useConovo();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function translate() {
    if (!instruction.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch(`/v1/formulas/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instruction: instruction.trim(),
          field: { key: f.key, label: f.label },
          ...(f.expression ? { currentExpression: f.expression } : {}),
          fields: allFields,
        }),
      });
      const d = (await res.json()) as {
        expression?: string; explanation?: string; error?: unknown;
      };
      if (!res.ok || !d.expression)
        throw new Error(typeof d.error === "string" ? d.error : "couldn't translate");
      onChange({ expression: d.expression });
      setNote(d.explanation ?? null);
      setInstruction("");
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
        <input
          className="expr"
          style={{ flex: 1, fontFamily: "inherit", fontSize: 12.5 }}
          value={instruction}
          placeholder='or describe it: "make the deposit a third"'
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void translate(); }}
        />
        <button style={{ fontSize: 12 }} disabled={busy || !instruction.trim()} onClick={() => void translate()}>
          {busy ? "…" : "Go"}
        </button>
      </div>
      {note && <span className="sub-inline" style={{ fontSize: 12 }}>{note}</span>}
    </>
  );
}

function FieldCard({
  field: f, status, isTarget, preview, isActive, onSelect, onChange, allFields,
  samplePayload,
}: {
  field: EditableField;
  status: "fix" | "check" | "good" | undefined;
  isTarget: boolean;
  preview: FormulaPreview | undefined;
  isActive: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<EditableField>) => void;
  allFields: { key: string; label: string; type: string }[];
  /** The platform's registered sample, for previewing what a binding fills. */
  samplePayload: unknown;
}) {
  const bindingSample =
    f.binding && f.binding.accepted
      ? bindingPreview(f.type, f.binding.path, samplePayload)
      : null;
  return (
    <div
      className={`fieldcard ${f.accepted ? "" : "off"} ${isActive ? "active" : ""} ${isTarget ? "targeted" : ""}`}
      data-card={f.key}
      data-status={status}
      onClick={onSelect}
    >
      <div className="row">
        <input
          type="checkbox"
          checked={f.accepted}
          onChange={(e) => onChange({ accepted: e.target.checked })}
          onClick={(e) => e.stopPropagation()}
        />
        <input
          className="label-input"
          value={f.label}
          onChange={(e) => onChange({ label: e.target.value })}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="conf">
          {f.confidence < ACCEPT_THRESHOLD ? (
            <span className="lowconf">suggestion </span>
          ) : null}
          {Math.round(f.confidence * 100)}%
        </span>
      </div>

      <div className="meta">
        <select
          value={f.type}
          onChange={(e) => onChange({ type: e.target.value as FieldType })}
          onClick={(e) => e.stopPropagation()}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>{t.replace("_", " ")}</option>
          ))}
        </select>
        <select
          value={f.source}
          onChange={(e) => {
            const source = e.target.value as FieldSource;
            onChange({
              source,
              // First switch to "standing terms": offer the document's own
              // text as the value — it's usually exactly that, UNLESS it's a
              // fill-in marker, which becomes a hint rather than a value.
              ...(source === "workspace_default" && f.defaultRaw === undefined
                ? isPlaceholderText(f.occurrences[0]?.snippet ?? "")
                  ? { defaultHint: f.occurrences[0]?.snippet ?? "" }
                  : { defaultRaw: f.occurrences[0]?.snippet ?? "" }
                : {}),
            });
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {FIELD_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Per-deal fields take an OPTIONAL default: the send panel pre-fills
          it (and automation uses it) while a per-contract edit still wins —
          SPEC §3.3 puts workspace defaults above per-deal input. */}
      {(f.source === "workspace_default" || f.source === "per_deal") && (
        <DefaultValueInput field={f} onChange={onChange} />
      )}

      {f.binding && (
        <div
          className={`binding ${f.binding.accepted ? "" : "rejected"}`}
          onClick={(e) => {
            e.stopPropagation();
            const accepted = !f.binding!.accepted;
            onChange({
              binding: { ...f.binding!, accepted },
              source: accepted ? "platform_bound" : "per_deal",
            });
          }}
          title="Click to toggle"
        >
          {f.binding.accepted ? "✓" : "✗"} Filled from your data: {f.binding.path}
          {/* The VALUE, not just the path — a wrong mapping looks fine as a
              path and obvious as a value (SPEC §3.4.6 companion). */}
          {bindingSample !== null && (
            <span className="binding-sample">
              {" "}→ {bindingSample}
            </span>
          )}
        </div>
      )}

      {f.source === "computed" && (
        <div className="meta" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <input
            className="expr"
            value={f.expression ?? ""}
            placeholder="formula, e.g. 50% * total_fee"
            onChange={(e) => onChange({ expression: e.target.value })}
            onClick={(e) => e.stopPropagation()}
          />
          <FormulaInPlainEnglish field={f} allFields={allFields} onChange={onChange} />
          {preview &&
            ("ok" in preview ? (
              <span className="preview-ok">
                = {preview.ok} <span className="sub-inline">using this document&apos;s values</span>
              </span>
            ) : (
              <span className="preview-err">{preview.error}</span>
            ))}
        </div>
      )}

      {isActive && <div className="rationale">{f.rationale}</div>}
    </div>
  );
}

function DefaultValueInput({
  field: f, onChange,
}: {
  field: EditableField;
  onChange: (patch: Partial<EditableField>) => void;
}) {
  const raw = f.defaultRaw ?? "";
  const parsed = raw.trim() ? tryParseInput(f.type, raw) : null;
  // Only complain about a value that's actually going to be saved. A red error
  // on a card the user has switched off is an error they can't clear.
  const invalid = f.accepted && parsed !== null && "error" in parsed;
  // On a per-deal field the value is a FALLBACK — the send panel pre-fills it
  // and a per-contract edit outranks it — so the copy must not promise
  // "asked every time" or read as required.
  const perDeal = f.source === "per_deal";
  return (
    <div className="meta" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <input
        className="expr"
        value={raw}
        placeholder={
          // The document's own marker is the best hint we have about what
          // belongs here — show it, never save it.
          f.defaultHint
            ? `${perDeal ? "default" : "your standing value"} for ${f.defaultHint}${perDeal ? " (optional)" : ""}`
            : f.type === "date"
              ? `${perDeal ? "default (optional)" : "your standing value"}, e.g. 2026-08-03`
              : perDeal
                ? "default (optional) — you can change it per contract"
                : "your standing value"
        }
        onChange={(e) => onChange({ defaultRaw: e.target.value })}
        onClick={(e) => e.stopPropagation()}
      />
      {invalid ? (
        <span className="error" style={{ fontSize: 12 }}>{parsed.error}</span>
      ) : (
        <span className="sub" style={{ fontSize: 12 }}>
          {raw.trim()
            ? perDeal
              ? "Pre-fills every contract — change it per deal whenever you need."
              : "Saved once — fills in automatically on every contract."
            : f.hasSavedDefault
              ? "Using your saved standing value."
              : perDeal
                ? "No default — you'll be asked on every contract."
                : "No value yet — you can set it later in Standing terms."}
        </span>
      )}
    </div>
  );
}
