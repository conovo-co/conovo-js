"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LockedGate, useConovo } from "./context.js";

/**
 * <ContractInbox> — every contract with live signing status (SPEC §3.4.6).
 * `renderItemActions` is a slot for host-specific actions per contract; it
 * receives a refresh callback so actions can re-sync the list.
 */

export interface InboxContract {
  id: string;
  status: string;
  signingRef: string | null;
  createdAt: string;
  sentAt: string | null;
  signedAt: string | null;
  templateName: string;
  hasPdf: boolean;
  /** Test-mode contract: simulated signing, never metered. */
  test?: boolean;
  recipients: { name: string; email: string; role: string }[];
}

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "#667085" },
  needs_attention: { label: "Needs attention", color: "#b42318" },
  sent: { label: "Sent", color: "#175cd3" },
  viewed: { label: "Viewed", color: "#175cd3" },
  signed: { label: "Signed", color: "#1a7f4e" },
  completed: { label: "Completed", color: "#1a7f4e" },
  declined: { label: "Declined", color: "#b42318" },
};

export function ContractInbox({
  renderItemActions,
  emptyState,
}: {
  /** Slot: extra actions per contract row (receives a list-refresh callback). */
  renderItemActions?: (contract: InboxContract, refresh: () => Promise<void>) => ReactNode;
  emptyState?: ReactNode;
}) {
  return (
    <LockedGate>
      <div className="conovo">
        <InboxList
          {...(renderItemActions ? { renderItemActions } : {})}
          {...(emptyState !== undefined ? { emptyState } : {})}
        />
      </div>
    </LockedGate>
  );
}

function InboxList({
  renderItemActions,
  emptyState,
}: {
  renderItemActions?: (contract: InboxContract, refresh: () => Promise<void>) => ReactNode;
  emptyState?: ReactNode;
}) {
  const { apiFetch, fetchPdfUrl } = useConovo();
  const [rows, setRows] = useState<InboxContract[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiFetch(`/v1/workspace/contracts`);
    const data = (await res.json()) as { contracts: InboxContract[] };
    setRows(data.contracts);
  }, [apiFetch]);

  useEffect(() => {
    refresh().catch(() => setError("Conovo API not reachable"));
  }, [refresh]);

  async function openPdf(id: string) {
    window.open(await fetchPdfUrl(id), "_blank");
  }

  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p><span className="spinner" />Loading…</p>;

  if (rows.length === 0)
    return (
      <>{emptyState ?? (
        <div className="card" style={{ maxWidth: 560 }}>
          <p className="sub" style={{ margin: 0 }}>No contracts yet.</p>
        </div>
      )}</>
    );

  return (
    <>
      {rows.map((c) => {
        const st = STATUS_STYLE[c.status] ?? { label: c.status, color: "#667085" };
        return (
          <div key={c.id} className="card" style={{ maxWidth: 720, marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <strong>{c.templateName}</strong>
              <span style={{
                color: st.color, border: `1px solid ${st.color}`, borderRadius: 999,
                fontSize: 12, padding: "1px 10px",
              }}>
                {st.label}
              </span>
              {c.test && (
                <span
                  title="Test contract — simulated signing, never metered"
                  style={{
                    color: "#b54708", background: "#fffaeb", borderRadius: 999,
                    fontSize: 11, fontWeight: 600, padding: "2px 9px",
                    letterSpacing: "0.03em",
                  }}
                >
                  TEST
                </span>
              )}
              <span className="sub" style={{ margin: 0, fontSize: 13 }}>
                {c.recipients.map((r) => `${r.name} <${r.email}>`).join(", ") || "no recipients yet"}
              </span>
              <span style={{ flex: 1 }} />
              {c.hasPdf && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void openPdf(c.id);
                  }}
                >
                  PDF ↗
                </a>
              )}
            </div>
            <div className="sub" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
              created {new Date(c.createdAt).toLocaleString()}
              {c.sentAt && <> · sent {new Date(c.sentAt).toLocaleString()}</>}
              {c.signedAt && <> · signed {new Date(c.signedAt).toLocaleString()}</>}
            </div>
            {renderItemActions?.(c, refresh)}
          </div>
        );
      })}
    </>
  );
}
