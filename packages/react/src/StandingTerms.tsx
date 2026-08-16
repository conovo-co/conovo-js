"use client";

import { useEffect, useState } from "react";
import type { FieldType, SerializedValue } from "@conovo/core";
import { editStringForValue, tryParseInput } from "./values.js";
import { LockedGate, useConovo } from "./context.js";

/**
 * Workspace "standing terms" (SPEC §3.2 workspace_default): values the
 * business sets once — payment terms, their address, signature block — that
 * then auto-fill every contract. Lists every workspace_default field across
 * the workspace's templates and drives the user to fill the unset ones.
 */

interface DefaultEntry {
  key: string;
  label: string | null;
  type: string | null;
  value: SerializedValue | null;
}

interface Row extends DefaultEntry {
  raw: string;
  savedRaw: string;
}

/**
 * <StandingTerms> — the workspace's set-once values (SPEC §3.2
 * workspace_default): payment terms, the business's address, signature
 * block. Every value here auto-fills all future contracts.
 */
export function StandingTerms() {
  return (
    <LockedGate>
      <div className="conovo">
        <TermsEditor />
      </div>
    </LockedGate>
  );
}

function TermsEditor() {
  const { apiFetch } = useConovo();
  const [workspaceName, setWorkspaceName] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`/v1/workspace/defaults`)
      .then(async (res) => {
        const data = (await res.json()) as {
          workspaceName: string;
          defaults: DefaultEntry[];
        };
        setWorkspaceName(data.workspaceName);
        setRows(
          data.defaults.map((e) => {
            const raw = e.value ? editStringForValue(e.value) : "";
            return { ...e, raw, savedRaw: raw };
          }),
        );
      })
      .catch(() => setError("API not reachable — is apps/api running on :4100?"));
  }, []);

  function rowState(r: Row): { error?: string; dirty: boolean } {
    const dirty = r.raw.trim() !== r.savedRaw.trim();
    if (!r.raw.trim()) return { dirty };
    const parsed = tryParseInput((r.type ?? "text") as FieldType, r.raw);
    return "error" in parsed ? { error: parsed.error, dirty } : { dirty };
  }

  const dirtyRows = rows?.filter((r) => rowState(r).dirty) ?? [];
  const hasInvalid = dirtyRows.some((r) => !!rowState(r).error);

  async function save() {
    if (!rows) return;
    setSaving(true);
    setError(null);
    try {
      const set: { key: string; value: SerializedValue }[] = [];
      const remove: string[] = [];
      for (const r of dirtyRows) {
        if (!r.raw.trim()) {
          remove.push(r.key);
          continue;
        }
        const parsed = tryParseInput((r.type ?? "text") as FieldType, r.raw);
        if ("error" in parsed) throw new Error(`"${r.label ?? r.key}": ${parsed.error}`);
        set.push({ key: r.key, value: parsed.value });
      }
      const res = await apiFetch(`/v1/workspace/defaults`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ set, remove }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: unknown };
      if (!res.ok) throw new Error(typeof d.error === "string" ? d.error : "save failed");
      setRows((rs) => rs?.map((r) => ({ ...r, savedRaw: r.raw })) ?? null);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (error && !rows) return <p className="error">{error}</p>;
  if (!rows) return <p><span className="spinner" />Loading…</p>;

  const unset = rows.filter((r) => !r.raw.trim()).length;

  return (
    <>
      <h1>Standing terms</h1>
      <p className="sub">
        Values {workspaceName || "your business"} sets once — payment terms, your
        address, signature block. They fill in automatically on every contract.
        {unset > 0 && <> <strong>{unset} still need a value.</strong></>}
      </p>

      {rows.length === 0 ? (
        <div className="card" style={{ maxWidth: 560 }}>
          <p>
            Nothing here yet. Upload a contract and mark fields as
            “Your standing terms” — they’ll show up here.
          </p>
        </div>
      ) : (
        <div className="card" style={{ maxWidth: 640 }}>
          {rows.map((r, i) => {
            const state = rowState(r);
            return (
              <div key={r.key} style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
                  {r.label ?? r.key}
                  {r.type && <span className="sub" style={{ fontWeight: 400 }}> · {r.type.replace("_", " ")}</span>}
                </label>
                <input
                  className="expr"
                  style={{ width: "100%" }}
                  value={r.raw}
                  placeholder={r.type === "date" ? "e.g. 2026-08-03" : "no value set"}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs?.map((x, j) => (j === i ? { ...x, raw: e.target.value } : x)) ?? null,
                    )
                  }
                />
                {state.error && (
                  <span className="error" style={{ fontSize: 12 }}>{state.error}</span>
                )}
              </div>
            );
          })}
          <button
            className="primary"
            disabled={saving || dirtyRows.length === 0 || hasInvalid}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : savedFlash ? "Saved ✓" : `Save changes (${dirtyRows.length})`}
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </>
  );
}
