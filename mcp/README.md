# Maestro MCP App

A T3-themed, responsive **read-only** companion to the existing Paseo Maestro plugin. Feed, Decisions, Work, Health and Initiatives share one snapshot. It uses the MCP Apps SDK and standard host style variables; no T3 fork or iOS build is part of this change.

The interface follows the apple-design material and typography guidance: a single blurred navigation layer, capsule controls, and crisp content surfaces use the host palette. Reduced transparency and higher contrast use opaque chrome; reduced motion removes animated transitions and press scaling.

## Try the design

```sh
npm ci
npm run mcp:preview
```

Open http://127.0.0.1:4318. This command uses fictional, visibly labeled sample data. It supports light/dark mode, filters, decision drafts, work inspection and mobile layouts. Drafts last only while that view is mounted; they never answer an ask.

## Register the MCP server

```sh
npm run mcp:build
codex mcp add maestro -- bun /absolute/path/to/maestro-paseo/mcp/server.ts --demo
```

Restart the provider session if needed, then ask it to call `maestro_open` with `view: "decisions"` (or `feed`, `work`, `health`, `initiatives`). `maestro_snapshot` refreshes the view. A compatible MCP Apps host displays it inline and can expand it fullscreen. This does **not** add a permanent sidebar or a top-level T3 page. Provider/host MCP Apps support is required. Phone layout alone is not proof of native iOS host compatibility.

## Connect the existing runtime

The plugin listener is **off by default**. Opt in by setting `MAESTRO_MCP_READ_BRIDGE=1` in the environment of the Paseo daemon that loads this plugin version, then reload the plugin. Merely running the MCP process with that variable does not enable the plugin listener. Follow your normal daemon deployment procedure; installing this checkout alone does not alter the running plugin.

Remove `--demo` from the MCP command. Both processes default to `maestro-mcp.sock` beside the existing Maestro config. Set `MAESTRO_MCP_SOCKET` to the same absolute path on both sides to override it. No tokens or new owner permissions are created. The Unix socket is restricted to its owning OS user, using the existing socket lifecycle code. This is not a security boundary against other processes running as that user.

The bridge calls the plugin's existing readers, not a second coordinator. It exposes only `snapshot`; owner and agent mutation methods are not registered. There are no new ticks, worker sessions or routing loops. Every source error remains visible, with unavailable sections represented as `null`. The UI refreshes every 30 seconds while visible and supports manual refresh; it does not subscribe to events or promise background delivery.

Ask options and notes are local exploration only. Answering asks, dispatching work, waking loops, changing governor policy and fleet review remain in Paseo. In a connected live MCP App, **Discuss in chat** sends a question about the ask to its host; it never submits an answer. Future owner tools need a separate authorization contract, stale-revision checks and an auditable execution path.

## Check

```sh
npm run check
npm run mcp:check
```

The tests exercise MCP initialization, tool metadata, resource retrieval, malformed inputs, unavailable live data, independent source failures, canonical hold counts and denial of owner calls.

For the browser interaction suite, install Playwright's headless shell (`npx playwright install chromium-headless-shell`) and run `npm run mcp:test:ui`. It uses one worker and closes its browser. To reuse an installed shell, set `MAESTRO_HEADLESS_SHELL` to its executable path. The suite checks desktop, chat-column and phone widths; this is not a native iOS test.
