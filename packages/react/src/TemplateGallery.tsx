"use client";

import { useEffect, useState } from "react";
import { useConovo } from "./context.js";

/**
 * <TemplateGallery> — the platform's starter templates (SPEC §3.6.1), for the
 * business that doesn't have a contract of its own. Adoption copies the
 * starter into a normal workspace template; nothing stays linked to the shelf.
 *
 * Renders nothing when the platform hasn't published any starters, so hosts
 * can mount it unconditionally next to the upload flow.
 */

export interface GalleryEntry {
  id: string;
  name: string;
  description: string;
  jurisdiction: string;
  fieldCount: number;
  boundCount: number;
  publishedAt: string;
}

export interface AdoptedTemplate {
  templateId: string;
  templateVersionId: string;
  name: string;
  fieldCount: number;
  /** workspace_default fields with no saved value yet — the firm's next step. */
  standingNeeded: { key: string; label: string; type: string }[];
}

export function TemplateGallery({
  onAdopted,
  title = "Start from a ready-made template",
  variant,
}: {
  /**
   * Where "see your template" on the success card goes — typically standing
   * terms when `standingNeeded` is non-empty, else the templates list. A slot
   * because the package doesn't own routing; without it the card is terminal.
   */
  onAdopted?: (result: AdoptedTemplate) => void;
  title?: string;
  /**
   * "panel" renders the shelf as one self-contained choice card — title,
   * subtext, starters, CTA — shaped to sit beside
   * <ContractStudio variant="panel"> in a `.chooser` grid.
   */
  variant?: "panel";
} = {}) {
  const { apiFetch } = useConovo();
  const [entries, setEntries] = useState<GalleryEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<AdoptedTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const res = await apiFetch(`/v1/gallery`);
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as { gallery: GalleryEntry[] };
        if (!stop) setEntries(d.gallery);
      } catch {
        // A broken shelf must never break the page it's embedded in.
        if (!stop) setEntries([]);
      }
    })();
    return () => {
      stop = true;
    };
  }, [apiFetch]);

  async function adopt(entry: GalleryEntry) {
    setBusyId(entry.id);
    setError(null);
    try {
      const res = await apiFetch(`/v1/gallery/${entry.id}/adopt`, { method: "POST" });
      const d = (await res.json()) as AdoptedTemplate & { title?: string };
      if (!res.ok) throw new Error(d.title ?? "couldn't adopt that template");
      setAdopted(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  // Nothing published → nothing rendered; the host page stays clean.
  if (!entries || entries.length === 0) return null;

  if (adopted)
    return (
      <div className="conovo">
        <div className="success gallery-done" style={{ maxWidth: 560 }}>
          <h2 style={{ marginTop: 0 }}>&ldquo;{adopted.name}&rdquo; is yours now</h2>
          <p>
            It&apos;s set up and ready —{" "}
            <strong>
              {adopted.fieldCount - adopted.standingNeeded.length} of{" "}
              {adopted.fieldCount}
            </strong>{" "}
            fields already know where their values come from.
          </p>
          {adopted.standingNeeded.length > 0 && (
            <p className="sub">
              To finish, fill in{" "}
              {adopted.standingNeeded.length === 1 ? "your " : "your standing details: "}
              {adopted.standingNeeded.map((f) => f.label).join(", ")} — they save
              once and apply to every contract you send.
            </p>
          )}
          <p className="sub" style={{ fontSize: 12 }}>
            Ready-made templates are general documents, not legal advice — have
            your attorney review it before your first send.
          </p>
          {onAdopted && (
            <button className="primary" onClick={() => onAdopted(adopted)}>
              {adopted.standingNeeded.length > 0
                ? "Fill in your details"
                : "See your template"}
            </button>
          )}
        </div>
      </div>
    );

  // Choice-card form: same skeleton as the upload panel next to it.
  if (variant === "panel")
    return (
      <section className="conovo panel">
        <h2 className="panel-title">{title}</h2>
        <p className="panel-sub">
          No contract of your own yet? These come already set up to fill from
          your data — adopting one makes your own copy, yours to edit or
          replace with your attorney&apos;s version any time.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {entries.map((g) => {
          const pct =
            g.fieldCount > 0
              ? Math.round((g.boundCount / g.fieldCount) * 100)
              : 0;
          return (
            <div key={g.id} className="starter">
              <div className="gallery-card-head">
                <span className="gallery-card-name">{g.name}</span>
                {g.jurisdiction && (
                  <span className="gallery-chip">{g.jurisdiction}</span>
                )}
              </div>
              {g.description && (
                <p className="gallery-card-desc">{g.description}</p>
              )}
              <div className="gallery-fill">
                <span
                  className="gallery-fill-bar"
                  role="img"
                  aria-label={`${pct}% of fields fill automatically`}
                >
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="gallery-fill-label">
                  {g.boundCount} of {g.fieldCount} fields fill from your data
                </span>
              </div>
              <button
                className="primary panel-cta"
                disabled={busyId !== null}
                onClick={() => void adopt(g)}
              >
                {busyId === g.id ? "Setting it up…" : "Use this template"}
              </button>
            </div>
          );
        })}
        <p className="gallery-fineprint">
          Provided by your platform as general documents, not legal advice —
          have your attorney review before first use.
        </p>
      </section>
    );

  return (
    <div className="conovo gallery">
      <div className="gallery-head">
        <p className="gallery-eyebrow">{title}</p>
        <p className="gallery-lede">
          No contract of your own yet? These come already set up to fill from
          your data — adopting one makes your own copy, yours to edit or
          replace with your attorney&apos;s version any time.
        </p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="gallery-grid">
        {entries.map((g) => {
          const pct =
            g.fieldCount > 0
              ? Math.round((g.boundCount / g.fieldCount) * 100)
              : 0;
          return (
            <div key={g.id} className="gallery-card">
              <div className="gallery-card-head">
                <span className="gallery-card-name">{g.name}</span>
                {g.jurisdiction && (
                  <span className="gallery-chip">{g.jurisdiction}</span>
                )}
              </div>
              {g.description && (
                <p className="gallery-card-desc">{g.description}</p>
              )}
              <div className="gallery-fill">
                <span
                  className="gallery-fill-bar"
                  role="img"
                  aria-label={`${pct}% of fields fill automatically`}
                >
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="gallery-fill-label">
                  {g.boundCount} of {g.fieldCount} fields fill from your data
                </span>
              </div>
              <button
                className="primary gallery-adopt"
                disabled={busyId !== null}
                onClick={() => void adopt(g)}
              >
                {busyId === g.id ? "Setting it up…" : "Use this template"}
              </button>
            </div>
          );
        })}
      </div>
      <p className="gallery-fineprint">
        Provided by your platform as general documents, not legal advice — have
        your attorney review before first use.
      </p>
    </div>
  );
}
