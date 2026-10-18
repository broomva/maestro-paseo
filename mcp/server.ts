import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Snapshot, VIEWS } from "../shared/mcp";
import { answerDecisionAsk, createBackend } from "./backend";

export const APP_URI = "ui://maestro/control.html";

export function createServer(
  read: () => Promise<Snapshot>,
  html: () => Promise<string>,
  onAnswer?: (params: { ledger: string; id: string; option?: string | null; note?: string }) => Promise<{
    ok: boolean;
    ask?: unknown;
    warning?: string | null;
    error?: string;
  }>,
) {
  const server = new McpServer({ name: "maestro", version: "0.2.0" });
  const result = async (view = "feed") => {
    const snapshot = await read();
    return {
      content: [
        {
          type: "text" as const,
          text: `${snapshot.source === "sample" ? "Sample" : "Live"} Maestro ${view}.`,
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
      description: "Open the Maestro control surface. Shows holds, decisions, work, health and initiatives.",
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
      description: "Read a fresh snapshot from the existing Maestro runtime.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: APP_URI, visibility: ["app", "model"] } },
    },
    () => result(),
  );

  registerAppTool(
    server,
    "maestro_answer_ask",
    {
      title: "Answer Maestro Decision",
      description:
        "Submit an answer to an open decision ask in Maestro, committing the choice and optional note into the ledger.",
      inputSchema: {
        ledger: z.string().describe("Ledger name in .control/asks (e.g. bro-2827-answers-landing.yaml)"),
        id: z.string().describe("Ask identifier"),
        option: z.string().nullable().optional().describe("Option id chosen, if any"),
        note: z.string().optional().default("").describe("Answer note or custom text"),
      },
      _meta: { ui: { resourceUri: APP_URI, visibility: ["app", "model"] } },
    },
    async ({ ledger, id, option, note }) => {
      const handler = onAnswer ?? answerDecisionAsk;
      const res = await handler({ ledger, id, option, note });
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed to answer decision ${id}: ${res.error}` }],
        };
      }
      const snapshot = await read();
      return {
        content: [
          {
            type: "text" as const,
            text: `Answer recorded for decision ${id} in ${ledger}${option ? ` (option: ${option})` : ""}.`,
          },
        ],
        structuredContent: { ok: true, ask: res.ask, warning: res.warning, snapshot },
      };
    },
  );

  registerAppResource(server, "Maestro", APP_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [
      { uri: APP_URI, mimeType: RESOURCE_MIME_TYPE, text: await html(), _meta: { ui: { prefersBorder: false } } },
    ],
  }));

  return server;
}

if (import.meta.main) {
  const isDemo = process.argv.includes("--demo");
  const server = createServer(createBackend({ demo: isDemo }), () =>
    readFile(join(import.meta.dir, "dist/maestro.html"), "utf8"),
  );
  await server.connect(new StdioServerTransport());
}
