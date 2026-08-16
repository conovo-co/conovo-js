#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * `npx @conovo/mcp` — stdio MCP server for one Conovo account.
 *
 *   CONOVO_SECRET_KEY  (required) the account's sk key; sent only to
 *                      POST /admin/sessions, never stored anywhere
 *   CONOVO_API_URL     (optional) defaults to https://api.conovo.co
 *
 * Errors go to stderr: stdout belongs to the MCP protocol.
 */
const secretKey = process.env["CONOVO_SECRET_KEY"];
if (!secretKey || !secretKey.startsWith("sk_")) {
  console.error(
    "conovo-mcp: set CONOVO_SECRET_KEY to your account's secret key (sk_…).\n" +
      "Create one in the console under API keys. Use an sk_test_ key while integrating —\n" +
      "its sessions are test mode end to end.",
  );
  process.exit(1);
}

const server = createServer({
  secretKey,
  baseUrl: process.env["CONOVO_API_URL"] ?? "https://api.conovo.co",
});

await server.connect(new StdioServerTransport());
console.error("conovo-mcp: ready (tools for schema, sandbox, requests, webhooks)");
