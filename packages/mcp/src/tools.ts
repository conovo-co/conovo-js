import { z } from "zod";
import { ConovoAdminClient, ConovoApiError } from "./client.js";

/**
 * The MCP tool surface: everything a coding agent needs to integrate Conovo
 * into a host platform and then debug that integration. Reads plus the two
 * writes integration genuinely needs (payload schema, webhook URL) — no tool
 * here can touch a live contract, and none returns document content.
 *
 * Handlers are plain async functions (args → result object) kept separate
 * from the MCP wiring so they can be tested against a stub API.
 */

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: Handler;
}

export function buildTools(client: ConovoAdminClient): ToolDef[] {
  return [
    {
      name: "get_overview",
      description:
        "Account status and live contract metrics: plan, entitlement, contracts by status, 30-day send funnel, weekly send counts, held-contract count. Start here to see whether the integration is alive.",
      schema: {},
      handler: async () => {
        const [account, overview] = await Promise.all([
          client.get<Record<string, unknown>>("/admin/account"),
          client.get<Record<string, unknown>>("/admin/overview"),
        ]);
        return { account, overview };
      },
    },
    {
      name: "get_payload_schema",
      description:
        "The registered payload schema (latest sample + version history). Contract fields bind to paths in this sample — it is the contract between the host platform's data and Conovo.",
      schema: {},
      handler: async () => client.get("/admin/payload-schema"),
    },
    {
      name: "register_payload_schema",
      description:
        "Register a new sample payload (the JSON object the platform passes as `subject`). RULES THAT MATTER: money as MAJOR units (4500 = $4,500.00 — if the platform stores integer cents, convert in the sample AND in the real payload builder); dates as ISO strings; realistic but FAKE values (the sample is stored and displayed); shallow stable paths (they become bindings); arrays with 2-3 entries where contracts repeat rows. Versions are append-only — re-registering is safe, existing templates keep resolving against the shape they were built on.",
      schema: {
        sample: z
          .record(z.string(), z.unknown())
          .describe("The sample payload object — one representative record"),
      },
      handler: async (args) =>
        client.request("PUT", "/admin/payload-schema", { sample: args["sample"] }),
    },
    {
      name: "infer_payload_schema",
      description:
        "Propose a payload schema FROM existing artifacts — a sample API response (kind: json), an OpenAPI spec (kind: openapi), or a Prisma schema (kind: prisma). Returns a proposed sample plus warnings; READ THE WARNINGS (integer-cents money is the one mistake nothing downstream can catch). Read-only: registering stays register_payload_schema.",
      schema: {
        kind: z.enum(["json", "openapi", "prisma"]),
        text: z.string().max(200_000).describe("The artifact text"),
        hint: z
          .string()
          .max(500)
          .optional()
          .describe('Optional context, e.g. "contracts are per project, signed by the client"'),
      },
      handler: async (args) =>
        client.request("POST", "/admin/payload-schema/infer", {
          kind: args["kind"],
          text: args["text"],
          ...(args["hint"] ? { hint: args["hint"] } : {}),
        }),
    },
    {
      name: "get_payload_gaps",
      description:
        "Which contract fields keep missing from the payload or get typed by hand — a prioritized backlog of paths worth adding to the schema. Aggregated from real sends and template setups.",
      schema: {},
      handler: async () => client.get("/admin/payload-gaps"),
    },
    {
      name: "create_sandbox_session",
      description:
        "Mint a REAL /v1 session token against the account's dedicated Sandbox workspace (test mode: simulated signing, nothing metered, nothing binds). Use it to call the /v1 API directly — list templates, prepare and generate contracts, drive test signing events — exactly as the embedded SDK would. Returns the token, its expiry, and the API base URL.",
      schema: {},
      handler: async () => {
        const session = await client.request<Record<string, unknown>>(
          "POST",
          "/admin/sandbox/session",
        );
        return {
          ...session,
          apiBaseUrl: client.baseUrl,
          hint: "Authorization: Bearer <token> against /v1/* — see get_api_reference for routes. Tokens last 15 minutes; mint again freely.",
        };
      },
    },
    {
      name: "get_api_reference",
      description:
        "The API's routes with their summaries, from the live OpenAPI document. Use it to drive /v1 calls with a sandbox session token. Pass a path substring to filter (e.g. 'contracts').",
      schema: {
        filter: z.string().optional().describe("Substring filter on the path"),
      },
      handler: async (args) => {
        const spec = await client.get<{
          paths?: Record<string, Record<string, { summary?: string; description?: string }>>;
        }>("/openapi.json");
        const filter = typeof args["filter"] === "string" ? args["filter"] : "";
        const routes: { method: string; path: string; summary: string }[] = [];
        for (const [path, methods] of Object.entries(spec.paths ?? {})) {
          if (filter && !path.includes(filter)) continue;
          for (const [method, op] of Object.entries(methods))
            routes.push({ method: method.toUpperCase(), path, summary: op.summary ?? "" });
        }
        return { routes, fullSpecUrl: `${client.baseUrl}/openapi.json` };
      },
    },
    {
      name: "list_requests",
      description:
        "The request inspector: recent authenticated API calls with route, status, duration, and — on failures — the plain-English error and machine reason. No bodies are ever recorded. THE debugging surface for 'why did my call fail'.",
      schema: {
        errorsOnly: z.boolean().optional().describe("Only 4xx/5xx responses"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      handler: async (args) => {
        const q = new URLSearchParams();
        if (args["errorsOnly"]) q.set("errors", "true");
        if (typeof args["limit"] === "number") q.set("limit", String(args["limit"]));
        const qs = q.toString();
        return client.get(`/admin/requests${qs ? `?${qs}` : ""}`);
      },
    },
    {
      name: "get_held_contracts",
      description:
        "Live contracts currently held by validation instead of sent, with workspace/template names and the issue codes holding each (field keys only, never values). A pattern of the same field across workspaces usually means a payload gap.",
      schema: {},
      handler: async () => client.get("/admin/attention"),
    },
    {
      name: "list_events",
      description:
        "The account's audit trail, newest first — content-free by construction (ids, statuses, actors; never document content). Filter by type prefix, e.g. 'contract.' or 'account.'.",
      schema: {
        type: z.string().max(60).optional().describe("Type prefix filter"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      handler: async (args) => {
        const q = new URLSearchParams();
        if (typeof args["type"] === "string" && args["type"]) q.set("type", args["type"]);
        if (typeof args["limit"] === "number") q.set("limit", String(args["limit"]));
        const qs = q.toString();
        return client.get(`/admin/events${qs ? `?${qs}` : ""}`);
      },
    },
    {
      name: "get_webhook",
      description:
        "The outbound webhook config: the URL Conovo POSTs signed contract/batch status events to, plus the signing secret to verify them with (conovo.webhooks.verify in @conovo/node).",
      schema: {},
      handler: async () => client.get("/admin/webhook"),
    },
    {
      name: "set_webhook",
      description:
        "Set (or clear with null) the outbound webhook URL. Must be https and publicly reachable — private-network targets are refused. Follow with test_webhook to prove the endpoint verifies and answers.",
      schema: {
        url: z.union([z.string().url(), z.null()]).describe("HTTPS endpoint, or null to disable"),
      },
      handler: async (args) => client.request("PUT", "/admin/webhook", { url: args["url"] }),
    },
    {
      name: "test_webhook",
      description:
        "Queue a signed ping to the configured webhook URL and deliver it NOW. Returns the delivery status and the endpoint's response code — the 10-second loop for webhook setup.",
      schema: {},
      handler: async () => client.request("POST", "/admin/webhook/test"),
    },
  ];
}

/** Uniform MCP text result; errors come back as readable text, not throws. */
export async function runTool(tool: ToolDef, args: Record<string, unknown>) {
  try {
    const result = await tool.handler(args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message =
      err instanceof ConovoApiError
        ? `Conovo API error (${err.status}): ${err.message}`
        : `Error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}
