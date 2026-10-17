// Evaluates an expression in Paseo.app's main process over its Node inspector (CDP), and prints the result.
const expr = await Bun.file(process.argv[2]).text();
const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const my = ++id;
    ws.addEventListener("message", function on(e) {
      const m = JSON.parse(String(e.data));
      if (m.id === my) {
        ws.removeEventListener("message", on);
        resolve(m);
      }
    });
    ws.send(JSON.stringify({ id: my, method, params }));
  });
const out = await call("Runtime.evaluate", {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  includeCommandLineAPI: true,
});
console.log(JSON.stringify(out.result?.result?.value ?? out.result ?? out, null, 1));
ws.close();
