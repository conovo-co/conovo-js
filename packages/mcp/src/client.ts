/**
 * Minimal admin-API client for the MCP server. Holds the secret key, mints
 * a short-lived admin token on demand, and re-mints transparently when it
 * expires. The secret key itself is sent only to POST /admin/sessions —
 * every other call carries the token.
 */

export interface ClientConfig {
  secretKey: string;
  baseUrl: string;
}

export class ConovoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class ConovoAdminClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  /** Shared in-flight mint, so parallel first calls sign in once, not twice. */
  private minting: Promise<string> | null = null;

  constructor(private readonly config: ClientConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  private adminToken(): Promise<string> {
    // 60s of slack so a token never expires mid-request.
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000)
      return Promise.resolve(this.token);
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  private async mint(): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/admin/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.secretKey}` },
    });
    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      expiresAt?: string;
      title?: string;
    };
    if (!res.ok || !body.token)
      throw new ConovoApiError(
        `${body.title ?? `sign-in failed (${res.status})`} — check CONOVO_SECRET_KEY`,
        res.status,
      );
    this.token = body.token;
    this.tokenExpiresAt = body.expiresAt ? Date.parse(body.expiresAt) : Date.now() + 600_000;
    return this.token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.adminToken();
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new ConovoApiError(
        String(json["title"] ?? json["error"] ?? `${method} ${path} failed (${res.status})`),
        res.status,
      );
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
}
