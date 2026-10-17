// BRO-3180 C live check, step 1: a hidden phone-size window on the live plugin, Decisions, the fixture's series.
(async () => {
  const { BrowserWindow, app } = process.mainModule.require("electron");
  const path = process.mainModule.require("path");
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
  await new Promise((r) => setTimeout(r, 7000));
  globalThis.__c = win;
  const js = (s) => win.webContents.executeJavaScript(s);
  await js(
    `[...document.querySelectorAll('[role="tab"],[role="button"]')].find(e => /^Decisions/.test(e.getAttribute('aria-label') || e.innerText))?.click()`,
  );
  await new Promise((r) => setTimeout(r, 2500));
  return js(
    `[...document.querySelectorAll('[data-testid="series-row"]')].map(e => (e.getAttribute('aria-label') || e.innerText).slice(0, 90))`,
  );
})();
