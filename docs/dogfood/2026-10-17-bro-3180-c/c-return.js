// Step 3 (and 4): a fresh run of the plugin, as a reconnect makes; read the card's line, its verbs, and the store.
(async () => {
  const { BrowserWindow, app } = process.mainModule.require("electron");
  const fs = process.mainModule.require("fs"),
    path = process.mainModule.require("path");
  for (const w of BrowserWindow.getAllWindows().filter((one) => !one.isVisible())) w.destroy();
  const win = new BrowserWindow({
    width: 402,
    height: 874,
    show: false,
    webPreferences: { preload: path.join(app.getAppPath(), "dist/preload.js"), contextIsolation: true, sandbox: true },
  });
  win.setContentSize(402, 874);
  try {
    win.webContents.debugger.attach("1.3");
  } catch {}
  await win.loadURL("paseo://app/h/srv_T-uYNNfjKK-J/plugin/maestro/sidebar/maestro");
  await Promise.race([
    win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  await new Promise((r) => setTimeout(r, 12000));
  globalThis.__c = win;
  const js = (s) => win.webContents.executeJavaScript(s);
  const out = {
    header: await js(`document.querySelector('[data-testid="detail-header"]')?.innerText`),
    line: await js(`document.querySelector('[data-testid="unsent-line"]')?.innerText || ""`),
    verbs: await js(
      `[...document.querySelectorAll('[data-testid="inspector-card-bar"] [aria-label]')].map(e => e.getAttribute('aria-label'))`,
    ),
    unsent: await js(
      `(() => { const d = JSON.parse(localStorage.getItem('maestro-paseo.v1.phone.drafts') || '{}'); return Object.values(d).filter(x => x.unsent).map(x => ({ id: x.ask.id, hash: x.hash, chosen: x.chosen, unsent: x.unsent })); })()`,
    ),
  };
  fs.writeFileSync(`${__DIR__}${__SHOT__}`, (await win.webContents.capturePage()).toPNG());
  return out;
})();
