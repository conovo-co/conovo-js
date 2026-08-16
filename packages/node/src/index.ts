import { signWebhook, verifyWebhook } from "./webhooks.js";

/**
 * @conovo/node — the server SDK, and the ONLY place a host platform
 * touches its secret key (ARCHITECTURE §2). Mints short-lived session tokens
 * for the browser SDK and verifies Conovo webhook signatures. Zero
 * dependencies: fetch + node:crypto.
 */

export interface SessionWorkspace {
  /** The platform's own ID for this business (stable across renames). */
  externalRef: string;
  /** Display name; kept current on every mint. */
  name: string;
}

export interface CreateSessionInput {
  workspace: SessionWorkspace;
  /** Optional end-user attribution, embedded in the token claims. */
  user?: { id: string; role?: string };
}

export interface Session {
  token: string;
  /** ISO timestamp the token stops working (15 minutes; re-mint freely). */
  expiresAt: string;
}

export class ConovoError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Machine-readable reason from the problem+json body, e.g. "account_lapsed". */
    public readonly reason?: string,
  ) {
    super(message);
  }
}

export class Conovo {
  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor(opts: { secretKey: string; baseUrl?: string }) {
    if (!opts.secretKey?.startsWith("sk_"))
      throw new Error("Conovo: secretKey must be an sk_… key (server-side only)");
    this.secretKey = opts.secretKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.conovo.co").replace(/\/$/, "");
  }

  readonly sessions = {
    /**
     * Mint a session token for one workspace. Call from your server on page
     * load / token expiry; hand only the token to the browser. Throws
     * ConovoError with status 402 and a machine-readable reason when the
     * account is not entitled.
     */
    create: async (input: CreateSessionInput): Promise<Session> => {
      const res = await fetch(`${this.baseUrl}/v1/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          title?: string;
          reason?: string;
        };
        throw new ConovoError(
          body.title ?? `session minting failed (${res.status})`,
          res.status,
          body.reason,
        );
      }
      return (await res.json()) as Session;
    },
  };

  readonly webhooks = {
    /** Verify an Conovo webhook (`conovo-signature` header). */
    verify: (payload: string, signatureHeader: string, signingSecret: string) =>
      verifyWebhook(payload, signatureHeader, signingSecret),
  };

  readonly connector = {
    /**
     * Verify a data-connector request from Conovo
     * (`x-conovo-signature` header over the raw body). Same HMAC scheme
     * as webhooks; the secret is your account's signing secret from the
     * dashboard. Return your subject's payload JSON on a match; 401 anything
     * that fails.
     */
    verify: (payload: string, signatureHeader: string, signingSecret: string) =>
      verifyWebhook(payload, signatureHeader, signingSecret),
  };
}

export { signWebhook, verifyWebhook };
