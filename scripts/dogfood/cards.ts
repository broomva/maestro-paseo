#!/usr/bin/env bun
// Operate the Maestro cards in the sandbox (BRO-3008): what a push opens, acted on as you would. It drives real
// Chromium against the sandbox daemon, never the real one, and saves a PNG at each step.
//
//   bun scripts/dogfood/up.ts --plugin .           # two live sessions pause on `git push`: two approval holds
//   bun scripts/dogfood/control.ts                  # (optional) an ask ledger; stamp an ask with `origin.agent_id`
//   bun scripts/dogfood/cards.ts --out <dir> [--theme light|dark]
//
// 1. session A, a card at its tail (desktop and phone)         2. session B, an approval and an ask
// 3. Open in Maestro on A's card: the session page (K2)         4. Allow on A: the 8 s window, Undo, Allow again,
//    and its receipt once it took effect
// 5. Allow B's hold in Maestro's Feed (another page) and watch B's card in its own session turn into the same window

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { flag, readState, resolveStateDir, sleep, waitFor } from "./lib";
import { Cdp, findChrome, launch, Page } from "./shot";

const dir = resolveStateDir(flag(process.argv.slice(2), "state"));
const state = dir ? readState(dir) : null;
if (!state?.serverId) throw new Error("No sandbox: run scripts/dogfood/up.ts first (or pass --state).");
const out = resolve(flag(process.argv.slice(2), "out") ?? "");
if (!flag(process.argv.slice(2), "out")) throw new Error("--out <dir> is required");
const theme = flag(process.argv.slice(2), "theme") ?? "light";
await mkdir(out, { recursive: true });

const server = encodeURIComponent(state.serverId);
const agentUrl = (id: string) => `${state.url}/h/${server}/agent/${id}`;
const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
const daemon = new DaemonClient({
  url: `ws://127.0.0.1:${state.port}/ws`,
  clientId: `dogfood-cards-${randomUUID()}`,
  clientType: "cli",
  reconnect: { enabled: false },
});
await daemon.connect();
const needs = (await daemon.invokePluginRpc("maestro", "needs.list", {}).finally(() => daemon.close())) as {
  rows: { key: string; kind: string; title: string; session?: { agentId: string } }[];
};
const approvals = needs.rows.filter((row) => row.kind === "approval" && row.session);
const [a, b] = approvals;
if (!a?.session || !b?.session) throw new Error("Two approval holds with sessions are needed: run up.ts first.");
console.log(`A: ${a.title} · agent ${a.session.agentId} · ${a.key}`);
console.log(`B: ${b.title} · agent ${b.session.agentId} · ${b.key}`);

const chrome = findChrome(flag(process.argv.slice(2), "chrome"));
const profile = join(state.dir, `chrome-cards-${Date.now()}`);
const { child, endpoint } = await launch(chrome, profile);
const cdp = await Cdp.open(endpoint);
try {
  const open = async (width: number, height: number): Promise<Page> => {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.viewport(width, height, theme);
    return page;
  };
  const shot = (page: Page, name: string) => page.screenshot(join(out, `${name}-${theme}.png`));
  const has = (page: Page, selector: string) =>
    page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  const until = (page: Page, what: string, selector: string, ms = 60_000) =>
    waitFor(what, () => has(page, selector), ms, 250);
  const textHas = (page: Page, text: string, ms = 60_000) => page.waitForText(text, ms);

  // The app follows /h/<server>/... only once the host is saved: the first load at / saves it.
  const desktop = await open(1440, 900);
  await desktop.goto(`${state.url}/`);
  await waitFor(
    "the app to register the sandbox host",
    () =>
      desktop.evaluate<boolean>(
        `(localStorage.getItem('@paseo:daemon-registry') || '').includes(${JSON.stringify(state.serverId)})`,
      ),
    60_000,
    250,
  );
  const CARD = '[data-testid^="card-work:"]';

  // 1. The session that asked, and the card at its tail.
  await desktop.goto(agentUrl(a.session.agentId));
  await until(desktop, "A's approval card", `${CARD} [aria-label="Allow push"]`);
  await sleep(1500);
  await shot(desktop, "01-approval-card-desktop");
  const phone = await open(375, 812);
  await phone.goto(`${state.url}/`);
  await phone.goto(agentUrl(a.session.agentId));
  await until(phone, "A's card on the phone", `${CARD} [aria-label="Allow push"]`);
  await sleep(1500);
  await shot(phone, "01-approval-card-phone");

  // 2. Session B: an approval, and an ask if a ledger stamped one for it.
  await desktop.goto(agentUrl(b.session.agentId));
  await until(desktop, "B's approval card", `${CARD} [aria-label="Allow push"]`);
  await sleep(2500);
  await shot(desktop, "02-session-b-cards-desktop");

  // 3. Open in Maestro from A's card: that session's page (K2).
  await desktop.goto(agentUrl(a.session.agentId));
  await until(desktop, "A's approval card", `${CARD} [aria-label="Open in Maestro"]`);
  await desktop.click("Open in Maestro", CARD);
  await textHas(desktop, "Holds on this session");
  const where = await desktop.evaluate<string>("location.href");
  console.log(`Open in Maestro landed on ${where}`);
  if (!where.includes("agentId") || !where.includes(a.session.agentId)) throw new Error(`not on A's page: ${where}`);
  await sleep(2000);
  await shot(desktop, "03-session-page-desktop");
  await phone.goto(where);
  await textHas(phone, "Holds on this session");
  await sleep(2000);
  await shot(phone, "03-session-page-phone");

  // 4. Allow on A's card: the window, Undo, then Allow again and the receipt.
  await desktop.goto(agentUrl(a.session.agentId));
  await until(desktop, "A's approval card", `${CARD} [aria-label="Allow push"]`);
  await desktop.click("Allow push", CARD);
  await until(desktop, "the undo window", '[data-testid="card-undo"]', 15_000);
  await sleep(800);
  await shot(desktop, "04-undo-window-desktop");
  await desktop.click("Undo", '[data-testid="card-undo"]');
  await until(desktop, "the hold back", `${CARD} [aria-label="Allow push"]`, 15_000);
  await shot(desktop, "05-undone-desktop");
  await desktop.click("Allow push", CARD);
  await until(desktop, "the undo window", '[data-testid="card-undo"]', 15_000);
  await until(desktop, "its receipt", '[data-testid="card-settled"]', 40_000);
  await sleep(800);
  await shot(desktop, "06-receipt-desktop");

  // 5. Another surface answers B's hold first; B's own card follows.
  const session = await open(1440, 900);
  await session.goto(`${state.url}/`);
  await session.goto(agentUrl(b.session.agentId));
  await until(session, "B's approval card", `${CARD} [aria-label="Allow push"]`);
  const feed = await open(1440, 900);
  await feed.goto(`${state.url}/`);
  await feed.goto(`${state.url}/h/${server}/plugin/maestro/sidebar/maestro`);
  await until(feed, "B's hold in J1", `[data-testid="hold-${b.key}"] [aria-label="Allow push"]`);
  await sleep(1000);
  await feed.click("Allow push", `[data-testid="hold-${b.key}"]`);
  await sleep(500);
  await shot(feed, "07-feed-allow-desktop");
  // A page in the background does not read (react-query pauses its polls): the person is looking at the session.
  await session.send("Page.bringToFront");
  await until(session, "B's card showing the same window", '[data-testid="card-undo"]', 30_000);
  await shot(session, "08-card-shows-the-feed-decision");
  await until(session, "B's receipt", '[data-testid="card-settled"]', 40_000);
  await sleep(800);
  await shot(session, "09-card-receipt-after-feed");
  console.log("Done.");
} finally {
  cdp.close();
  child.kill("SIGTERM");
}
