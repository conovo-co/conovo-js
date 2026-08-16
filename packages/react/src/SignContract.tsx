"use client";

import { useCallback, useEffect, useState } from "react";
import { LockedGate, useConovo } from "./context.js";

/**
 * <SignContract> — signing inside your product, instead of sending someone to
 * their email and hoping they come back.
 *
 * The honest caveat, stated here because it decides the design: whether a
 * signing page can be framed at all is the PROVIDER's decision, not ours. Most
 * send X-Frame-Options or a frame-ancestors CSP that refuses embedding from
 * another origin, and a browser gives the parent page no error when it
 * happens — the frame simply stays blank. So this never assumes the frame
 * worked: it waits for a load, and if none arrives it shows the link instead.
 * A blank rectangle where a contract should be is worse than a button.
 *
 * Phone-verified signing: a recipient sent with a mobile number has their
 * signing link withheld by the API until they confirm a one-time SMS code.
 * The gate below runs that flow — text the code, take six digits, release
 * the link — and the verification lands in the contract's audit trail.
 */

interface SigningLink {
  id: string;
  role: string;
  name: string;
  email: string;
  signOrder: number;
  signUrl: string | null;
  verification: { required: boolean; verified: boolean; phoneMasked: string } | null;
}

interface SigningLinks {
  contractId: string;
  status: string;
  complete: boolean;
  recipients: SigningLink[];
}

/** How long to wait for the frame before offering the link instead. */
const FRAME_TIMEOUT_MS = 4000;

/**
 * The identity gate: "we'll text a code to ••• ••• ••67" → six digits →
 * signUrl. Enhances, never gates silently: every state names what happens.
 */
function VerifyGate({
  contractId,
  signer,
  onVerified,
}: {
  contractId: string;
  signer: SigningLink;
  onVerified: (signUrl: string | null) => void;
}) {
  const { apiFetch } = useConovo();
  const [stage, setStage] = useState<"idle" | "sending" | "sent" | "checking">("idle");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStage("sending");
    setError(null);
    try {
      const res = await apiFetch(`/v1/contracts/${contractId}/verify/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipientId: signer.id }),
      });
      const d = (await res.json()) as { title?: string; verified?: boolean };
      if (!res.ok) throw new Error(d.title ?? "couldn't send the code");
      if (d.verified) return onVerified(null); // already verified — reload links
      setStage("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("idle");
    }
  };

  const check = async () => {
    setStage("checking");
    setError(null);
    try {
      const res = await apiFetch(`/v1/contracts/${contractId}/verify/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipientId: signer.id, code: code.trim() }),
      });
      const d = (await res.json()) as { title?: string; signUrl?: string | null };
      if (!res.ok) throw new Error(d.title ?? "that code didn't match");
      onVerified(d.signUrl ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("sent");
    }
  };

  return (
    <div className="verifygate">
      <strong>Confirm it&apos;s you</strong>
      <p className="sub" style={{ margin: "4px 0 12px" }}>
        {signer.name}, before signing we&apos;ll confirm your identity with a
        text message to {signer.verification?.phoneMasked}. The verification is
        recorded with the signature.
      </p>
      {stage === "idle" || stage === "sending" ? (
        <button className="primary" disabled={stage === "sending"} onClick={() => void start()}>
          {stage === "sending" ? "Sending…" : "Text me a code"}
        </button>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="expr"
            style={{ width: 120, textAlign: "center", letterSpacing: "0.2em" }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            placeholder="123456"
            aria-label="Verification code from the text message"
            // The button that was focused just disappeared; land the keyboard
            // where the flow continues.
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && code.trim().length >= 4 && stage !== "checking")
                void check();
            }}
          />
          <button
            className="primary"
            disabled={stage === "checking" || code.trim().length < 4}
            onClick={() => void check()}
          >
            {stage === "checking" ? "Checking…" : "Verify"}
          </button>
          <button className="ghost" disabled={stage === "checking"} onClick={() => void start()}>
            Resend
          </button>
        </div>
      )}
      {error && <p className="error" role="alert" style={{ marginTop: 10 }}>{error}</p>}
    </div>
  );
}

interface ExplainAnswer {
  answer: string;
  grounded: boolean;
  quotes: string[];
}

/**
 * "What does this say about…?" — grounded Q&A over the document the signer
 * is looking at. Answers only describe the document (the API refuses advice
 * and says plainly when the document is silent); the disclaimer is static
 * text here, not model output.
 */
function AskPanel({ contractId }: { contractId: string }) {
  const { apiFetch } = useConovo();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExplainAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    const q = question.trim();
    if (q.length < 5 || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setAsked(q);
    try {
      const res = await apiFetch(`/v1/contracts/${contractId}/explain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const d = (await res.json()) as ExplainAnswer & { title?: string };
      if (!res.ok) throw new Error(d.title ?? "couldn't answer that just now");
      setResult(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="askpanel">
      <summary>Questions about this contract?</summary>
      <div className="askpanel-body">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="expr"
            style={{ flex: 1 }}
            value={question}
            maxLength={500}
            placeholder="What happens if I cancel after paying the deposit?"
            aria-label="Ask a question about this contract"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void ask();
            }}
          />
          <button className="primary" disabled={busy || question.trim().length < 5} onClick={() => void ask()}>
            {busy ? "Reading…" : "Ask"}
          </button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {/* Announced when the async answer lands; a sighted user sees it
            appear, a screen-reader user shouldn't have to go hunting. */}
        <div aria-live="polite">
          {result && (
            <div className="askpanel-answer">
              <p className="sub" style={{ margin: "0 0 6px", fontSize: 12.5 }}>{asked}</p>
              <p style={{ margin: 0 }}>{result.answer}</p>
              {result.grounded && result.quotes.length > 0 && (
                <ul className="askpanel-quotes">
                  {result.quotes.map((q, i) => (
                    <li key={i}>&ldquo;{q}&rdquo;</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <p className="sub askpanel-disclaimer">
          Answers are AI-generated and describe this document only — they
          aren&apos;t legal advice, and no person reviews them. For whether
          it&apos;s right for you, ask the sender or your own advisor.
        </p>
      </div>
    </details>
  );
}

export function SignContract({
  contractId,
  /** Which signer to show; defaults to the first in signing order. */
  role,
  height = 720,
  onOpened,
}: {
  contractId: string;
  role?: string;
  height?: number;
  onOpened?: (url: string) => void;
}) {
  const { apiFetch } = useConovo();
  const [links, setLinks] = useState<SigningLinks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [framed, setFramed] = useState<"waiting" | "ok" | "refused">("waiting");
  /** signUrl released by the verify gate, ahead of the next links reload. */
  const [releasedUrl, setReleasedUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch(`/v1/contracts/${contractId}/signing-links`);
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { title?: string; reason?: string };
        throw new Error(
          d.reason === "not_sent"
            ? "This contract hasn't been sent for signature yet."
            : (d.title ?? "couldn't load the signing link"),
        );
      }
      setLinks((await res.json()) as SigningLinks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiFetch, contractId]);

  useEffect(() => {
    void load();
  }, [load]);

  const candidate =
    links?.recipients.find((r) => (role ? r.role === role : true)) ?? null;
  const needsVerification =
    !!candidate?.verification && !candidate.verification.verified && !releasedUrl;
  const signUrl = releasedUrl ?? candidate?.signUrl ?? null;

  // Nothing said the frame failed — nothing ever does, cross-origin. So treat
  // silence past the timeout as a refusal and fall back.
  useEffect(() => {
    if (!signUrl || framed !== "waiting") return;
    const t = setTimeout(() => setFramed((s) => (s === "waiting" ? "refused" : s)), FRAME_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [signUrl, framed]);

  if (error)
    return (
      <div className="conovo">
        <p className="error" role="alert">{error}</p>
      </div>
    );
  if (!links) return <div className="conovo"><p className="sub">Loading…</p></div>;

  if (links.complete)
    return (
      <div className="conovo">
        <div className="notice">
          This contract is {links.status}. Signing is finished, so there is
          nothing left to sign here.
        </div>
      </div>
    );

  if (candidate && needsVerification)
    return (
      <LockedGate>
        <div className="conovo">
          <VerifyGate
            contractId={contractId}
            signer={candidate}
            onVerified={(url) => {
              if (url) setReleasedUrl(url);
              void load();
            }}
          />
        </div>
      </LockedGate>
    );

  if (!candidate || !signUrl)
    return (
      <div className="conovo">
        <div className="notice">
          No signing link for {role ? `the "${role}" signer` : "this contract"} yet.
        </div>
      </div>
    );

  return (
    <LockedGate>
      <div className="conovo">
        <div className="signframe">
          <div className="signframe-head">
            <strong>Sign this contract</strong>
            <span className="sub" style={{ margin: 0 }}>
              {candidate.name} · {candidate.email}
              {candidate.verification?.verified || releasedUrl ? " · identity verified" : ""}
            </span>
            <span className="spacer" />
            <a
              className="ghost"
              href={signUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => onOpened?.(signUrl)}
            >
              Open in a new tab ↗
            </a>
          </div>

          {framed === "refused" ? (
            <div className="notice" style={{ margin: 16 }}>
              This signing page can&apos;t be shown inside another site — that&apos;s
              the signing provider&apos;s setting, not something we can override.
              Use the link above; it opens the same document.
            </div>
          ) : (
            <iframe
              src={signUrl}
              title="Sign contract"
              style={{ width: "100%", height, border: 0, display: "block" }}
              onLoad={() => setFramed("ok")}
            />
          )}

          {/* E-SIGN/UETA consent, said where signing happens — the terms
              carry it contractually, but the signer deserves the sentence in
              front of them, with a named way out. Static text, always shown
              with the signing surface (framed or fallback link). */}
          <p className="sub signframe-consent">
            By signing electronically you agree to conduct this transaction by
            electronic records and signatures. If you&apos;d rather sign on
            paper, contact the sender before signing — their details are in
            the document.
          </p>
        </div>
        <AskPanel contractId={contractId} />
      </div>
    </LockedGate>
  );
}
