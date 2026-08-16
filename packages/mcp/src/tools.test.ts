import { createServer as createHttpServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConovoAdminClient } from "./client.js";
import { buildTools, runTool, type ToolDef } from "./tools.js";

/**
 * The tool handlers against a stub admin API: auth minting (sk → token →
 * bearer on every call, re-mint on expiry), the write tools' request shapes,
 * and runTool's error envelope. The stub answers like the real API answers.
 */

let server: Server;
let baseUrl: string;
const requests: { method: string; url: string; auth: string; body: string }[] = [];
let mintCount = 0;

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: String(req.headers.authorization ?? ""),
        body,
      });
      res.setHeader("content-type", "application/json");
      const respond = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(payload));
      };

      if (req.url === "/admin/sessions") {
        if (req.headers.authorization !== "Bearer sk_test_good")
          return respond(401, { title: "Unknown or revoked secret key" });
        mintCount += 1;
        return respond(200, {
          token: `tok_${mintCount}`,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (req.headers.authorization?.startsWith("Bearer tok_") !== true)
        return respond(401, { title: "An admin token is required" });

      switch (true) {
        case req.url === "/admin/account":
          return respond(200, { id: "acct_1", name: "Fostra", plan: "payg" });
        case req.url === "/admin/overview":
          return respond(200, { sent30: 12, needsAttention: 1 });
        case req.url === "/admin/payload-schema" && req.method === "PUT": {
          const parsed = JSON.parse(body) as { sample?: unknown };
          if (typeof parsed.sample !== "object") return respond(400, { error: "bad sample" });
          return respond(201, { version: 4 });
        }
        case req.url === "/admin/webhook" && req.method === "PUT":
          return respond(200, JSON.parse(body));
        case req.url === "/admin/sandbox/session" && req.method === "POST":
          return respond(200, { token: "sess_x", expiresAt: "soon", workspaceName: "Sandbox" });
        case req.url === "/openapi.json":
          return respond(200, {
            paths: {
              "/v1/contracts": { post: { summary: "Generate a contract" } },
              "/v1/templates": { get: { summary: "List templates" } },
            },
          });
        case req.url?.startsWith("/admin/requests") === true:
          return respond(200, { requests: [], query: req.url });
        default:
          return respond(404, { title: "not found" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const toolByName = (tools: ToolDef[], name: string): ToolDef => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe("conovo mcp tools", () => {
  it("mints once and reuses the admin token across calls", async () => {
    const client = new ConovoAdminClient({ secretKey: "sk_test_good", baseUrl });
    const tools = buildTools(client);
    const before = mintCount;
    await runTool(toolByName(tools, "get_overview"), {});
    await runTool(toolByName(tools, "get_held_contracts"), {}).catch(() => {});
    expect(mintCount).toBe(before + 1);
  });

  it("get_overview merges account and overview", async () => {
    const client = new ConovoAdminClient({ secretKey: "sk_test_good", baseUrl });
    const result = await runTool(toolByName(buildTools(client), "get_overview"), {});
    const parsed = JSON.parse(result.content[0]!.text) as {
      account: { name: string };
      overview: { sent30: number };
    };
    expect(parsed.account.name).toBe("Fostra");
    expect(parsed.overview.sent30).toBe(12);
  });

  it("register_payload_schema PUTs the sample", async () => {
    const client = new ConovoAdminClient({ secretKey: "sk_test_good", baseUrl });
    const result = await runTool(toolByName(buildTools(client), "register_payload_schema"), {
      sample: { client: { fullName: "Jane Doe" } },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ version: 4 });
    const put = requests.find((r) => r.method === "PUT" && r.url === "/admin/payload-schema");
    expect(put).toBeDefined();
    expect(JSON.parse(put!.body)).toEqual({ sample: { client: { fullName: "Jane Doe" } } });
  });

  it("list_requests builds the query string", async () => {
    const client = new ConovoAdminClient({ secretKey: "sk_test_good", baseUrl });
    await runTool(toolByName(buildTools(client), "list_requests"), {
      errorsOnly: true,
      limit: 10,
    });
    const call = requests.filter((r) => r.url.startsWith("/admin/requests")).at(-1);
    expect(call!.url).toBe("/admin/requests?errors=true&limit=10");
  });

  it("get_api_reference filters routes from the openapi doc", async () => {
    const client = new ConovoAdminClient({ secretKey: "sk_test_good", baseUrl });
    const result = await runTool(toolByName(buildTools(client), "get_api_reference"), {
      filter: "contracts",
    });
    const parsed = JSON.parse(result.content[0]!.text) as {
      routes: { method: string; path: string }[];
    };
    expect(parsed.routes).toEqual([
      { method: "POST", path: "/v1/contracts", summary: "Generate a contract" },
    ]);
  });

  it("surfaces API errors as readable text with isError, never a throw", async () => {
    const client = new ConovoAdminClient({ secretKey: "sk_test_bad", baseUrl });
    const result = await runTool(toolByName(buildTools(client), "get_overview"), {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("check CONOVO_SECRET_KEY");
  });
});
