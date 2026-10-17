(async () => {
  const { BrowserWindow, app } = process.mainModule.require("electron");
  const fs = process.mainModule.require("fs"),
    path = process.mainModule.require("path");
  const dir = "/Users/broomva/broomva/apps/maestro-paseo-wt-bro-3180/docs/dogfood/2026-10-17-bro-3180/";
  let win = globalThis.__bro3180;
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 402,
      height: 874,
      show: false,
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist/preload.js"),
        contextIsolation: true,
        sandbox: true,
      },
    });
    globalThis.__bro3180 = win;
  }
  win.setContentSize(402, 874);
  try {
    win.webContents.debugger.attach("1.3");
  } catch {}
  await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await win.loadURL("paseo://app/h/srv_T-uYNNfjKK-J/plugin/maestro/sidebar/maestro");
  const js = (s) => win.webContents.executeJavaScript(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (n) => fs.writeFileSync(dir + n, (await win.webContents.capturePage()).toPNG());
  await wait(6000);
  await js(
    `(() => { const ls = new Set(); window.__vv = { height: innerHeight, offsetTop: 0, scale: 1, addEventListener: (t, f) => ls.add(f), removeEventListener: (t, f) => ls.delete(f), fire: () => ls.forEach(f => f()), count: () => ls.size }; Object.defineProperty(window, 'visualViewport', { value: window.__vv, configurable: true }); })()`,
  );
  await js(
    `[...document.querySelectorAll('[role="tab"],[role="button"]')].find(e => /^Decisions/.test(e.getAttribute('aria-label') || e.innerText))?.click()`,
  );
  await wait(2500);
  await js(
    `[...document.querySelectorAll('[role="button"]')].find(e => /universe-seed/.test(e.getAttribute('aria-label')||''))?.click()`,
  );
  await wait(2500);
  const marker = await js(`!!document.querySelector('[data-testid="inspector-card-scroll"]')`);
  const at = await js(
    `(() => { const e = document.querySelector('[aria-label^="Other…"]'); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`,
  );
  await wait(300);
  for (const type of ["mouseDown", "mouseUp"])
    win.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  await wait(700);
  await js(
    `(() => { window.__vv.height = innerHeight - 336; window.__vv.fire(); const k = document.createElement('div'); k.id = 'bro3180-kbd'; k.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:336px;background:rgba(120,120,128,.92);z-index:99999;pointer-events:none;display:flex;align-items:center;justify-content:center;color:#fff;font:600 15px system-ui'; k.textContent = 'simulated keyboard (336 px)'; document.body.appendChild(k); })()`,
  );
  await wait(900);
  const geo = () =>
    js(
      `(() => { const ta = document.querySelector('[data-testid="inspector-card"] textarea'); const bar = document.querySelector('[data-testid="inspector-card-bar"]').getBoundingClientRect(); const sv = document.querySelector('[data-testid="inspector-card-scroll"]').getBoundingClientRect(); const r = ta.getBoundingClientRect(); return { focusIsField: document.activeElement === ta, field: [Math.round(r.top), Math.round(r.bottom)], scroll: [Math.round(sv.top), Math.round(sv.bottom)], barTop: Math.round(bar.top), keyboardTop: innerHeight - 336, listeners: window.__vv.count() }; })()`,
    );
  const raised = await geo();
  await shot("4-live-a2-field-above-keyboard.png");
  win.webContents.insertText("hello world");
  await wait(400);
  await js(`document.querySelector('[data-testid="inspector-card"] textarea').setSelectionRange(5, 5)`);
  win.webContents.insertText(",");
  win.webContents.insertText(" there");
  await wait(600);
  const caret = await js(
    `(() => { const ta = document.querySelector('[data-testid="inspector-card"] textarea'); return { value: ta.value, selectionStart: ta.selectionStart }; })()`,
  );
  // Grow it to four lines: its bottom, where you type, must stay in view.
  win.webContents.insertText("\nline two\nline three\nline four");
  await wait(800);
  const grown = await geo();
  await shot("5-live-a2-typing-grown.png");
  const focusedNow = await js(
    `(() => { const ta = document.querySelector('[data-testid="inspector-card"] textarea'); const key = Object.keys(ta).find(k => k.startsWith("__reactFiber")); let f = ta[key], d = 0; while (f && d < 200) { let h = f.memoizedState, i = 0; while (h && i < 80) { const v = h.memoizedState; if (v && typeof v === "object" && v.current && typeof v.current === "object" && "scrolled" in v.current) return v.current; h = h.next; i++; } f = f.return; d++; } return null; })()`,
  );
  return { marker, raised, caret, grown, hook: focusedNow };
})();
