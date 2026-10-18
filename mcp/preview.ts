import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { answerDecisionAsk, createBackend } from "./backend";
import { buildApp } from "./build";

let cachedHtml = await buildApp();
const isDemo = process.argv.includes("--demo");
const read = createBackend({ demo: isDemo, socket: process.env.MAESTRO_MCP_SOCKET });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.MAESTRO_MCP_PREVIEW_PORT ?? 4318),
  async fetch(request) {
    const authority = request.headers.get("host");
    if (authority !== `127.0.0.1:${server.port}` && authority !== `localhost:${server.port}`)
      return new Response("Forbidden", { status: 403 });
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/answer") {
      try {
        const body = (await request.json()) as { ledger: string; id: string; option?: string | null; note?: string };
        const res = await answerDecisionAsk(body);
        if (!res.ok) {
          return Response.json({ ok: false, error: res.error }, { status: 400 });
        }
        const snapshot = await read();
        return Response.json({ ok: true, ask: res.ask, snapshot });
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }

    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

    if (url.pathname === "/api/snapshot") {
      return Response.json(await read(), { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname !== "/") return new Response("Not found", { status: 404 });

    try {
      const diskHtml = await readFile(join(import.meta.dir, "dist/maestro.html"), "utf8");
      cachedHtml = diskHtml;
    } catch {
      // use in-memory build
    }

    return new Response(cachedHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
});

console.log(`Maestro preview: ${server.url} (${isDemo ? "fictional sample data" : "live workspace bridge"})`);
