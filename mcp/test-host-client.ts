/** Browser half of the test-only host: actual MCP Apps AppBridge, not preview injection. */
import { AppBridge, type McpUiHostContext, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

declare global {
  interface Window {
    __MAESTRO_TEST_HOST__: {
      session: string;
      source: string;
      width: number;
      height: number;
      maxHeight: number;
      displayMode: "inline" | "fullscreen";
      theme: "light" | "dark";
    };
  }
}
const config = window.__MAESTRO_TEST_HOST__;
const frame = document.querySelector<HTMLIFrameElement>("#maestro-frame");
const status = document.querySelector<HTMLElement>("#host-status");
if (!frame?.contentWindow || !status) throw new Error("Host fixture markup missing.");
const iframe = frame;
const label = status;
const endpoint = (path: string) => `${path}?session=${encodeURIComponent(config.session)}`;
async function post(path: string, body: unknown) {
  const response = await fetch(endpoint(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(value)}`);
  return value;
}
const record = (kind: string, detail?: unknown) => post("/event", { kind, detail });
const tool = async (params: unknown) => CallToolResultSchema.parse(await post("/tool", params));
let mode = config.displayMode;
const dimensions = () => ({
  width: Math.min(mode === "fullscreen" ? window.innerWidth : config.width, window.innerWidth),
  height: mode === "fullscreen" ? window.innerHeight - label.offsetHeight : config.height,
});
function layout() {
  const size = dimensions();
  iframe.style.width = `${size.width}px`;
  iframe.style.height = `${size.height}px`;
  document.body.dataset.mode = mode;
  document.body.dataset.theme = config.theme;
}
layout();
function context(): McpUiHostContext {
  const size = dimensions();
  return {
    theme: config.theme,
    displayMode: mode,
    availableDisplayModes: ["inline", "fullscreen"],
    platform: "desktop",
    containerDimensions: { width: size.width, maxHeight: mode === "fullscreen" ? size.height : config.maxHeight },
  };
}
const bridge = new AppBridge(
  null,
  { name: "Maestro Browser Dogfood Host", version: "1" },
  { serverTools: {}, message: {}, logging: {} },
  { hostContext: context() },
);
bridge.oncalltool = (params) => tool(params);
bridge.onmessage = async (params) => {
  await record("message", params);
  return {};
};
bridge.onsizechange = (size) => {
  void record("sizechange", size);
};
bridge.onrequestdisplaymode = async ({ mode: requested }) => {
  mode = requested === "fullscreen" ? "fullscreen" : "inline";
  layout();
  bridge.setHostContext(context());
  await record("displayMode", { mode });
  return { mode };
};
bridge.oninitialized = () => {
  void (async () => {
    await record("initialized", context());
    await bridge.sendToolInput({ arguments: { view: "decisions" } });
    await bridge.sendToolResult(await tool({ name: "maestro_open", arguments: { view: "decisions" } }));
    label.textContent = `${config.source} · actual MCP AppBridge connected`;
    document.body.dataset.connected = "true";
  })().catch((error) => {
    label.textContent = String(error);
    document.body.dataset.error = "true";
  });
};
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
const resource = await fetch(endpoint("/resource"));
if (!resource.ok) throw new Error("Unable to read MCP App resource.");
iframe.srcdoc = await resource.text();
window.addEventListener("resize", () => {
  layout();
  bridge.setHostContext(context());
});
window.addEventListener("pagehide", () => {
  void bridge.close();
});
