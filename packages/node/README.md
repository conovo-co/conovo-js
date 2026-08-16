# @conovo/node

Server SDK for [Conovo](https://conovo.co) — embeddable contract
infrastructure. This package is the **only** place your Conovo secret key
belongs: it mints the short-lived session tokens your frontend uses, and
verifies signatures on webhooks and data-connector requests.

```bash
npm install @conovo/node
```

## Mint session tokens (required)

Your server exchanges its secret key for a 15-minute, workspace-scoped JWT.
Hand only the token to the browser; re-mint freely on expiry.

```ts
import { Conovo, ConovoError } from "@conovo/node";

const conovo = new Conovo({ secretKey: process.env.EASYLEGAL_SECRET_KEY });

// e.g. a Next.js route handler at /api/conovo/session
export async function POST() {
  // 1. No authenticated user, no token.
  const currentUser = await getSignedInUser();
  if (!currentUser) return new Response("Not signed in", { status: 401 });

  try {
    const session = await conovo.sessions.create({
      // 2. The workspace comes from THIS user's own record — never from the
      //    request. See the warning below.
      workspace: {
        externalRef: currentUser.firm.id,
        name: currentUser.firm.name,
      },
      user: { id: currentUser.id, role: currentUser.role }, // audit attribution
    });
    return Response.json(session); // { token, expiresAt }
  } catch (err) {
    if (err instanceof ConovoError) {
      // 402 + reason "account_lapsed" → render your locked/paywall state.
      return Response.json({ error: err.message, reason: err.reason }, { status: err.status });
    }
    throw err;
  }
}
```

Workspaces are upserted by `externalRef` — no separate provisioning call.

> **This route is a security boundary.** The token it returns grants full
> access to one workspace's contracts: read every PDF, send new ones. Conovo
> has no way to second-guess which workspace you asked for — it trusts your
> server's assertion, which is exactly why the secret key lives on your side.
>
> So never mint without an authenticated user, and never read `externalRef`
> out of the request. A route that does lets any visitor name any workspace and
> receive a working token for it. That is a cross-tenant breach on your
> platform, and it looks like ordinary traffic on ours — nothing we log will
> flag it.
>
> Tokens last 15 minutes and the browser re-mints through this route, so the
> check runs continuously rather than once at page load. Passing `user` is
> optional but worth it: Conovo records it as the actor on every mutation,
> so a signed contract's audit trail names who sent it.

## Verify webhooks

Conovo signs outbound webhooks HMAC-SHA256 over `${timestamp}.${body}`
(`conovo-signature: t=<unix>,v1=<hex>`), with a freshness tolerance so
captured requests can't be replayed.

```ts
const ok = conovo.webhooks.verify(rawBody, req.headers["conovo-signature"], signingSecret);
```

## Data connector (bulk & background sends)

When a send references one of your records by id instead of inlining the
payload, Conovo fetches it from the connector URL you registered in the
dashboard. Verify the signature over the **raw** body, scope the lookup, and
return the same payload shape you registered:

```ts
export async function POST(req: Request) {
  const raw = await req.text();
  if (!conovo.connector.verify(raw, req.headers.get("x-conovo-signature") ?? "", signingSecret))
    return Response.json({ error: "bad signature" }, { status: 401 });

  const { subjectRef, workspaceExternalRef } = JSON.parse(raw);
  // Scope by BOTH, in the query itself — see the warning below.
  const record = await findRecord(workspaceExternalRef, subjectRef);
  if (!record) return Response.json({ error: "unknown subject" }, { status: 404 });
  return Response.json(record.payload);
}
```

> **The signature proves the request came from us. It does not prove the
> subject belongs to the workspace asking.** `subjectRef` originates with one
> of your business users, so a lookup that ignores `workspaceExternalRef` lets
> one customer pull another customer's record into a contract — with every
> signature check passing. Filter on both in a single query rather than
> looking up first and checking after, and return the same 404 for "no such
> record" as for "not yours", so the endpoint isn't an oracle for which ids
> exist on your platform.

Your signing secret lives in the Conovo dashboard (Payload schema →
Data connector). Zero dependencies; Node 18+.
