"use client";

import { useCallback, useEffect, useState } from "react";
import { LockedGate, useConovo } from "./context.js";
import { WhereItGoes, type Excerpt } from "./WhereItGoes.js";

/**
 * <ContractTemplates> — the contracts this business has set up, and what to do
 * with them. Without it a template exists only as a name in the send picker:
 * no way to tell two similar ones apart, see what a template actually fills,
 * fix a bad name, or retire one that's been replaced.
 *
 * "Delete" is archive. A signed contract pins its template version and has to
 * stay reproducible forever (SPEC §3.5), so the row can never actually go —
 * and saying "deleted" while keeping the data would be a lie.
 */

interface TemplateRow {
  templateId: string;
  name: string;
  status: "draft" | "active" | "archived";
  versionId: string;
  version: number;
  versionCount: number;
  fieldCount: number;
  contractCount: number;
  reviewedSendCount: number;
  sourceName: string;
  canGenerate: boolean;
  /** Fill mechanism (SPEC §3.1.1); PDFs generate with fidelity limits. */
  sourceFormat?: "docx" | "pdf" | null;
  createdAt: string;
  updatedAt: string;
}

interface TemplateDetail {
  templateId: string;
  name: string;
  status: string;
  sourceName: string;
  canGenerate: boolean;
  sourceFormat?: "docx" | "pdf" | null;
  versions: { versionId: string; version: number; createdAt: string }[];
  fields: {
    key: string;
    label: string;
    type: string;
    source: string;
    required: boolean;
    anchored: boolean;
    context?: Excerpt;
  }[];
}

const SOURCE_LABEL: Record<string, string> = {
  platform_bound: "from your data",
  workspace_default: "standing term",
  per_deal: "you enter it",
  computed: "calculated",
  conditional: "conditional section",
};

const when = (iso: string) => new Date(iso).toLocaleDateString();

function TemplateCard({
  row,
  onChanged,
  onRevise,
}: {
  row: TemplateRow;
  onChanged: () => void;
  onRevise?: (template: { templateId: string; name: string }) => void;
}) {
  const { apiFetch } = useConovo();
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(row.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/templates/${row.templateId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: unknown; title?: string };
        throw new Error(
          typeof d.error === "string" ? d.error : (d.title ?? "couldn't save that"),
        );
      }
      setRenaming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      const res = await apiFetch(`/v1/templates/${row.templateId}`);
      if (res.ok) setDetail((await res.json()) as TemplateDetail);
    }
  }

  const archived = row.status === "archived";
  // Two different states that used to be one. `canGenerate` is now true for
  // PDFs (SPEC §3.1.1), so gating the fidelity note on !canGenerate meant it
  // never appeared for the format it describes — while the rare genuinely
  // unfillable source got a message telling it that it sends.
  const unfillable = !row.canGenerate;
  const lowerFidelity = row.sourceFormat === "pdf";

  return (
    <div className={`card tmplcard${archived ? " off" : ""}`}>
      <div className="tmplhead">
        {renaming ? (
          <input
            className="expr"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) void patch({ name });
              if (e.key === "Escape") {
                setName(row.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <strong>{row.name}</strong>
        )}
        <span className="spacer" />
        {archived && <span className="badge-archived">archived</span>}
      </div>

      <p className="sub tmplmeta">
        {row.fieldCount} field{row.fieldCount === 1 ? "" : "s"} ·{" "}
        {row.contractCount} contract{row.contractCount === 1 ? "" : "s"} sent ·{" "}
        v{row.version}
        {row.versionCount > 1 ? ` of ${row.versionCount}` : ""} · updated{" "}
        {when(row.updatedAt)}
        <br />
        <span className="tmplsource">{row.sourceName}</span>
      </p>

      {unfillable && (
        <p className="notice" style={{ marginTop: 8 }}>
          This source file can&rsquo;t be filled. Re-import the document as .docx
          or .pdf to send from it.
        </p>
      )}

      {lowerFidelity && (
        <p className="notice" style={{ marginTop: 8 }}>
          Imported from a PDF. It sends, but Word files fill with higher
          fidelity — import the .docx if you have it.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        <button onClick={() => void toggleOpen()}>
          {open ? "Hide fields" : "What it fills"}
        </button>
        {renaming ? (
          <>
            <button
              className="primary"
              disabled={busy || !name.trim()}
              onClick={() => void patch({ name })}
            >
              Save name
            </button>
            <button
              onClick={() => {
                setName(row.name);
                setRenaming(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button onClick={() => setRenaming(true)}>Rename</button>
        )}
        {onRevise && !archived && (
          <button
            title="Upload an updated version of this contract. Your setup carries forward."
            onClick={() => onRevise({ templateId: row.templateId, name: row.name })}
          >
            New version
          </button>
        )}
        <span className="spacer" />
        {archived ? (
          <button disabled={busy} onClick={() => void patch({ status: "active" })}>
            Restore
          </button>
        ) : (
          <button
            className="linkish"
            disabled={busy}
            title="Hides it from the send picker. Contracts already sent are untouched."
            onClick={() => void patch({ status: "archived" })}
          >
            Archive
          </button>
        )}
      </div>

      {open && (
        <div className="tmplfields">
          {!detail ? (
            <p className="sub">Loading…</p>
          ) : detail.fields.length === 0 ? (
            <p className="sub">No fields — this template fills nothing.</p>
          ) : (
            detail.fields.map((f) => (
              <div key={f.key} className="tmplfield">
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13 }}>{f.label}</strong>
                  <span className="conf">{f.type}</span>
                  <span className="conf">{SOURCE_LABEL[f.source] ?? f.source}</span>
                  {!f.anchored && (
                    <span className="conf" style={{ color: "var(--cv-warn)" }}>
                      no anchor — won&apos;t fill
                    </span>
                  )}
                </div>
                {f.context && <WhereItGoes context={f.context} />}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ContractTemplates({
  onRevise,
}: {
  /**
   * Host-provided route to the revision flow. When set, each active template
   * offers "New version", which should render <ContractStudio revisionOf={…}>.
   * A slot rather than built-in navigation — the package doesn't own routing.
   */
  onRevise?: (template: { templateId: string; name: string }) => void;
} = {}) {
  const { apiFetch } = useConovo();
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/v1/templates`);
      if (!res.ok) throw new Error("couldn't load your templates");
      const d = (await res.json()) as { templates: TemplateRow[] };
      setRows(d.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const archivedCount = (rows ?? []).filter((r) => r.status === "archived").length;
  const visible = (rows ?? []).filter((r) => showArchived || r.status !== "archived");

  return (
    <LockedGate>
      <div className="conovo">
        <h1>Your contracts</h1>
        <p className="sub">
          The contracts you&apos;ve set up. Each one fills itself from your data
          and the values you enter.
        </p>

        {error && <p className="error">{error}</p>}
        {!rows && !error && <p className="sub">Loading…</p>}

        {rows && visible.length === 0 && (
          <div className="card">
            <p style={{ margin: 0 }}>
              {archivedCount > 0
                ? "Nothing active — your templates are all archived."
                : "No contracts set up yet. Upload one to get started."}
            </p>
          </div>
        )}

        {visible.map((r) => (
          <TemplateCard
            key={r.templateId}
            row={r}
            onChanged={() => void load()}
            {...(onRevise ? { onRevise } : {})}
          />
        ))}

        {archivedCount > 0 && (
          <button className="linkish" onClick={() => setShowArchived((v) => !v)}>
            {showArchived
              ? "hide archived"
              : `show ${archivedCount} archived`}
          </button>
        )}
      </div>
    </LockedGate>
  );
}
