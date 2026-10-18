import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

export const outputDir = join(import.meta.dir, "dist");
export async function buildApp(): Promise<string> {
  const built = await build({
    entryPoints: [join(import.meta.dir, "app/main.tsx")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    outdir: outputDir,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const js = built.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
  const css = built.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"><title>Maestro</title><style>${css}</style></head><body><div id="root"></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "maestro.html"), html);
  return html;
}
if (import.meta.main) {
  await buildApp();
  console.error("Built mcp/dist/maestro.html");
}
