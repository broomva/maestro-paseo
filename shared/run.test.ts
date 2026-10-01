import { describe, expect, test } from "bun:test";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import type { NextRun } from "./contracts";
import { FAKE_PROVIDERS, WIRE_PROVIDERS } from "./fake-providers";
import { describeRun, nextRunCopy, runTerms, skipsPrompts } from "./run";

describe("how a run was started, in words", () => {
  test("the provider, then each choice that shaped the run", () => {
    expect(
      describeRun({
        provider: "claude/opus",
        modeId: "bypassPermissions",
        thinkingOptionId: "xhigh",
        featureValues: { fast_mode: true, plan: false, effort: "max", tier: null },
      }),
    ).toBe("claude/opus (mode bypassPermissions, thinking xhigh, fast_mode on, plan off, effort max, tier unset)");
  });

  test("a run with no choices beyond the provider, or an older receipt, is the provider alone", () => {
    expect(describeRun({ provider: "codex/gpt-5.5" })).toBe("codex/gpt-5.5");
    expect(describeRun({ provider: "claude", modeId: null, thinkingOptionId: null, featureValues: null })).toBe(
      "claude",
    );
    expect(runTerms({ featureValues: {} })).toEqual([]);
  });
});

const next = (extra: Partial<NextRun> = {}): NextRun => ({
  provider: "claude",
  isolation: "worktree",
  modeId: null,
  thinkingOptionId: null,
  featureValues: null,
  fromSettings: [],
  ...extra,
});

describe("what skips permission prompts", () => {
  test("Claude's bypassPermissions and Codex's full-access", () => {
    expect(skipsPrompts({ provider: "claude", modeId: "bypassPermissions" })).toBe(true);
    expect(skipsPrompts({ provider: "codex/gpt-5.5", modeId: "full-access" })).toBe(true);
    expect(skipsPrompts({ provider: "claude", modeId: "acceptEdits" })).toBe(false);
    expect(skipsPrompts({ provider: "claude", modeId: null, featureValues: null })).toBe(false);
  });

  // Each provider's modes, as [provider, mode, does it skip prompts]: what the list says, then what we read.
  const marked = (providers: typeof FAKE_PROVIDERS) =>
    providers.flatMap(({ provider, modes }) => modes.map((mode) => [provider, mode.id, mode.isUnattended === true]));

  test("every mode the provider list marks isUnattended, and no other, read from the list itself", () => {
    const read = FAKE_PROVIDERS.flatMap(({ provider, modes }) =>
      modes.map((mode) => [provider, mode.id, skipsPrompts({ provider, modeId: mode.id }, modes)]),
    );
    expect(read).toEqual(marked(FAKE_PROVIDERS));
    // The fixture holds the cases this guards: Copilot's allow-all, OMP's full, and a custom provider's.
    expect(read.filter(([, , skips]) => skips).map(([provider, mode]) => `${provider}:${mode}`)).toEqual([
      "claude:bypassPermissions",
      "codex:full-access",
      "copilot:allow-all",
      "omp:full",
      "acme:yolo",
    ]);
  });

  test("the Queued card warns on every built-in one when the wire drops the flag, as Paseo 0.8.0's does", () => {
    const builtin = (providers: typeof FAKE_PROVIDERS) => providers.filter(({ source }) => source === "builtin");
    const warned = builtin(WIRE_PROVIDERS).flatMap(({ provider, modes }) =>
      modes.map((mode) => [
        provider,
        mode.id,
        nextRunCopy(next({ provider: `${provider}/some-model`, modeId: mode.id }), "queued").warning !== null,
      ]),
    );
    expect(warned).toEqual(marked(builtin(FAKE_PROVIDERS)));
  });

  test("the fallback holds every mode the pinned @getpaseo/protocol marks isUnattended, and no other", () => {
    const read = AGENT_PROVIDER_DEFINITIONS.flatMap((definition) =>
      definition.modes.map((mode) => [
        definition.id,
        mode.id,
        skipsPrompts({ provider: definition.id, modeId: mode.id }),
      ]),
    );
    const pinned = AGENT_PROVIDER_DEFINITIONS.flatMap((definition) =>
      definition.modes.map((mode) => [definition.id, mode.id, mode.isUnattended === true]),
    );
    expect(read).toEqual(pinned);
  });

  test("OpenCode's and ACP's auto_accept, on as true or as \"true\"; off, or another feature, does not", () => {
    expect(skipsPrompts({ featureValues: { auto_accept: true } })).toBe(true);
    expect(skipsPrompts({ modeId: "build", featureValues: { auto_accept: "true" } })).toBe(true);
    expect(skipsPrompts({ featureValues: { auto_accept: false } })).toBe(false);
    expect(skipsPrompts({ featureValues: { fast_mode: true } })).toBe(false);
  });
});

describe("the card line before a verb that can start a run", () => {
  test("names every choice, marks what Settings filled, and warns when the run skips prompts", () => {
    const queued = nextRunCopy(
      next({ modeId: "bypassPermissions", thinkingOptionId: "low", fromSettings: ["provider", "isolation", "modeId"] }),
      "queued",
    );
    expect(queued.line).toBe(
      "Queued. Dispatching starts an agent in a fresh worktree on its own run branch (from Settings). " +
        "Runs with claude (from Settings): mode bypassPermissions (from Settings), thinking low.",
    );
    expect(queued.warning).toBe(
      "This run skips permission prompts: it can edit files and run commands without asking.",
    );
  });

  test("the Stuck card says Unblock may start a new run, and warns for it", () => {
    const stuck = nextRunCopy(
      next({ provider: "opencode/big", isolation: "directory", featureValues: { auto_accept: true } }),
      "stuck",
    );
    expect(stuck.line).toBe(
      "If the session is gone, Unblock starts a new run in the repository itself, with opencode/big: auto_accept on.",
    );
    expect(stuck.warning).toContain("would skip permission prompts");
  });

  test("is quiet for a run that asks, and plain when the work chose everything", () => {
    const asks = nextRunCopy(next({ provider: "claude/opus", modeId: "acceptEdits" }), "queued");
    expect(asks).toEqual({
      line: "Queued. Dispatching starts an agent in a fresh worktree on its own run branch. Runs with claude/opus: mode acceptEdits.",
      warning: null,
    });
    expect(nextRunCopy(undefined, "stuck").warning).toBeNull();
  });
});
