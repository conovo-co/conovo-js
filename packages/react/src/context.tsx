"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * <ConovoProvider> — the SDK's root (ARCHITECTURE §2). Talks only to the
 * Conovo API with a short-lived session token the HOST's server mints;
 * no secret material ever reaches this package. When minting or a request
 * comes back 402, every component renders the locked state (server-side
 * enforcement is the real gate — this is just honest UI).
 */

export interface ConovoSession {
  token: string;
  /** ISO timestamp; the provider re-mints ~30s before expiry. */
  expiresAt: string;
}

export interface LockedState {
  reason?: string;
}

interface ConovoContextValue {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  fetchPdfUrl: (contractId: string) => Promise<string>;
  locked: LockedState | null;
  lockedFallback: ReactNode;
}

const Ctx = createContext<ConovoContextValue | null>(null);

export function useConovo(): ConovoContextValue {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("Conovo components must be rendered inside <ConovoProvider>");
  return ctx;
}

export function ConovoProvider({
  apiUrl,
  getSession,
  lockedFallback,
  children,
}: {
  /** Conovo API base, e.g. "https://api.conovo.co". */
  apiUrl: string;
  /**
   * Host-implemented token fetcher — typically a call to your own server
   * route that uses @conovo/node with your secret key. Throw an object
   * with `{status: 402, reason}` to signal the account isn't entitled.
   */
  getSession: () => Promise<ConovoSession>;
  /** Rendered by every component when the account/workspace isn't entitled. */
  lockedFallback?: ReactNode;
  children: ReactNode;
}) {
  const [locked, setLocked] = useState<LockedState | null>(null);
  const cache = useRef<{ token: string; expiresAt: number } | null>(null);
  const base = apiUrl.replace(/\/$/, "");

  const getToken = useCallback(async (): Promise<string> => {
    const c = cache.current;
    if (c && Date.now() < c.expiresAt - 30_000) return c.token;
    try {
      const session = await getSession();
      cache.current = {
        token: session.token,
        expiresAt: Date.parse(session.expiresAt),
      };
      setLocked(null);
      return session.token;
    } catch (err) {
      const e = err as { status?: number; reason?: string };
      if (e?.status === 402) {
        setLocked({ ...(e.reason ? { reason: e.reason } : {}) });
        throw new Error("not entitled");
      }
      throw err;
    }
  }, [getSession]);

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const token = await getToken();
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      });
      if (res.status === 402) {
        const body = (await res.clone().json().catch(() => ({}))) as {
          reason?: string;
        };
        setLocked({ ...(body.reason ? { reason: body.reason } : {}) });
      }
      return res;
    },
    [base, getToken],
  );

  const fetchPdfUrl = useCallback(
    async (contractId: string): Promise<string> => {
      const res = await apiFetch(`/v1/contracts/${contractId}/pdf`);
      if (!res.ok) throw new Error("PDF not available");
      return URL.createObjectURL(await res.blob());
    },
    [apiFetch],
  );

  const value = useMemo(
    () => ({
      apiFetch,
      fetchPdfUrl,
      locked,
      lockedFallback: lockedFallback ?? <DefaultLocked locked={locked} />,
    }),
    [apiFetch, fetchPdfUrl, locked, lockedFallback],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function DefaultLocked({ locked }: { locked: LockedState | null }) {
  return (
    <div className="conovo">
      <div className="card" style={{ maxWidth: 560 }}>
        <strong>Contracts aren&apos;t available right now.</strong>
        <p className="sub" style={{ margin: "6px 0 0" }}>
          {locked?.reason === "workspace_disabled"
            ? "This workspace has been disabled."
            : "This feature isn't enabled for your account — contact your platform's support."}
        </p>
      </div>
    </div>
  );
}

/** Gate helper: components call this to render locked state uniformly. */
export function LockedGate({ children }: { children: ReactNode }) {
  const { locked, lockedFallback } = useConovo();
  if (locked) return <>{lockedFallback}</>;
  return <>{children}</>;
}
