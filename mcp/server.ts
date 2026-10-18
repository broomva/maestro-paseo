import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Snapshot, VIEWS } from "../shared/mcp";
import { createBackend } from "./backend";

export const APP_URI = "ui://maestro/control.html";
export function createServer(read: () => Promise<Snapshot>, html: () => Promise<string>) {
  const server = new McpServer({ name: "maestro", version: "0.1.0" });
  const result = async (view = "feed") => {
    const snapshot = await read();
    return {
      content: [
        {
          type: "text" as const,
          text: `${snapshot.source === "sample" ? "Sample" : "Read-only"} Maestro ${view}. Owner actions remain in Paseo.`,
        },
      ],
      structuredContent: { snapshot, view },
    };
  };
  registerAppTool(
    server,
    "maestro_open",
    {
      title: "Open Maestro",
      description:
        "Open the read-only Maestro control surface. Shows holds, decisions, work, health and initiatives. Does not start work or answer asks.",
      inputSchema: { view: z.enum(VIEWS).default("feed") },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: APP_URI } },
    },
    ({ view }) => result(view),
  );
  registerAppTool(
    server,
    "maestro_snapshot",
    {
      title: "Refresh Maestro",
      description: "Read a fresh snapshot from the existing Maestro runtime. No mutations.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: APP_URI, visibility: ["app", "model"] } },
    },
    () => result(),
  );
  registerAppResource(server, "Maestro", APP_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [
      { uri: APP_URI, mimeType: RESOURCE_MIME_TYPE, text: await html(), _meta: { ui: { prefersBorder: false } } },
    ],
  }));
  return server;
}
if (import.meta.main) {
  const server = createServer(
    createBackend({ demo: process.argv.includes("--demo"), socket: process.env.MAESTRO_MCP_SOCKET }),
    () => readFile(join(import.meta.dir, "dist/maestro.html"), "utf8"),
  );
  await server.connect(new StdioServerTransport());
}
