/** Test-only MCP Apps host. Never registers this server with a user's MCP configuration. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { build } from "esbuild";
import { z } from "zod";
import { type Backend, createBackend } from "./backend";
import { APP_URI, createServer } from "./server";

const html = () => readFile(join(import.meta.dir, "dist/maestro.html"), "utf8");
const built = await build({
  entryPoints: [join(import.meta.dir, "test-host-client.ts")],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  target: "es2022",
});
const browserScript = built.outputFiles[0].text;
const Source = z.enum(["demo", "live", "fixture"]);
const Tool = z.object({
  name: z.enum(["maestro_open", "maestro_snapshot", "maestro_answer_ask"]),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
type Event = { at: string; kind: string; [key: string]: unknown };
type Session = {
  source: z.infer<typeof Source>;
  client: Client;
  close(): Promise<void>;
  events: Event[];
  fixture?: { dir: string; ledger: string; receipts: string };
};
const sessions = new Map<string, Session>();
async function fixtureBackend() {
  const dir = await mkdtemp(join(tmpdir(), "maestro-mcp-host-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  await mkdir(join(dir, ".control/asks"), { recursive: true });
  const ledger = join(dir, ".control/asks/host-dogfood.yaml");
  await writeFile(
    ledger,
    `asks:
  - id: host-review
    uid: host-review-isolated
    headline: Approve the isolated end-to-end test?
    ask: This decision belongs to a temporary test workspace. Choose Approve or Skip to validate the actual MCP answer path.
    stakes: Only this temporary ledger changes.
    why_you: Validate the owner's controls through the actual host bridge.
    blocking: true
    options:
      - id: approve
        label: Approve
        consequence: Record approval in the isolated ledger.
        recommended: true
      - id: skip
        label: Skip
        consequence: Record a skip in the isolated ledger.
`,
  );
  const receipts = join(dir, "receipts.jsonl");
  return {
    backend: createBackend({
      controlRepo: dir,
      answersPath: join(dir, "answers"),
      lockRoot: join(dir, "locks"),
      receipts,
      fetch: false,
      socket: join(dir, "absent-bridge.sock"),
      workSocket: join(dir, "absent-work.sock"),
    }),
    fixture: { dir, ledger, receipts },
  };
}
async function newSession(source: z.infer<typeof Source>) {
  const fixture = source === "fixture" ? await fixtureBackend() : null;
  const backend: Backend = fixture?.backend ?? createBackend({ demo: source === "demo" });
  const read =
    source === "live"
      ? async () => {
          const snapshot = await backend();
          return { ...snapshot, readOnly: true, capabilities: { answerAsks: false } };
        }
      : backend;
  const server = createServer(
    read,
    html,
    source === "live"
      ? async () => ({
          ok: false,
          error: "Live writes are disabled in the dogfood host. Use an isolated fixture to test answers.",
        })
      : backend.answer,
  );
  const client = new Client({ name: "maestro-browser-dogfood", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const id = crypto.randomUUID();
  const session: Session = {
    source,
    client,
    events: [],
    fixture: fixture?.fixture,
    async close() {
      await client.close();
      await server.close();
      if (fixture) await rm(fixture.fixture.dir, { recursive: true, force: true });
    },
  };
  sessions.set(id, session);
  return { id, session };
}
const numberParam = (value: string | null, fallback: number) =>
  Math.min(2200, Math.max(280, Number(value) || fallback));
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const record = (session: Session, event: Omit<Event, "at">) => {
  session.events.push({ ...event, at: new Date().toISOString() } as Event);
  if (session.events.length > 200) session.events.shift();
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.MAESTRO_MCP_TEST_HOST_PORT ?? 4322),
  async fetch(request) {
    const authority = request.headers.get("host");
    if (authority !== `127.0.0.1:${server.port}` && authority !== `localhost:${server.port}`)
      return new Response("Forbidden host", { status: 403 });
    const origin = request.headers.get("origin");
    if ((origin && origin !== `http://${authority}`) || (request.method === "POST" && origin !== `http://${authority}`))
      return new Response("Forbidden origin", { status: 403 });
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        const source = Source.parse(url.searchParams.get("source") ?? "demo");
        const { id } = await newSession(source);
        const config = {
          session: id,
          source,
          width: numberParam(url.searchParams.get("width"), 760),
          height: numberParam(url.searchParams.get("height"), 760),
          maxHeight: numberParam(url.searchParams.get("maxHeight") ?? url.searchParams.get("height"), 760),
          displayMode: url.searchParams.get("displayMode") === "fullscreen" ? "fullscreen" : "inline",
          theme: url.searchParams.get("theme") === "dark" ? "dark" : "light",
        };
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maestro MCP host test</title><style>html,body{margin:0;min-height:100%;font:12px system-ui;background:#f6f6f8;color:#555}#host-status{padding:6px 12px}iframe{display:block;border:0;margin:0 auto;max-width:100%;background:transparent}body[data-mode=fullscreen] iframe{margin:0}body[data-theme=dark]{background:#0d0d0f;color:#aaa}</style></head><body><div id="host-status" role="status">Connecting ${source} MCP host…</div><iframe id="maestro-frame" title="Maestro MCP App" sandbox="allow-scripts allow-same-origin"></iframe><script>window.__MAESTRO_TEST_HOST__=${JSON.stringify(config)};</script><script type="module" src="/host-client.js"></script></body></html>`,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Security-Policy": "frame-ancestors 'self'",
              "Set-Cookie": `maestro_test_session=${id}; HttpOnly; SameSite=Strict; Path=/`,
            },
          },
        );
      }
      if (request.method === "GET" && url.pathname === "/host-client.js")
        return new Response(browserScript, {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
        });
      const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)maestro_test_session=([^;]+)/)?.[1];
      const session = sessions.get(url.searchParams.get("session") ?? cookie ?? "");
      if (!session) return json({ error: "Unknown host test session. Open / first." }, 404);
      if (request.method === "GET" && url.pathname === "/resource") {
        const result = await session.client.readResource({ uri: APP_URI });
        const resource = result.contents.find((c) => "text" in c);
        if (!resource || !("text" in resource)) return json({ error: "MCP resource has no HTML" }, 500);
        record(session, { kind: "resource", uri: APP_URI });
        return new Response(resource.text, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (request.method === "POST" && url.pathname === "/tool") {
        const params = Tool.parse(await request.json());
        const result = await session.client.callTool(params);
        record(session, {
          kind: "tool",
          name: params.name,
          arguments: params.arguments,
          isError: result.isError === true,
        });
        return json(result);
      }
      if (request.method === "POST" && url.pathname === "/event") {
        const input = z.object({ kind: z.string(), detail: z.unknown().optional() }).parse(await request.json());
        record(session, input);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/events") return json(session.events);
      if (request.method === "GET" && url.pathname === "/receipt") {
        if (!session.fixture) return json({ error: "Receipts are available only for isolated fixture sessions." }, 403);
        const ledger = await readFile(session.fixture.ledger, "utf8");
        const receiptText = await readFile(session.fixture.receipts, "utf8").catch(() => "");
        return json({
          source: "fixture",
          ledger,
          receipts: receiptText
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
});
async function shutdown() {
  server.stop();
  await Promise.all([...sessions.values()].map((session) => session.close()));
  process.exit(0);
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
console.log(
  `Test-only MCP host: ${server.url} (demo by default; ?source=fixture for isolated writes; live writes disabled)`,
);
