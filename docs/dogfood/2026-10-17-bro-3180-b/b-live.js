(async () => {
  for (const w of process.mainModule
    .require("electron")
    .BrowserWindow.getAllWindows()
    .filter((one) => !one.isVisible()))
    w.destroy();
  const { BrowserWindow, app } = process.mainModule.require("electron");
  const fs = process.mainModule.require("fs"),
    path = process.mainModule.require("path");
  const dir = "/Users/broomva/broomva/apps/maestro-paseo/docs/dogfood/2026-10-17-bro-3180-b/";
  fs.mkdirSync(dir, { recursive: true });
  const URL = "paseo://app/h/srv_T-uYNNfjKK-J/plugin/maestro/sidebar/maestro";
  const open = async () => {
    const win = new BrowserWindow({
      width: 402,
      height: 874,
      show: false,
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist/preload.js"),
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.setContentSize(402, 874);
    try {
      win.webContents.debugger.attach("1.3");
    } catch {}
    await win.loadURL(URL);
    // Sent after the load: before it the page has no target and the command never answers.
    await Promise.race([
      win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    await new Promise((r) => setTimeout(r, 7000));
    return win;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (win, n) => fs.writeFileSync(dir + n, (await win.webContents.capturePage()).toPNG());
  const js = (win, s) => win.webContents.executeJavaScript(s);
  // Run 1: Decisions, the universe-seed series, its ask, Other, words typed. No answer.
  let win = await open();
  await js(
    win,
    `[...document.querySelectorAll('[role="tab"],[role="button"]')].find(e => /^Decisions/.test(e.getAttribute('aria-label') || e.innerText))?.click()`,
  );
  await wait(2500);
  await js(
    win,
    `[...document.querySelectorAll('[role="button"]')].find(e => /universe-seed/.test(e.getAttribute('aria-label')||''))?.click()`,
  );
  await wait(2500);
  const header1 = await js(win, `document.querySelector('[data-testid="detail-header"]')?.innerText`);
  const title1 = await js(win, `document.querySelector('[data-testid="inspector-card"] [role="header"]')?.innerText`);
  const at = await js(
    win,
    `(() => { const e = document.querySelector('[aria-label^="Other…"]'); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`,
  );
  await wait(300);
  for (const type of ["mouseDown", "mouseUp"])
    win.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  await wait(700);
  win.webContents.insertText("BRO-3180 B draft: keep me");
  await wait(1200);
  await shot(win, "1-before-leaving.png");
  // Leave: the window navigates away (Maestro unmounts), then is destroyed (a fresh app run of the plugin).
  await win.loadURL("paseo://app/h/srv_T-uYNNfjKK-J");
  await wait(2000);
  win.destroy();
  // Run 2: a fresh window opens Maestro again.
  win = await open();
  await wait(3000);
  const back = await js(
    win,
    `(() => { const ta = document.querySelector('[data-testid="inspector-card"] textarea'); const other = document.querySelector('[aria-label^="Other…"]'); return { card: !!document.querySelector('[data-testid="inspector-card"]'), header: document.querySelector('[data-testid="detail-header"]')?.innerText, title: document.querySelector('[data-testid="inspector-card"] [role="header"]')?.innerText, words: ta?.value, otherChecked: other?.getAttribute('aria-checked') }; })()`,
  );
  await shot(win, "2-back-same-ask-same-words.png");
  const stored = await js(
    win,
    `Object.keys(localStorage).filter(k => k.startsWith('maestro-paseo.v1.')).map(k => [k, localStorage.getItem(k).slice(0, 300)])`,
  );
  globalThis.__bro3180b = win;
  return { header1, title1, back, stored };
})();
