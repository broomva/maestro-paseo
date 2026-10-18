import { createBackend } from "./backend";
import { buildApp } from "./build";

const html = await buildApp();
const read = createBackend({ demo: process.argv.includes("--demo"), socket: process.env.MAESTRO_MCP_SOCKET });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.MAESTRO_MCP_PREVIEW_PORT ?? 4318),
  async fetch(request) {
    const authority = request.headers.get("host");
    if (authority !== `127.0.0.1:${server.port}` && authority !== `localhost:${server.port}`)
      return new Response("Forbidden", { status: 403 });
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Read only", { status: 405 });
    if (url.pathname === "/api/snapshot")
      return Response.json(await read(), { headers: { "Cache-Control": "no-store" } });
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  },
});
console.log(
  `Maestro preview: ${server.url} (${process.argv.includes("--demo") ? "fictional sample data" : "read-only live bridge"})`,
);
