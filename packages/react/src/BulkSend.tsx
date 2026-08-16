"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LockedGate, useConovo } from "./context.js";

/**
 * <BulkSend> — CSV bulk send (SPEC §3.5): upload a CSV, confirm the
 * AI-proposed column mapping (proposals only — the user's confirmed mapping
 * is what creates the batch), review the pre-flight table (values per
 * recipient, not N PDFs; outliers flagged), then send. The batch drains like
 * a checklist with pause/resume; 2 bad rows never block 38 good ones.
 */

interface TemplateOption {
  versionId: string;
  name: string;
}

interface MappingField {
  key: string;
  type: string;
  label: string;
}

interface MapProposal {
  column: string;
  target: string;
  confidence: number;
  rationale: string;
}

interface PreflightItem {
  subjectRef: string;
  state: string;
  values: Record<string, string>;
  issues: { severity: string; message: string }[];
  outliers: { fieldKey: string; value: string; median: string }[];
  duplicateOf?: string;
}

interface BatchStatus {
  id: string;
  status: string;
  counts: Record<string, number>;
  items: { id: string; subjectRef: string; state: string; error: unknown }[];
}

const SPECIAL_TARGETS = [
  { value: "", label: "— don't use —" },
  { value: "subjectRef", label: "Row ID (customer/project ref)" },
  { value: "recipient.name", label: "Signer name" },
  { value: "recipient.email", label: "Signer email" },
];

const STATE_LABEL: Record<string, string> = {
  ready: "ready",
  needs_attention: "needs attention",
  queued: "queued",
  sent: "sent",
  failed: "failed",
  skipped: "skipped",
};

export function BulkSend(props: { recipientRole?: string }) {
  return (
    <LockedGate>
      <div className="conovo">
        <BulkSendFlow recipientRole={props.recipientRole ?? "client"} />
      </div>
    </LockedGate>
  );
}

function BulkSendFlow({ recipientRole }: { recipientRole: string }) {
  const { apiFetch } = useConovo();
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templateVersionId, setTemplateVersionId] = useState("");
  const [csvText, setCsvText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // mapping step
  const [fields, setFields] = useState<MappingField[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [rationales, setRationales] = useState<Record<string, string>>({});

  // preflight + drain steps
  const [preflight, setPreflight] = useState<{
    batchId: string;
    counts: Record<string, number>;
    items: PreflightItem[];
  } | null>(null);
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    apiFetch("/v1/workspace/templates")
      .then(async (res) => {
        const data = (await res.json()) as { templates: TemplateOption[] };
        setTemplates(data.templates);
        if (data.templates[0]) setTemplateVersionId(data.templates[0].versionId);
      })
      .catch(() => setError("Couldn't load templates."));
  }, [apiFetch]);

  useEffect(
    () => () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    },
    [],
  );

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const proposeMapping = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/v1/batches/map-csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateVersionId, csvText }),
      });
      const data = (await res.json()) as {
        error?: string;
        headers: string[];
        rowCount: number;
        fields: MappingField[];
        proposals: MapProposal[];
      };
      if (!res.ok) throw new Error(data.error ?? "mapping failed");
      setHeaders(data.headers);
      setRowCount(data.rowCount);
      setFields(data.fields);
      setMapping(
        Object.fromEntries(data.proposals.map((p) => [p.column, p.target])),
      );
      setRationales(
        Object.fromEntries(data.proposals.map((p) => [p.column, p.rationale])),
      );
      setPreflight(null);
      setBatch(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "mapping failed");
    } finally {
      setBusy(false);
    }
  };

  const runPreflight = async () => {
    setBusy(true);
    setError(null);
    try {
      const confirmed = Object.fromEntries(
        Object.entries(mapping).filter(([, v]) => v !== ""),
      );
      const res = await apiFetch("/v1/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateVersionId,
          csv: { text: csvText, mapping: confirmed, recipientRole },
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        batchId: string;
        counts: Record<string, number>;
        items: PreflightItem[];
      };
      if (!res.ok) throw new Error(data.error ?? "pre-flight failed");
      setPreflight(data);
      setBatch(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "pre-flight failed");
    } finally {
      setBusy(false);
    }
  };

  const refreshBatch = useCallback(
    async (id: string) => {
      const res = await apiFetch(`/v1/batches/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as BatchStatus;
      setBatch(data);
      if (data.status !== "sending" && pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    },
    [apiFetch],
  );

  const batchAction = async (action: "send" | "pause" | "resume") => {
    if (!preflight) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/batches/${preflight.batchId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `${action} failed`);
      await refreshBatch(preflight.batchId);
      if (!pollTimer.current && (action === "send" || action === "resume"))
        pollTimer.current = setInterval(() => void refreshBatch(preflight.batchId), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(false);
    }
  };

  const mappedFieldKeys = Object.values(mapping).filter(
    (t) => t && !["subjectRef", "recipient.name", "recipient.email"].includes(t),
  );
  const readyCount = preflight?.counts["ready"] ?? 0;

  return (
    <div className="bulk">
      <h1>Bulk send</h1>
      <p className="sub">
        One contract per CSV row. You confirm the column mapping and review
        every value before anything is sent.
      </p>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <div className="row">
          <select
            value={templateVersionId}
            onChange={(e) => setTemplateVersionId(e.target.value)}
          >
            {(templates ?? []).map((t) => (
              <option key={t.versionId} value={t.versionId}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <button
            className="primary"
            disabled={busy || !csvText || !templateVersionId}
            onClick={proposeMapping}
          >
            {busy && headers.length === 0 ? "Reading…" : "Map columns"}
          </button>
        </div>
      </div>

      {headers.length > 0 && (
        <div className="card">
          <div className="section-title">
            Column mapping — {rowCount} rows. Check each column; unmapped
            columns are ignored.
          </div>
          <table>
            <thead>
              <tr>
                <th>CSV column</th>
                <th>Fills</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {headers.map((h) => (
                <tr key={h}>
                  <td>
                    <code>{h}</code>
                  </td>
                  <td>
                    <select
                      value={mapping[h] ?? ""}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [h]: e.target.value }))
                      }
                    >
                      {SPECIAL_TARGETS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label} ({f.type.replace("_", " ")})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="sub-inline">{rationales[h] ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button className="primary" disabled={busy} onClick={runPreflight}>
              Run pre-flight
            </button>
          </div>
        </div>
      )}

      {preflight && !batch && (
        <div className="card">
          <div className="section-title">
            Pre-flight — {readyCount} ready
            {(preflight.counts["needs_attention"] ?? 0) > 0 &&
              `, ${preflight.counts["needs_attention"]} need attention`}
            {(preflight.counts["skipped"] ?? 0) > 0 &&
              `, ${preflight.counts["skipped"]} skipped (already have contracts)`}
            . Nothing has been generated or sent.
          </div>
          <table>
            <thead>
              <tr>
                <th>Row</th>
                <th>State</th>
                {mappedFieldKeys.slice(0, 4).map((k) => (
                  <th key={k}>{k}</th>
                ))}
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {preflight.items.map((it) => (
                <tr key={it.subjectRef}>
                  <td>{it.subjectRef}</td>
                  <td>
                    <span className={`state ${it.state}`}>
                      {STATE_LABEL[it.state] ?? it.state}
                    </span>
                  </td>
                  {mappedFieldKeys.slice(0, 4).map((k) => (
                    <td key={k}>{it.values[k] ?? "—"}</td>
                  ))}
                  <td className="sub-inline">
                    {it.outliers.map((o) => (
                      <span key={o.fieldKey} className="outlier">
                        {o.fieldKey} {o.value} stands out (most are ~{o.median}){" "}
                      </span>
                    ))}
                    {it.duplicateOf
                      ? "Already has an active contract — will be skipped."
                      : it.issues[0]?.message}
                    {it.issues.length > 1 && ` (+${it.issues.length - 1} more)`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button
              className="primary"
              disabled={busy || readyCount === 0}
              onClick={() => void batchAction("send")}
            >
              Send {readyCount} contract{readyCount === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}

      {batch && (
        <div className="card">
          <div className="section-title">
            {batch.status === "completed"
              ? "Batch complete"
              : batch.status === "paused"
                ? "Paused — nothing else goes out until you resume"
                : "Sending…"}
          </div>
          <p className="sub">
            {Object.entries(batch.counts)
              .map(([s, n]) => `${n} ${STATE_LABEL[s] ?? s}`)
              .join(" · ")}
          </p>
          <table>
            <tbody>
              {batch.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.subjectRef}</td>
                  <td>
                    <span className={`state ${it.state}`}>
                      {STATE_LABEL[it.state] ?? it.state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            {batch.status === "sending" && (
              <button disabled={busy} onClick={() => void batchAction("pause")}>
                Pause
              </button>
            )}
            {batch.status === "paused" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void batchAction("resume")}
              >
                Resume
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
