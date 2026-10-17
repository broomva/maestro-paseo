// Step 2: open the fixture's ask, drop the answer's frame on the way out (the link swallowing it), tap Answer.
(async () => {
  const win = globalThis.__c;
  const fs = process.mainModule.require("fs");
  const js = (s) => win.webContents.executeJavaScript(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await js(
    `[...document.querySelectorAll('[data-testid="series-row"]')].find(e => /bro-3180-c-dogfood-fixture/.test(e.getAttribute('aria-label')||''))?.click()`,
  );
  await wait(2500);
  // The fault: any WebSocket frame carrying an ask.answer invoke is dropped, so its call never gets a reply.
  const armed = await js(`(() => {
    const send = WebSocket.prototype.send;
    window.__dropped = 0;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && data.includes("plugin.rpc.invoke.request") && data.includes("ask.answer")) { window.__dropped += 1; return; }
      return send.call(this, data);
    };
    return true;
  })()`);
  const title = await js(`document.querySelector('[data-testid="inspector-card"] [role="header"]')?.innerText`);
  await js(`document.querySelector('[data-testid="inspector-card-bar"] [aria-label^="Answer"]')?.click()`);
  const started = Date.now();
  let line = "";
  while (Date.now() - started < 90000) {
    await wait(2000);
    line = await js(`document.querySelector('[data-testid="unsent-line"]')?.innerText || ""`);
    if (line) break;
  }
  const out = {
    armed,
    title,
    line,
    waitedMs: Date.now() - started,
    dropped: await js(`window.__dropped`),
    verb: await js(
      `[...document.querySelectorAll('[data-testid="inspector-card-bar"] [aria-label]')].map(e => e.getAttribute('aria-label'))`,
    ),
  };
  fs.writeFileSync(
    "/Users/broomva/broomva/apps/maestro-paseo/docs/dogfood/2026-10-17-bro-3180-c/" +
      "1-not-sent-after-dropped-send.png",
    (await win.webContents.capturePage()).toPNG(),
  );
  return out;
})();
