import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConovoAdminClient } from "./client.js";
import { buildTools, runTool } from "./tools.js";

/**
 * Assemble the MCP server: one Conovo account (the secret key's), the tool
 * surface from tools.ts, nothing else. Transport is the caller's choice —
 * the CLI uses stdio.
 */
export function createServer(config: { secretKey: string; baseUrl: string }): McpServer {
  const client = new ConovoAdminClient(config);
  const server = new McpServer({ name: "conovo", version: "0.1.0" });
  for (const tool of buildTools(client)) {
    server.tool(tool.name, tool.description, tool.schema, (args: Record<string, unknown>) =>
      runTool(tool, args),
    );
  }
  return server;
}
