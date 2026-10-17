// Step 5: tap Send again once on the changed ask; report the toast, whether an answer verb is pending, and the store.
(async () => {
  const win = globalThis.__c;
  const fs = process.mainModule.require("fs");
  const js = (s) => win.webContents.executeJavaScript(s);
  await js(`document.querySelector('[data-testid="inspector-card-bar"] [aria-label^="Send again"]')?.click()`);
  await new Promise((r) => setTimeout(r, 2500));
  const out = {
    toasts: await js(
      `[...document.querySelectorAll('[role="alert"],[aria-live]')].map(e => e.innerText).filter(Boolean)`,
    ),
    line: await js(`document.querySelector('[data-testid="unsent-line"]')?.innerText || ""`),
    unsent: await js(
      `(() => { const d = JSON.parse(localStorage.getItem('maestro-paseo.v1.phone.drafts') || '{}'); return Object.values(d).filter(x => x.unsent).map(x => x.unsent.hash); })()`,
    ),
  };
  fs.writeFileSync(__SHOTPATH__, (await win.webContents.capturePage()).toPNG());
  return out;
})();
