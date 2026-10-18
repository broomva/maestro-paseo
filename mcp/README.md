# Maestro MCP App

A T3-themed MCP App for reviewing Maestro and answering workspace decisions through the existing canonical writer. The host supplies colors, typography and frame dimensions. A restrained glass navigation layer sits above solid, readable content. The decision reader gives content most of the desktop width; narrower frames show one pane at a time. Its action bar remains outside the scrolling content. Reduced transparency, increased contrast and reduced motion are respected; browser zoom remains enabled.

## Run

```sh
npm ci
npm run mcp:build
codex mcp add maestro -- bun /absolute/path/to/maestro-paseo/mcp/server.ts
```

Reconnect the provider after changing server code or tool schemas, then invoke `maestro_open` with `view: "decisions"`. `maestro_snapshot` refreshes data. Rebuilding HTML updates the resource served on the next open; it does not replace an already mounted resource or restart an existing MCP process. An older connection without the answer capability stays visibly read-only.

This uses the host's MCP Apps frame, inline or fullscreen. It does not add a permanent T3 sidebar or top-level page. Responsive phone testing does not establish native iOS host support.

For fictional data, add `--demo` to the server command, or run `npm run mcp:preview` and open http://127.0.0.1:4318. Sample answers change only that backend instance's memory. Live preview is `bun mcp/preview.ts` without `--demo`; it can answer real workspace asks, so use the labeled sample or isolated test harness for experimentation.

## Data and actions

The optional Paseo read bridge exposes all eight existing readers. Enable `MAESTRO_MCP_READ_BRIDGE=1` in the environment of the daemon loading this plugin version and follow the normal plugin reload procedure. Merely setting the variable on the MCP process does not enable the listener. Both sides use `maestro-mcp.sock` beside the existing Maestro config, overridable with `MAESTRO_MCP_SOCKET`. The socket is restricted to its OS owner; other processes under that account share the same trust boundary.

Without that bridge, the companion reads workspace asks through `WorkspaceAsks` and work through the existing work daemon (`MAESTRO_SOCKET` or its canonical default). `MAESTRO_PASEO_CONTROL_REPO` selects the workspace repository. Unsupported sections remain `null`, with visible source errors; they are never healthy zero counts. Reads do not fetch or change the repository. Data refreshes every 30 seconds while visible, or manually.

Answer sends the exact displayed key, revision hash, ledger, ask ID, selected option and note. The backend resolves that identity through `WorkspaceAsks` and passes the original hash to its locked writer. Existing checkout versus `origin/main`/answers-branch rules and receipts are preserved. Stale, ambiguous, retired and unsupported fleet identities are refused. A note-only answer is supported. Irreversible options require a second confirmation bound to the choice and note. Success requires an explicit confirmation and fresh validated snapshot; recording an answer does not mean its work executed.

Skip only advances or closes the local reader; it never answers, rejects or dispatches. Drafts live in memory until the App is closed. Discuss in chat asks the host for an explanation and never answers on the owner's behalf. Fleet dispatch, tick/loop changes and governor controls remain in Paseo.

## Verify

```sh
npm run check
npm run mcp:check
npm run mcp:test:ui
```

The browser suite uses one headless-shell worker and closes its browser. Install with `npx playwright install chromium-headless-shell`, or set `MAESTRO_HEADLESS_SHELL` to an existing executable. Tests cover wide, chat-column and phone layouts, visible action hit targets, drafts, stale revisions, theme/accessibility settings, and loopback preview restrictions.

`bun mcp/test-host.ts` starts a test-only MCP Apps host on http://127.0.0.1:4322. It uses the actual SDK handshake, actual MCP tools and built resource. `?source=fixture` writes only to a disposable temporary Git repository and exposes its receipt for verification. `?source=live` reads real data but refuses all writes in the harness. This harness is a protocol integration test, separate from native T3/iOS compatibility testing.
