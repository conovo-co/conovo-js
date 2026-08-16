"use client";

import { useCallback, useEffect, useState } from "react";
import type { FieldType, SerializedValue, ValidationIssue } from "@conovo/core";
import { editStringForValue, tryParseInput } from "./values.js";
import { WhereItGoes, type Excerpt } from "./WhereItGoes.js";
import {
  DocumentPane,
  type DocDefaults,
  type DocParagraph,
  type DocTable,
  type Marked,
} from "./DocumentPane.js";
import { LockedGate, useConovo } from "./context.js";

/**
 * The host platform's project page with the embedded send flow (SPEC §3.4):
 * pick template → resolver fills everything it can → per-deal panel shows
 * ONLY what's left → generate → validation gate → draft PDF (or
 * needs-attention with plain-English issues).
 */

interface TemplateOption {
  templateId: string;
  name: string;
  versionId: string;
  reviewedSendCount: number;
  autoSendEligible: boolean;
  autoSendUnlockAt: number;
  /** False for PDF-sourced templates — set up fine, can't be filled. */
  canGenerate?: boolean;
}

interface GroupSpec {
  key: string;
  label: string;
  required: boolean;
  columns: { key: string; label: string; type: FieldType }[];
  rowCount: number;
}

interface ResolvedRow {
  label: string;
  type: string;
  display: string;
  provenance: string;
  context?: Excerpt;
}

interface Prepared {
  templateName: string;
  resolved: Record<string, ResolvedRow>;
  unresolved: {
    key: string;
    label: string;
    required: boolean;
    reason: string;
    type: string;
    context?: Excerpt;
  }[];
  groups: GroupSpec[];
  parties: { key: string; label: string; isSender: boolean }[];
  issues: ValidationIssue[];
  blocked: boolean;
  /**
   * This workspace's own most-used answer per still-open field, with how
   * many contracts used it — "You've used $95.00 on 6 contracts". History,
   * never a model's guess.
   */
  usuals?: Record<string, { value: SerializedValue; count: number; display: string }>;
  /**
   * "This doesn't look like your usual" (SPEC §3.4.6) — advisory only. The
   * value is filled and the send is allowed; this just puts the workspace's
   * own history next to a value that stands out, which is the only way a
   * mis-mapped field gets noticed before it's signed.
   */
  deviations?: {
    fieldKey: string;
    kind: "amount" | "different";
    usualDisplay: string;
    usualCount: number;
    deviations?: number;
  }[];
}

/** One signature-request row; order in the list = signing order. */
interface RecipientRow {
  role: string;
  label: string;
  name: string;
  email: string;
  /** Optional mobile — adds SMS identity verification before signing. */
  phone: string;
}

const rowsForTemplate = (
  parties: Prepared["parties"],
  defaultRecipient: SendContractRecipient,
): RecipientRow[] => {
  const counterparties = parties.filter((p) => !p.isSender);
  if (counterparties.length === 0)
    return [{
      role: defaultRecipient.role ?? "client",
      label: "Recipient",
      name: defaultRecipient.name,
      email: defaultRecipient.email,
      phone: defaultRecipient.phone ?? "",
    }];
  // First counterparty prefills from the host's record; the rest are typed.
  return counterparties.map((p, i) => ({
    role: p.key,
    label: p.label,
    name: i === 0 ? defaultRecipient.name : "",
    email: i === 0 ? defaultRecipient.email : "",
    phone: i === 0 ? (defaultRecipient.phone ?? "") : "",
  }));
};

const rowsComplete = (rows: RecipientRow[]) =>
  rows.length > 0 && rows.every((r) => r.name.trim() && r.email.trim());

/** Raw table-editor state: rows of colKey → what the user typed. */
type GroupRaw = Record<string, Record<string, string>[]>;

function serializeGroupRows(
  groups: GroupSpec[],
  raw: GroupRaw,
): Record<string, Record<string, SerializedValue>[]> {
  const out: Record<string, Record<string, SerializedValue>[]> = {};
  for (const g of groups) {
    const rows = (raw[g.key] ?? [])
      .map((row) => {
        const cells: Record<string, SerializedValue> = {};
        for (const col of g.columns) {
          const v = row[col.key];
          if (!v?.trim()) continue;
          const parsed = tryParseInput(col.type, v);
          if ("value" in parsed) cells[col.key] = parsed.value;
        }
        return cells;
      })
      .filter((cells) => Object.keys(cells).length > 0);
    if (rows.length > 0) out[g.key] = rows;
  }
  return out;
}

interface GenerateResult {
  contractId: string;
  status: string;
  issues: ValidationIssue[];
  /** The account runs the advisory check — flags arrive after generation. */
  advisoryPending?: boolean;
}

/**
 * A flag from the send-time anomaly check (AI-PIPELINE `anomalyCheck`).
 *
 * Kept apart from ValidationIssue everywhere, in the type and on screen. An
 * issue is the deterministic validator saying this contract cannot go out; a
 * flag is a model saying it looks odd. Rendering them alike would teach people
 * to dismiss both.
 */
interface AdvisoryFlag {
  fieldKey?: string;
  message: string;
  confidence: number;
}

function GroupRowsEditor({
  group: g, rows, onChange,
}: {
  group: GroupSpec;
  rows: Record<string, string>[];
  onChange: (rows: Record<string, string>[]) => void;
}) {
  const setCell = (i: number, col: string, v: string) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [col]: v } : r)));

  return (
    <div style={{ marginTop: 16 }}>
      <div className="section-title">
        {g.label}
        {g.required && rows.length === 0 && (
          <span className="error" style={{ fontWeight: 400 }}> · add at least one row</span>
        )}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {g.columns.map((c) => (
              <th key={c.key} style={{ textAlign: "left", fontSize: 12.5, color: "var(--cv-muted)", padding: "2px 6px 2px 0" }}>
                {c.label}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {g.columns.map((c) => {
                const raw = row[c.key] ?? "";
                const bad = raw.trim() ? "error" in tryParseInput(c.type, raw) : false;
                return (
                  <td key={c.key} style={{ padding: "2px 6px 2px 0" }}>
                    <input
                      className="expr"
                      style={{ width: "100%", ...(bad ? { borderColor: "#b42318" } : {}) }}
                      value={raw}
                      placeholder={c.type === "date" ? "2026-08-10" : c.label.toLowerCase()}
                      onChange={(e) => setCell(i, c.key, e.target.value)}
                    />
                  </td>
                );
              })}
              <td style={{ width: 28 }}>
                <button
                  title="Remove row"
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  style={{ fontSize: 12 }}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button style={{ fontSize: 12.5, marginTop: 4 }} onClick={() => onChange([...rows, {}])}>
        + Add row
      </button>
    </div>
  );
}

function SendForSignature({
  contractId, rows, onRows, onSent,
}: {
  contractId: string;
  rows: RecipientRow[];
  onRows: (rows: RecipientRow[]) => void;
  onSent: () => void;
}) {
  const { apiFetch } = useConovo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/contracts/${contractId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Order in the list = signing order (sequenced multi-party).
          recipients: rows.map((r, i) => ({
            role: r.role,
            name: r.name.trim(),
            email: r.email.trim(),
            // A phone opts this signer into SMS identity verification.
            ...(r.phone.trim() ? { phone: r.phone.trim() } : {}),
            signOrder: i + 1,
          })),
        }),
      });
      const d = (await res.json()) as { error?: unknown };
      if (!res.ok) throw new Error(typeof d.error === "string" ? d.error : "send failed");
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const setRow = (i: number, patch: Partial<RecipientRow>) =>
    onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--cv-line)" }}>
      <div className="section-title">Send for signature</div>
      {rows.map((r, i) => (
        <div key={r.role} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
          {rows.length > 1 && (
            <span className="sub" style={{ margin: 0, minWidth: 120, fontSize: 12.5 }}>
              {i + 1}. {r.label}
            </span>
          )}
          <input className="expr" style={{ flex: 1, minWidth: 150 }} value={r.name}
            onChange={(e) => setRow(i, { name: e.target.value })}
            placeholder={`${r.label} name`} />
          <input className="expr" style={{ flex: 1, minWidth: 190 }} value={r.email}
            onChange={(e) => setRow(i, { email: e.target.value })}
            placeholder={`${r.label} email`} />
          <input className="expr" style={{ flex: 1, minWidth: 150 }} value={r.phone}
            onChange={(e) => setRow(i, { phone: e.target.value })}
            placeholder="Mobile (optional)" />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="primary" disabled={busy || !rowsComplete(rows)} onClick={() => void send()}>
          {busy ? "Sending…" : rows.length > 1 ? `Send to ${rows.length} signers` : "Send"}
        </button>
        <span className="sub" style={{ margin: 0, fontSize: 12 }}>
          {rows.length > 1 ? "Signers are invited in this order. " : ""}
          A mobile number adds SMS identity verification before signing.
        </span>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const PROVENANCE_LABEL: Record<string, string> = {
  platform: "from your data",
  workspace_default: "standing term",
  preset: "preset",
  computed: "calculated",
  edited: "you changed this",
  per_deal: "entered",
};

export interface SendContractRecipient {
  role?: string;
  name: string;
  email: string;
  /** E.164 mobile — prefills the optional SMS-verification phone field. */
  phone?: string;
}

/**
 * <SendContract subject={...}> — the embedded send flow (SPEC §3.4). The host
 * passes its render-time subject payload; the resolver fills everything it
 * can, the per-deal panel asks only for what's left, and the trust ramp
 * decides between review-then-send and one-click auto-send.
 */
export function SendContract({
  subject,
  defaultRecipient,
  onSent,
}: {
  /** The platform's subject payload — bindings resolve against this. */
  subject: unknown;
  /** Prefills the signature-request form (and auto-send recipients). */
  defaultRecipient: SendContractRecipient;
  onSent?: (contractId: string) => void;
}) {
  return (
    <LockedGate>
      <div className="conovo">
        <SendPanel subject={subject} defaultRecipient={defaultRecipient} {...(onSent ? { onSent } : {})} />
      </div>
    </LockedGate>
  );
}

function SendPanel({
  subject,
  defaultRecipient,
  onSent,
}: {
  subject: unknown;
  defaultRecipient: SendContractRecipient;
  onSent?: (contractId: string) => void;
}) {
  const { apiFetch, fetchPdfUrl } = useConovo();
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [perDealRaw, setPerDealRaw] = useState<Record<string, string>>({});
  /**
   * Edits to values that resolved automatically, keyed by field. A key is
   * present only once the user has touched that field; absent means "leave it
   * to the resolver". Raw text, parsed to a typed value before sending — an
   * unparseable edit is shown inline and simply not sent.
   */
  const [overrideRaw, setOverrideRaw] = useState<Record<string, string>>({});
  /**
   * Which fields the user has to supply, captured from the FIRST prepare for
   * this template — before any typing. Membership is deliberately frozen:
   * resolution state changes as you type, so partitioning the form by it made
   * a field hop to the other section mid-keystroke AND dropped its value from
   * the next request (the collectors iterated those same shifting lists).
   * null until the first prepare lands.
   */
  const [needsInput, setNeedsInput] = useState<Set<string> | null>(null);
  /** Stable {label,type} per key, so collecting values never needs the split. */
  const [fieldMeta, setFieldMeta] = useState<
    Record<string, { label: string; type: string }>
  >({});
  /**
   * What this business typed for these fields on its own past contracts, by
   * field key. A suggestion only — nothing is filled until the user takes it.
   */
  /** Keys promoted to standing terms this session, for inline confirmation. */
  const [standingSaved, setStandingSaved] = useState<string[]>([]);
  const [standingBusy, setStandingBusy] = useState<string | null>(null);
  /** Bumped after a standing term is saved, to force a re-prepare. */
  const [defaultsNonce, setDefaultsNonce] = useState(0);
  const [groupRaw, setGroupRaw] = useState<GroupRaw>({});
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([]);
  const [presetId, setPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [recipRows, setRecipRows] = useState<RecipientRow[] | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);

  /** Pre-draft one text field from the record — into the form, human reviews. */
  async function draftField(fieldKey: string) {
    if (!versionId) return;
    setDrafting(fieldKey);
    try {
      const res = await apiFetch(`/v1/contracts/predraft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateVersionId: versionId, fieldKey, subject }),
      });
      const d = (await res.json()) as { draft?: string; error?: unknown };
      if (res.ok && d.draft) setPerDealRaw((m) => ({ ...m, [fieldKey]: d.draft! }));
    } finally {
      setDrafting(null);
    }
  }
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [advisory, setAdvisory] = useState<AdvisoryFlag[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  /** Blob URL of an unsaved preview, and whether one is rendering. */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  /**
   * The contract text and each field's anchors, for showing a field in place.
   * Loaded once per template version, on the first request to see one — a long
   * contract is far more than the panel needs just to collect values.
   */
  const [docPane, setDocPane] = useState<
    {
      paragraphs: DocParagraph[];
      tables?: DocTable[];
      defaults?: DocDefaults | null;
      header?: DocParagraph[];
      fields: Marked[];
    } | null
  >(null);
  /** Field the cursor is on, highlighted in the contract beside the form. */
  const [hovered, setHovered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`/v1/workspace/templates`)
      .then(async (res) => {
        const data = (await res.json()) as { templates: TemplateOption[] };
        setTemplates(data.templates);
        if (data.templates.length === 1) setVersionId(data.templates[0]!.versionId);
      })
      .catch(() => setError("Conovo API not reachable"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Everything the user typed in the "needs you" section, keyed off what they
   * typed rather than what is currently unresolved. Iterating `unresolved`
   * used to silently drop a value the moment it resolved — the field showed
   * the value, the next request omitted it, and it never reached the contract.
   */
  const perDealValues = useCallback((): Record<string, SerializedValue> => {
    const out: Record<string, SerializedValue> = {};
    for (const [key, raw] of Object.entries(perDealRaw)) {
      const meta = fieldMeta[key];
      if (!meta || !raw?.trim()) continue;
      const parsed = tryParseInput(meta.type as FieldType, raw);
      if ("value" in parsed) out[key] = parsed.value;
    }
    return out;
  }, [perDealRaw, fieldMeta]);

  /**
   * Build the override payload from fields the user has touched. Deliberately
   * does NOT skip an edit that matches the current display: once an override
   * applies, the display IS the edited value, so comparing against it would
   * drop the override, revert the value, re-add it, and oscillate. Presence in
   * overrideRaw is the signal; `revert` removes the key.
   */
  const overrideValues = useCallback((): Record<string, SerializedValue> => {
    const out: Record<string, SerializedValue> = {};
    for (const [key, raw] of Object.entries(overrideRaw)) {
      const meta = fieldMeta[key];
      if (!meta || !raw.trim()) continue;
      const parsed = tryParseInput(meta.type as FieldType, raw);
      if ("value" in parsed) out[key] = parsed.value;
    }
    return out;
  }, [overrideRaw, fieldMeta]);

  // The contract sits beside the form the whole time now, so it loads with
  // the template rather than waiting for someone to ask for it.
  useEffect(() => {
    setDocPane(null);
    if (!versionId) return;
    let stop = false;
    apiFetch(`/v1/template-versions/${versionId}/document`)
      .then(async (res) => {
        if (!res.ok || stop) return;
        setDocPane(
          (await res.json()) as {
            paragraphs: DocParagraph[];
            tables?: DocTable[];
            defaults?: DocDefaults | null;
            header?: DocParagraph[];
            fields: Marked[];
          },
        );
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

  // Presets are per template — reload the list when the pick changes.
  useEffect(() => {
    const templateId = templates?.find((t) => t.versionId === versionId)?.templateId;
    setPresetId("");
    if (!templateId) {
      setPresets([]);
      return;
    }
    apiFetch(`/v1/templates/${templateId}/presets`)
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { presets: { id: string; name: string }[] };
        setPresets(data.presets);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, templates]);

  // Re-prepare whenever template, preset, per-deal inputs, or table rows change.
  useEffect(() => {
    if (!versionId) return;
    const t = setTimeout(() => {
      void (async () => {
        const res = await apiFetch(`/v1/contracts/prepare`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            templateVersionId: versionId,
            subject,
            ...(presetId ? { presetId } : {}),
            perDeal: perDealValues(),
            overrides: overrideValues(),
            groupRows: prepared ? serializeGroupRows(prepared.groups, groupRaw) : {},
          }),
        });
        if (res.ok) {
          const p = (await res.json()) as Prepared;
          setPrepared(p);
          // Field identity/type never changes for a template version; merge so
          // a key stays known even while it moves between resolved/unresolved.
          setFieldMeta((prev) => {
            const next = { ...prev };
            for (const [k, v] of Object.entries(p.resolved))
              next[k] = { label: v.label, type: v.type };
            for (const u of p.unresolved) next[u.key] = { label: u.label, type: u.type };
            return next;
          });
          // Freeze the split on the first prepare — before any typing, so it
          // reflects what the resolver genuinely couldn't fill.
          setNeedsInput((prev) => prev ?? new Set(p.unresolved.map((u) => u.key)));
          // Recipient rows come from the template's party fields — build
          // them once per template pick, then the user's edits stick.
          setRecipRows((rows) => rows ?? rowsForTemplate(p.parties ?? [], defaultRecipient));
        }
      })();
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, subject, perDealRaw, overrideRaw, groupRaw, presetId, defaultsNonce]);

  // A preview is a snapshot of the values at the moment it rendered; the
  // instant any of them change it is showing something you are no longer
  // about to send, so it goes rather than quietly misleading.
  useEffect(() => {
    setPreviewUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return null;
    });
  }, [versionId, perDealRaw, overrideRaw, groupRaw, presetId, defaultsNonce]);

  // New template pick → recipient rows rebuild from its parties.
  useEffect(() => {
    setRecipRows(null);
    // A new template has different fields — carrying typed values or the old
    // needs-input split across would apply them to whatever shares a key.
    setNeedsInput(null);
    setFieldMeta({});
    setDocPane(null);
    setHovered(null);
    setPerDealRaw({});
    setOverrideRaw({});
  }, [versionId]);

  /**
   * Promote one value to a standing term for this business — "it's always
   * this". Standing terms outrank per-deal in the resolution chain, so the
   * field fills itself on every future contract, for every template that has
   * a field with this key.
   */
  async function saveAsStanding(key: string, raw: string) {
    const meta = fieldMeta[key];
    if (!meta || !raw.trim()) return;
    const parsed = tryParseInput(meta.type as FieldType, raw);
    if (!("value" in parsed)) return;
    setStandingBusy(key);
    try {
      const res = await apiFetch(`/v1/workspace/defaults`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ set: [{ key, value: parsed.value }], remove: [] }),
      });
      if (!res.ok) throw new Error("could not save that as a standing term");
      setStandingSaved((s) => [...s, key]);
      // Re-prepare so provenance flips to "standing term" straight away.
      setDefaultsNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStandingBusy(null);
    }
  }

  /**
   * Render the real document without committing to it. Returns a blob URL —
   * an iframe can't carry an auth header, so the bytes are fetched here and
   * handed over as an object URL, the same trick the contract PDF uses.
   */
  async function preview() {
    if (!versionId || !prepared) return;
    setPreviewing(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/contracts/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateVersionId: versionId,
          subject,
          ...(presetId ? { presetId } : {}),
          perDeal: perDealValues(),
          overrides: overrideValues(),
          groupRows: serializeGroupRows(prepared.groups, groupRaw),
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof d.error === "string" ? d.error : "preview failed");
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(await res.blob()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  }

  /** Save the currently-typed per-deal values as a named bundle. */
  async function savePreset() {
    const templateId = templates?.find((t) => t.versionId === versionId)?.templateId;
    if (!templateId || !prepared) return;
    const values = perDealValues();
    if (Object.keys(values).length === 0 || !presetName.trim()) return;
    const res = await apiFetch(`/v1/templates/${templateId}/presets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: presetName.trim(), values }),
    });
    const d = (await res.json()) as { id?: string; name?: string; error?: unknown };
    if (!res.ok || !d.id) {
      setError(typeof d.error === "string" ? d.error : "couldn't save preset");
      return;
    }
    setPresets((p) => [...p, { id: d.id!, name: d.name ?? presetName }]);
    setPresetId(d.id);
    setPresetName("");
    setPerDealRaw({});
  }

  /**
   * The "needs you" rows — driven by the frozen split, so a field stays put
   * once you start typing in it. `satisfied` drives a quiet ✓ instead of the
   * row vanishing to the section above mid-keystroke.
   */
  const pendingRows = (() => {
    if (!prepared || !needsInput) return [];
    const openNow = new Map(prepared.unresolved.map((u) => [u.key, u]));
    const rows = [];
    for (const key of needsInput) {
      const meta = fieldMeta[key];
      if (!meta || meta.type === "repeating_group") continue;
      const open = openNow.get(key);
      // Context follows the field between the two lists, so the excerpt
      // doesn't vanish the moment you fill the value in.
      const context = open?.context ?? prepared.resolved[key]?.context;
      rows.push({
        key,
        label: meta.label,
        type: meta.type,
        required: open?.required ?? true,
        reason: open?.reason ?? "",
        satisfied: !open && !!prepared.resolved[key],
        ...(context ? { context } : {}),
      });
    }
    return rows;
  })();

  /**
   * Labels this panel shows more than once.
   *
   * A label is normally enough to know what to type. It stops being enough when
   * a document repeats one fill-in marker — five "DATES / weeks" blanks become
   * five fields all named "DATES / weeks" — and then the excerpt is the only
   * thing telling them apart, so it opens without being asked for. Counted over
   * exactly what gets rendered below: the auto-filled rows minus the ones split
   * out as needing input, plus the pending rows themselves.
   */
  /**
   * What each field currently reads as, for substituting into the contract
   * beside the form: resolved values, plus anything typed into a still-open
   * field so the pane keeps up while someone fills the form in.
   */
  const liveValues = (() => {
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(prepared?.resolved ?? {})) out[key] = v.display;
    for (const [key, raw] of Object.entries(perDealRaw)) if (raw.trim()) out[key] = raw;
    for (const [key, raw] of Object.entries(overrideRaw)) if (raw.trim()) out[key] = raw;
    return out;
  })();

  const collidingLabels = (() => {
    const counts = new Map<string, number>();
    const bump = (label: string) => {
      const name = label.trim().toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    if (prepared)
      for (const [k, v] of Object.entries(prepared.resolved))
        if (!needsInput?.has(k)) bump(v.label);
    for (const r of pendingRows) bump(r.label);
    return new Set(
      [...counts].filter(([, n]) => n > 1).map(([name]) => name),
    );
  })();
  const collides = (label: string) =>
    collidingLabels.has(label.trim().toLowerCase());

  const selectedTemplate = templates?.find((t) => t.versionId === versionId);
  const oneClick =
    !!selectedTemplate?.autoSendEligible &&
    !!prepared &&
    !prepared.blocked &&
    !!recipRows &&
    rowsComplete(recipRows);

  async function generate() {
    if (!versionId || !prepared) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/contracts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateVersionId: versionId,
          subject,
          ...(presetId ? { presetId } : {}),
          perDeal: perDealValues(),
          overrides: overrideValues(),
          groupRows: serializeGroupRows(prepared.groups, groupRaw),
          ...(oneClick && recipRows
            ? {
                autoSend: true,
                recipients: recipRows.map((r, i) => ({
                  role: r.role,
                  name: r.name.trim(),
                  email: r.email.trim(),
                  ...(r.phone.trim() ? { phone: r.phone.trim() } : {}),
                  signOrder: i + 1,
                })),
              }
            : {}),
        }),
      });
      const d = (await res.json()) as GenerateResult & { error?: unknown };
      if (!res.ok) throw new Error(typeof d.error === "string" ? d.error : "generate failed");
      setResult(d);
      setPdfUrl(await fetchPdfUrl(d.contractId));
      if (d.status === "sent") onSent?.(d.contractId);
      // The check runs after the response so the draft isn't held behind a
      // model call. Poll a few times, then stop caring — advisory notes that
      // never arrive are a non-event, not an error worth showing anyone.
      if (d.advisoryPending) void pollAdvisory(d.contractId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pollAdvisory(contractId: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const res = await apiFetch(`/v1/contracts/${contractId}`);
        if (!res.ok) return;
        const d = (await res.json()) as {
          validation?: { advisory?: AdvisoryFlag[] } | null;
        };
        const flags = d.validation?.advisory;
        if (flags && flags.length > 0) {
          setAdvisory(flags);
          return;
        }
      } catch {
        return; // Advisory notes are a bonus; a failed poll is not an error.
      }
    }
  }

  return (
    <>
      {result ? (
        <div className={result.status === "draft" ? "success" : "card"} style={{ maxWidth: 640 }}>
          <h2 style={{ marginTop: 0 }}>
            {result.status === "sent"
              ? "Sent for signature ✉️"
              : result.status === "draft"
                ? "Draft ready 🎉"
                : "Needs your attention"}
          </h2>
          {result.issues.length > 0 && (
            <ul>
              {result.issues.map((i, n) => (
                <li key={n} className={i.severity === "error" ? "error" : "sub"}>{i.message}</li>
              ))}
            </ul>
          )}
          {advisory.length > 0 && (
            <div className="advisory">
              <div className="advisory-head">A second look — nothing is blocked</div>
              <ul>
                {advisory.map((f, n) => (
                  <li key={n}>{f.message}</li>
                ))}
              </ul>
              <p className="advisory-foot">
                Automated review of the finished draft. It can be wrong — you decide.
              </p>
            </div>
          )}
          {result.status === "sent" && (
            <p className="sub">
              {defaultRecipient.name} will get a signing link — track it in your
              contract inbox.
            </p>
          )}
          {pdfUrl && (
            <>
              <p>
                <a href={pdfUrl} target="_blank" rel="noreferrer">
                  Open the contract PDF ↗
                </a>
              </p>
              <iframe
                src={pdfUrl}
                style={{ width: "100%", height: 480, border: "1px solid var(--cv-line)", borderRadius: 8 }}
                title="Contract draft"
              />
            </>
          )}
          {result.status === "draft" && recipRows && (
            <SendForSignature
              contractId={result.contractId}
              rows={recipRows}
              onRows={setRecipRows}
              onSent={() => {
                setResult((r) => (r ? { ...r, status: "sent" } : r));
                if (result) onSent?.(result.contractId);
              }}
            />
          )}
        </div>
      ) : (
        <div className="sendlayout">
        <div className="card sendform">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Send contract</h2>

          {templates === null ? (
            <p><span className="spinner" />Loading…</p>
          ) : templates.length === 0 ? (
            <p className="sub">No templates yet — upload one on the Contracts tab first.</p>
          ) : (
            <>
              <select
                value={versionId ?? ""}
                onChange={(e) => { setVersionId(e.target.value); setPrepared(null); }}
              >
                <option value="" disabled>Pick a template…</option>
                {templates.map((t) => (
                  <option key={t.versionId} value={t.versionId}>
                    {t.name}
                    {t.canGenerate === false ? " (PDF — can't send)" : ""}
                  </option>
                ))}
              </select>

              {presets.length > 0 && (
                <select
                  style={{ marginLeft: 8 }}
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value)}
                >
                  <option value="">No preset</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              )}

              {selectedTemplate?.canGenerate === false && (
                <div className="notice" role="status">
                  <strong>This template was imported from a PDF.</strong> Contracts
                  are produced by filling the original Word file, so a PDF can be
                  set up but not sent. Import the <code>.docx</code> version of
                  this document and set it up once more to send it.
                </div>
              )}

              {prepared && (
                <>
                  <div className="section-title" style={{ marginTop: 16 }}>
                    Filled automatically
                    <span className="sub" style={{ margin: 0, fontWeight: 400, textTransform: "none" }}>
                      {" "}— click any value to change it for this contract
                    </span>
                  </div>
                  {Object.entries(prepared.resolved)
                    .filter(([k]) => !needsInput?.has(k))
                    .map(([k, v]) => {
                    const raw = overrideRaw[k];
                    const edited = raw !== undefined;
                    const parsed =
                      edited && raw.trim() ? tryParseInput(v.type as FieldType, raw) : null;
                    const bad = parsed && "error" in parsed;
                    return (
                      <div
                        key={k}
                        className={`filled${hovered === k ? " hot" : ""}`}
                        onMouseEnter={() => setHovered(k)}
                        onMouseLeave={() => setHovered(null)}
                      >
                        <label className="filled-label" htmlFor={`el-filled-${k}`}>
                          {v.label}
                        </label>
                        <div className="filled-value">
                          <input
                            id={`el-filled-${k}`}
                            className={`expr${bad ? " bad" : ""}`}
                            value={raw ?? v.display}
                            onChange={(e) =>
                              setOverrideRaw((m) => ({ ...m, [k]: e.target.value }))
                            }
                          />
                          <span className="conf">
                            {edited && !bad
                              ? PROVENANCE_LABEL["edited"]
                              : (PROVENANCE_LABEL[v.provenance] ?? v.provenance)}
                          </span>
                          {edited && (
                            <button
                              className="linkish"
                              title="Undo this change"
                              onClick={() =>
                                setOverrideRaw((m) => {
                                  const next = { ...m };
                                  delete next[k];
                                  return next;
                                })
                              }
                            >
                              revert
                            </button>
                          )}
                        </div>
                        {(() => {
                          const dev = prepared.deviations?.find((d) => d.fieldKey === k);
                          // An edit is the user telling us what they want —
                          // stop second-guessing it.
                          if (!dev || edited) return null;
                          return (
                            <p className="deviation">
                              {dev.kind === "amount"
                                ? `This is well outside your usual — you've used ${dev.usualDisplay} on ${dev.usualCount} contracts. Worth a look before sending.`
                                : `You usually put ${dev.usualDisplay} here (${dev.usualCount} contracts). Worth a look before sending.`}
                            </p>
                          );
                        })()}
                        {bad && (
                          <span className="error" style={{ fontSize: 12 }}>
                            {(parsed as { error: string }).error}
                          </span>
                        )}
                      </div>
                    );
                  })}

                  {prepared.groups.map((g) => (
                    <GroupRowsEditor
                      key={g.key}
                      group={g}
                      rows={groupRaw[g.key] ?? []}
                      onChange={(rows) => setGroupRaw((m) => ({ ...m, [g.key]: rows }))}
                    />
                  ))}

                  {pendingRows.length > 0 && (
                    <>
                      <div className="section-title" style={{ marginTop: 16 }}>
                        Just these left
                        <span className="sub" style={{ margin: 0, fontWeight: 400, textTransform: "none" }}>
                          {" "}— {pendingRows.filter((r) => !r.satisfied).length} of{" "}
                          {pendingRows.length} still needed
                        </span>
                      </div>
                      {pendingRows.map((u) => {
                        const raw = perDealRaw[u.key] ?? "";
                        const parsed = raw.trim() ? tryParseInput(u.type as FieldType, raw) : null;
                        const draftable = u.type === "long_text" || u.type === "text";
                        return (
                          <div
                            key={u.key}
                            className={`pending${hovered === u.key ? " hot" : ""}`}
                            onMouseEnter={() => setHovered(u.key)}
                            onMouseLeave={() => setHovered(null)}
                          >
                            <label style={{ display: "flex", alignItems: "baseline", gap: 8, fontWeight: 600, fontSize: 13 }}>
                              {u.label}
                              {u.satisfied && <span className="ok-check" title="Filled in">✓</span>}
                              {!u.required && <span className="sub" style={{ fontWeight: 400, margin: 0 }}> · optional</span>}
                              {draftable && subject != null && (
                                <button
                                  style={{ marginLeft: "auto", fontSize: 11.5 }}
                                  disabled={drafting === u.key}
                                  onClick={() => void draftField(u.key)}
                                  title="Draft from this record — you review and edit before anything is generated"
                                >
                                  {drafting === u.key ? "Drafting…" : "✎ Draft it"}
                                </button>
                              )}
                            </label>
                            {u.type === "long_text" ? (
                              <textarea
                                className="expr"
                                style={{ width: "100%", minHeight: 72, fontFamily: "inherit" }}
                                value={raw}
                                placeholder={u.reason}
                                onChange={(e) =>
                                  setPerDealRaw((m) => ({ ...m, [u.key]: e.target.value }))
                                }
                              />
                            ) : (
                              <input
                                className="expr"
                                style={{ width: "100%" }}
                                value={raw}
                                placeholder={u.type === "date" ? "e.g. 2026-08-03" : u.reason}
                                onChange={(e) =>
                                  setPerDealRaw((m) => ({ ...m, [u.key]: e.target.value }))
                                }
                              />
                            )}
                            {parsed && "error" in parsed && (
                              <span className="error" style={{ fontSize: 12 }}>{parsed.error}</span>
                            )}
                            {/* Same as last time: what this business typed for
                                this field on its own previous contract. Offered,
                                never auto-applied — the value may genuinely
                                differ for this project. */}
                            {!raw.trim() && prepared.usuals?.[u.key] && (
                              <button
                                className="linkish"
                                title="Your own history — the value you've chosen most often on past contracts"
                                onClick={() =>
                                  setPerDealRaw((m) => ({
                                    ...m,
                                    [u.key]: editStringForValue(prepared.usuals![u.key]!.value),
                                  }))
                                }
                              >
                                {prepared.usuals[u.key]!.count > 1
                                  ? `You've used ${prepared.usuals[u.key]!.display} on ${prepared.usuals[u.key]!.count} contracts — use it`
                                  : `Last time you used ${prepared.usuals[u.key]!.display} — use it`}
                              </button>
                            )}
                            {/* Typed a value that never varies? Promote it once
                                and it fills itself on every future contract. */}
                            {raw.trim() && !(parsed && "error" in parsed) && (
                              standingSaved.includes(u.key) ? (
                                <span className="sub" style={{ fontSize: 12, margin: 0 }}>
                                  Saved as a standing term — it&apos;ll fill in
                                  automatically from now on.
                                </span>
                              ) : (
                                <button
                                  className="linkish"
                                  disabled={standingBusy === u.key}
                                  title="Save for this business — every future contract fills it in"
                                  onClick={() => void saveAsStanding(u.key, raw)}
                                >
                                  {standingBusy === u.key
                                    ? "Saving…"
                                    : "Always this — save as a standing term"}
                                </button>
                              )
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}

                  {Object.keys(perDealValues()).length > 0 && (
                    <div style={{ display: "flex", marginTop: 4, gap: 8 }}>
                      <input
                        className="expr"
                        style={{ flex: 1, fontSize: 12.5 }}
                        value={presetName}
                        placeholder="Save these values as a preset…"
                        onChange={(e) => setPresetName(e.target.value)}
                      />
                      <button
                        style={{ fontSize: 12.5 }}
                        disabled={!presetName.trim()}
                        onClick={() => void savePreset()}
                      >
                        Save preset
                      </button>
                    </div>
                  )}

                  {prepared.issues.length > 0 && (
                    <ul style={{ paddingLeft: 18 }}>
                      {prepared.issues.map((i, n) => (
                        <li key={n} className={i.severity === "error" ? "error" : "sub"} style={{ fontSize: 13 }}>
                          {i.message}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: "wrap" }}>
                    <button
                      className="primary"
                      // A PDF source can never be filled — don't let the user
                      // complete the whole panel just to be refused by the API.
                      disabled={busy || selectedTemplate?.canGenerate === false}
                      {...(selectedTemplate?.canGenerate === false
                        ? { title: "Import the Word (.docx) version to send this one" }
                        : {})}
                      onClick={() => void generate()}
                    >
                      {busy
                        ? "Generating…"
                        : prepared.blocked
                          ? "Generate anyway (saves as needs-attention)"
                          : oneClick
                            ? recipRows && recipRows.length > 1
                              ? `Generate & send to ${recipRows.length} signers`
                              : `Generate & send to ${recipRows?.[0]?.name ?? defaultRecipient.name}`
                            : "Generate draft"}
                    </button>
                    {/* Especially important next to one-click send, which
                        otherwise dispatches a document nobody has looked at. */}
                    <button
                      disabled={previewing || selectedTemplate?.canGenerate === false}
                      title="See the filled document without saving or sending anything"
                      onClick={() => void preview()}
                    >
                      {previewing ? "Rendering…" : "Preview"}
                    </button>
                  </div>

                  {previewUrl && (
                    <div style={{ marginTop: 12 }}>
                      <p className="sub" style={{ margin: "0 0 6px" }}>
                        Preview only — nothing has been saved or sent.{" "}
                        <a href={previewUrl} target="_blank" rel="noreferrer">
                          Open in a new tab ↗
                        </a>
                      </p>
                      <iframe
                        src={previewUrl}
                        style={{
                          width: "100%",
                          height: 480,
                          border: "1px solid var(--cv-line)",
                          borderRadius: 8,
                        }}
                        title="Contract preview"
                      />
                    </div>
                  )}
                  {selectedTemplate && !selectedTemplate.autoSendEligible && (
                    <p className="sub" style={{ fontSize: 12.5, marginTop: 8 }}>
                      {selectedTemplate.reviewedSendCount} of{" "}
                      {selectedTemplate.autoSendUnlockAt} reviewed sends until
                      one-click sending unlocks for this template.
                    </p>
                  )}
                </>
              )}
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        {/* The agreement as it currently reads. Hovering a field on the left
            lights its spot here, and a value typed on the left appears here as
            it's typed. Only shown once a template is picked — an empty frame
            before that is just wasted room. */}
        {prepared && docPane && (
          <aside className="sendpreview">
            <div className="sendpreview-head">
              <strong>{prepared.templateName}</strong>
              <span className="sub" style={{ margin: 0 }}>as it reads right now</span>
            </div>
            <DocumentPane
              paragraphs={docPane.paragraphs}
              tables={docPane.tables ?? []}
              {...(docPane.defaults ? { defaults: docPane.defaults } : {})}
              {...(docPane.header ? { header: docPane.header } : {})}
              marks={docPane.fields}
              values={liveValues}
              active={hovered}
              onHover={setHovered}
            />
          </aside>
        )}
        </div>
      )}
    </>
  );
}
