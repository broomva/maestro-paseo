// After `paseo plugin reload maestro`: a fresh hidden window opens Maestro, and the same ask and words must come back.
(async () => {
  const { BrowserWindow, app } = process.mainModule.require("electron");
  const fs = process.mainModule.require("fs"), path = process.mainModule.require("path");
  BrowserWindow.getAllWindows().filter((w) => !w.isVisible()).forEach((w) => w.destroy());
  const dir = "/Users/broomva/broomva/apps/maestro-paseo-wt-bro-3180-rb/docs/dogfood/2026-10-17-bro-3180-b/";
  const win = new BrowserWindow({ width: 402, height: 874, show: false, webPreferences: { preload: path.join(app.getAppPath(), "dist/preload.js"), contextIsolation: true, sandbox: true } });
  win.setContentSize(402, 874);
  await win.loadURL("paseo://app/h/srv_T-uYNNfjKK-J/plugin/maestro/sidebar/maestro");
  await new Promise((r) => setTimeout(r, 10000));
  const back = await win.webContents.executeJavaScript(`(() => { const ta = document.querySelector('[data-testid="inspector-card"] textarea'); const other = document.querySelector('[aria-label^="Other…"]'); return { header: document.querySelector('[data-testid="detail-header"]')?.innerText, words: ta?.value, otherChecked: other?.getAttribute('aria-checked') }; })()`);
  fs.writeFileSync(dir + "3-after-plugin-reload.png", (await win.webContents.capturePage()).toPNG());
  win.destroy();
  return back;
})()
