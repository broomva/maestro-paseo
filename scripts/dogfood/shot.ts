#!/usr/bin/env bun
// Screenshot the Maestro surface of the sandbox up.ts started. The sandbox
// daemon serves the Paseo web client on its own origin, so a headless Chromium
// pointed at http://127.0.0.1:<port>/ connects with no host setup and no
// Local Network Access exceptions. Driven over the DevTools protocol directly.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { flag, hasFlag, readState, resolveStateDir, sleep, waitFor } from "./lib";

const USAGE = `bun scripts/dogfood/shot.ts --out <dir> [options]

  --out <dir>          Where the PNGs go (created if missing)
  --width N --height N Desktop viewport (default 1440x900); a 375x812 phone shot is always taken too
  --theme light|dark   prefers-color-scheme for the app (default light)
  --path <surface>     Maestro surface id (default maestro), or an app path starting with / ({server} is replaced)
  --open <title>       Click this work item and save its detail (default: the seeded Needs you item)
  --no-open            Skip the detail shot
  --steps "a|b|c"      After the desktop shot (and --open), click each name in turn and save step-N after each
  --wait-for <text>    Text that proves the surface rendered (default: the --open title)
  --state <dir>        The sandbox (default: MAESTRO_DOGFOOD_STATE, then the one up.ts last started here)
  --chrome <path>      Chromium binary (default: newest Playwright Chromium, then DOGFOOD_CHROME)
`;

const DEFAULT_OPEN = "Retry failed card charges with backoff";
const PHONE = { width: 375, height: 812 };

function fail(message: string): never {
  console.error(`shot: ${message}`);
  process.exit(1);
}

function findChrome(explicit: string | undefined): string {
  const candidates = [explicit, process.env.DOGFOOD_CHROME];
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) {
      for (const arch of ["chrome-mac-arm64", "chrome-mac"]) {
        candidates.push(
          join(cache, build, arch, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        );
        candidates.push(join(cache, build, arch, "Chromium.app", "Contents", "MacOS", "Chromium"));
      }
      candidates.push(join(cache, build, "chrome-linux", "chrome"));
    }
  }
  const found = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!found) fail("no Chromium found: run `bunx playwright install chromium`, or pass --chrome");
  return found;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** The smallest DevTools protocol client: one socket, flattened sessions. */
class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    });
  }

  static open(url: string): Promise<Cdp> {
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolveOpen(new Cdp(socket)));
      socket.addEventListener("error", () => rejectOpen(new Error(`could not open ${url}`)));
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    this.seq += 1;
    const id = this.seq;
    return new Promise<T>((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend as (value: unknown) => void, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

class Page {
  constructor(
    private readonly cdp: Cdp,
    private readonly session: string,
  ) {}

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.session);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value as T;
  }

  async viewport(width: number, height: number, theme: string): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  }

  async goto(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await waitFor("the page to load", () => this.evaluate<boolean>("document.readyState === 'complete'"), 30_000, 200);
  }

  text(): Promise<string> {
    return this.evaluate<string>("document.body ? document.body.innerText : ''");
  }

  async waitForText(text: string, timeoutMs = 60_000): Promise<void> {
    await waitFor(`"${text}" on the page`, async () => (await this.text()).includes(text), timeoutMs, 250);
  }

  async screenshot(path: string): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(data, "base64"));
    console.log(`Saved ${path}`);
  }

  /**
   * Click the visible element whose accessible name starts with `name`, by real
   * mouse events at its centre. Paseo's own sidebar also lists sessions by
   * title, so a Maestro row ("<title>, Needs you") is preferred over a bare
   * text match.
   */
  async click(name: string): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number; label: string } | null>(`(() => {
      const name = ${JSON.stringify(name)};
      // Rendered, not necessarily on screen: the target is scrolled into view below.
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const labelled = [...document.querySelectorAll('[aria-label]')]
        .filter((el) => el.getAttribute('aria-label').startsWith(name) && visible(el))
        .sort((a, b) => b.getAttribute('aria-label').length - a.getAttribute('aria-label').length);
      const byText = [...document.querySelectorAll('[role="button"], button, a, [tabindex]')]
        .filter((el) => el.innerText && el.innerText.includes(name) && visible(el))
        .sort((a, b) => a.innerText.length - b.innerText.length);
      const el = labelled[0] || byText[0];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: el.getAttribute('aria-label') || el.innerText };
    })()`);
    if (!point) throw new Error(`nothing clickable named "${name}"`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    }
    console.log(`Clicked "${point.label.replace(/\s+/g, " ").slice(0, 80)}"`);
  }
}

async function launch(chrome: string, profile: string): Promise<{ child: ChildProcess; endpoint: string }> {
  await mkdir(profile, { recursive: true });
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--hide-scrollbars",
      "--mute-audio",
      "--use-mock-keychain",
      "--password-store=basic",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  const endpoint = await waitFor(
    "Chromium's DevTools port",
    async () => {
      if (child.exitCode !== null) throw new Error(`Chromium exited with ${child.exitCode}`);
      if (!existsSync(portFile)) return null;
      const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
      return port && path ? `ws://127.0.0.1:${port}${path}` : null;
    },
    30_000,
    200,
  );
  return { child, endpoint };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, "help") || hasFlag(args, "h")) {
    console.log(USAGE);
    return;
  }
  const outArg = flag(args, "out");
  if (!outArg) fail(`--out is required\n\n${USAGE}`);
  const out = resolve(outArg);
  const width = Number(flag(args, "width") ?? 1440);
  const height = Number(flag(args, "height") ?? 900);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200) {
    fail("--width and --height must be whole numbers of at least 200");
  }
  const theme = flag(args, "theme") ?? "light";
  if (theme !== "light" && theme !== "dark") fail("--theme must be light or dark");
  const open = hasFlag(args, "no-open") ? null : (flag(args, "open") ?? DEFAULT_OPEN);
  const readyText = flag(args, "wait-for") ?? open ?? DEFAULT_OPEN;
  const steps = (flag(args, "steps") ?? "")
    .split("|")
    .map((step) => step.trim())
    .filter(Boolean);

  const dir = resolveStateDir(flag(args, "state"));
  const state = dir ? readState(dir) : null;
  if (!state) fail("no sandbox is up: run bun scripts/dogfood/up.ts --plugin <dir> first");
  if (!state.serverId) fail(`the sandbox at ${state.dir} never recorded a server id; run down.ts and up.ts again`);
  const path = flag(args, "path") ?? "maestro";
  const route = path.startsWith("/")
    ? path.replaceAll("{server}", encodeURIComponent(state.serverId))
    : `/h/${encodeURIComponent(state.serverId)}/plugin/maestro/sidebar/${encodeURIComponent(path)}`;
  const url = `${state.url}${route}`;

  await mkdir(out, { recursive: true });
  const chrome = findChrome(flag(args, "chrome"));
  // Inside the sandbox, so down.ts finds (and stops) a browser an interrupted run left behind.
  const profile = join(state.dir, `chrome-${Date.now()}`);
  const { child, endpoint } = await launch(chrome, profile);
  let cdp: Cdp | null = null;
  try {
    cdp = await Cdp.open(endpoint);
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");

    // A cold deep link lands on /open-project: the app only follows /h/<server>/... once the host is saved.
    // The first load at / saves it (the daemon injects its own address into index.html).
    await page.viewport(width, height, theme);
    await page.goto(`${state.url}/`);
    const serverId = state.serverId;
    await waitFor(
      "the app to register the sandbox host",
      () =>
        page.evaluate<boolean>(
          `(localStorage.getItem('@paseo:daemon-registry') || '').includes(${JSON.stringify(serverId)})`,
        ),
      60_000,
      250,
    );

    const shots: Array<{ width: number; height: number; name: string }> = [
      { width, height, name: `${width}x${height}` },
      ...(width === PHONE.width && height === PHONE.height ? [] : [{ ...PHONE, name: "375x812" }]),
    ];
    for (const shot of shots) {
      await page.viewport(shot.width, shot.height, theme);
      await page.goto(url);
      try {
        await page.waitForText(readyText);
      } catch (error) {
        // Leave evidence of what did render: the harness is for finding out, not for passing.
        await page.screenshot(join(out, `failed-${shot.name}-${theme}.png`));
        const location = await page.evaluate<string>("location.href").catch(() => "?");
        const text = (await page.text().catch(() => "")).replace(/\n{2,}/g, "\n").slice(0, 1500);
        throw new Error(`${(error as Error).message}\nAt ${location}, the page read:\n${text}`);
      }
      await sleep(1500);
      await page.screenshot(join(out, `maestro-${shot.name}-${theme}.png`));
      if (open) {
        await page.click(open);
        await sleep(1500);
        await page.screenshot(join(out, `maestro-detail-${shot.name}-${theme}.png`));
      }
      // Steps change state (an answer is written once), so they run on the first viewport only.
      if (shot !== shots[0]) continue;
      for (const [index, step] of steps.entries()) {
        await page.click(step);
        await sleep(1500);
        await page.screenshot(join(out, `maestro-step-${index + 1}-${shot.name}-${theme}.png`));
      }
    }
  } finally {
    cdp?.close();
    child.kill("SIGTERM");
    await waitFor(
      "Chromium to exit",
      async () => child.exitCode !== null || child.signalCode !== null,
      10_000,
      100,
    ).catch(() => child.kill("SIGKILL"));
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main().catch((error) => fail((error as Error).message));
