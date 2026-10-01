// A provider list shaped like Paseo's providers.snapshot() entries, for tests.
// The built-in providers' modes and their `isUnattended` are Paseo's own
// (packages/protocol/src/provider-manifest.ts, Paseo dedebbfc5); `acme` is a
// custom provider the fallback in shared/run.ts does not know, so only the
// flag itself can say its `yolo` mode runs without prompts.

export interface FakeMode {
  id: string;
  label: string;
  isUnattended?: true;
}

export interface FakeProvider {
  provider: string;
  status: "ready";
  enabled: true;
  label: string;
  source: "builtin" | "custom";
  defaultModeId: string | null;
  modes: FakeMode[];
}

const entry = (
  provider: string,
  label: string,
  defaultModeId: string | null,
  modes: FakeMode[],
  source: FakeProvider["source"] = "builtin",
): FakeProvider => ({ provider, status: "ready", enabled: true, label, source, defaultModeId, modes });

export const FAKE_PROVIDERS: FakeProvider[] = [
  entry("claude", "Claude", "auto", [
    { id: "plan", label: "Plan Mode" },
    { id: "default", label: "Always Ask" },
    { id: "acceptEdits", label: "Accept File Edits" },
    { id: "auto", label: "Auto mode" },
    { id: "bypassPermissions", label: "Bypass", isUnattended: true },
  ]),
  entry("codex", "Codex", "auto-review", [
    { id: "auto", label: "Default Permissions" },
    { id: "auto-review", label: "Auto-review" },
    { id: "full-access", label: "Full Access", isUnattended: true },
  ]),
  entry("copilot", "Copilot", "https://agentclientprotocol.com/protocol/session-modes#agent", [
    { id: "https://agentclientprotocol.com/protocol/session-modes#agent", label: "Agent" },
    { id: "https://agentclientprotocol.com/protocol/session-modes#plan", label: "Plan" },
    { id: "allow-all", label: "Allow All", isUnattended: true },
  ]),
  entry("opencode", "OpenCode", null, [
    { id: "build", label: "Build" },
    { id: "plan", label: "Plan" },
  ]),
  entry("omp", "Oh My Pi", "full", [
    { id: "full", label: "Full Access", isUnattended: true },
    { id: "write", label: "Write Approval" },
    { id: "ask", label: "Always Ask" },
  ]),
  entry(
    "acme",
    "Acme",
    "careful",
    [
      { id: "careful", label: "Careful" },
      { id: "yolo", label: "Yolo", isUnattended: true },
    ],
    "custom",
  ),
];

/** The same list as Paseo 0.8.0's wire delivers it: its mode schema has no isUnattended, so parsing drops it. */
export const WIRE_PROVIDERS: FakeProvider[] = FAKE_PROVIDERS.map((provider) => ({
  ...provider,
  modes: provider.modes.map(({ id, label }) => ({ id, label })),
}));
