import { describe, expect, test } from "bun:test";
import {
  agentChoices,
  agentPillLabels,
  canSubmit,
  contractSummary,
  createInput,
  EMPTY_AGENT,
  featureIcon,
  featureValue,
  initiativesOf,
  type ModelDef,
  modelKey,
  modeShown,
  pillLabel,
  resolveModel,
  shortPath,
  thinkingShown,
  withModel,
} from "./composer";

const models: ModelDef[] = [
  { provider: "claude", id: "haiku", label: "Haiku 4.5" },
  {
    provider: "claude",
    id: "opus",
    label: "Opus 5.5",
    aliases: ["claude-opus-5-5"],
    isDefault: true,
    thinkingOptions: [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
      { id: "xhigh", label: "Extra high" },
    ],
    defaultThinkingOptionId: "high",
  },
  { provider: "claude", id: "hidden", label: "Hidden", isSelectable: false, isDefault: true },
];

const contract = {
  title: "",
  brief: "Trim the cache",
  repo: " /repo ",
  check: "",
  gate: "auto" as const,
  initiative: " hawthorne ",
  isolation: null,
};

describe("what the pills show", () => {
  test("a bare provider means its default selectable model; provider/model names one by id or alias", () => {
    expect(resolveModel(models, "claude")?.id).toBe("opus");
    expect(resolveModel(models, "claude/haiku")?.id).toBe("haiku");
    expect(resolveModel(models, "claude/claude-opus-5-5")?.id).toBe("opus");
    expect(resolveModel(models, "claude/hidden")).toBeNull();
    expect(resolveModel(models, "codex")).toBeNull();
    expect(resolveModel(models, null)).toBeNull();
  });

  test("thinking shows the pick when the model offers it, else the model's default; none when it has no levels", () => {
    const opus = models[1] ?? null;
    expect(thinkingShown(opus, "xhigh")?.label).toBe("Extra high");
    expect(thinkingShown(opus, "max")?.label).toBe("High");
    expect(thinkingShown(opus, null)?.label).toBe("High");
    expect(thinkingShown(models[0] ?? null, null)).toBeNull();
  });

  test("the Settings mode shows only while the composer is on the Settings provider", () => {
    const modes = [
      { id: "default", label: "Always ask" },
      { id: "bypassPermissions", label: "Bypass" },
      { id: "full-access", label: "Full access" },
    ];
    const settings = { provider: "claude/opus", modeId: "bypassPermissions" };
    const base = { picked: null, settings, providerDefault: "default" };
    expect(modeShown(modes, { ...base, shownFamily: "claude" })?.label).toBe("Bypass");
    expect(modeShown(modes, { ...base, shownFamily: "codex" })?.label).toBe("Always ask");
    expect(modeShown(modes, { ...base, shownFamily: "claude", picked: "full-access" })?.label).toBe("Full access");
    expect(modeShown(modes, { ...base, shownFamily: "claude", settings: null, providerDefault: null })).toBeNull();
  });

  test("each agent pill says Loading while its read runs, and Settings default when it failed or listed nothing", () => {
    const idle = { settingsLoading: false, modelsLoading: false, modesLoading: false };
    expect(agentPillLabels({ ...idle, modelsLoading: true, model: null, thinking: null, mode: null })).toEqual({
      model: "Loading\u2026",
      thinking: "Loading\u2026",
      mode: "Settings default",
    });
    expect(agentPillLabels({ ...idle, modesLoading: true, model: null, thinking: null, mode: null }).mode).toBe(
      "Loading\u2026",
    );
    expect(agentPillLabels({ ...idle, settingsLoading: true, model: null, thinking: null, mode: null })).toEqual({
      model: "Loading\u2026",
      thinking: "Loading\u2026",
      mode: "Loading\u2026",
    });
    // An error payload or an empty list resolves nothing: every pill stays, reading Settings default.
    expect(agentPillLabels({ ...idle, model: null, thinking: null, mode: null })).toEqual({
      model: "Settings default",
      thinking: "Settings default",
      mode: "Settings default",
    });
    expect(
      agentPillLabels({
        ...idle,
        model: { label: "Opus 5.5" },
        thinking: { label: "High" },
        mode: { label: "Bypass" },
      }),
    ).toEqual({ model: "Opus 5.5", thinking: "High", mode: "Bypass" });
  });

  test("a read in flight says so; a failed or empty one falls back to Settings", () => {
    expect(pillLabel({ loading: true, label: null })).toBe("Loading…");
    expect(pillLabel({ loading: false, label: undefined })).toBe("Settings default");
    expect(pillLabel({ loading: true, label: "Opus 5.5" })).toBe("Opus 5.5");
  });
});

describe("what work.create receives", () => {
  test("untouched agent pills send nothing, so Settings decides at dispatch", () => {
    const input = createInput(contract, EMPTY_AGENT, { model: "claude/opus", family: "claude" }, true);
    expect(input).toEqual({
      brief: "Trim the cache",
      repo: "/repo",
      check: "",
      gate: "human",
      initiative: "hawthorne",
      dispatch: true,
    });
  });

  test("a written title, a check with its gate, and a picked isolation are sent", () => {
    const input = createInput(
      { ...contract, title: " Trim ", check: " bun test ", isolation: "directory" },
      EMPTY_AGENT,
      { model: null, family: null },
      false,
    );
    expect(input).toMatchObject({ title: "Trim", check: "bun test", gate: "auto", isolation: "directory" });
  });

  test("a mode, thinking or feature pins the model the pill shows, never the provider's own default", () => {
    // Settings names haiku; the provider's default is opus. A bare "claude" would run opus.
    const settingsModel = resolveModel(models, "claude/haiku");
    expect(settingsModel?.id).toBe("haiku");
    expect(resolveModel(models, "claude")?.id).toBe("opus");
    const shown = { model: settingsModel ? modelKey(settingsModel) : null, family: "claude" };
    expect(agentChoices({ ...EMPTY_AGENT, modeId: "bypassPermissions" }, shown)).toEqual({
      provider: "claude/haiku",
      modeId: "bypassPermissions",
    });
    expect(agentChoices({ ...EMPTY_AGENT, thinkingOptionId: "xhigh" }, shown)).toEqual({
      provider: "claude/haiku",
      thinkingOptionId: "xhigh",
    });
    expect(agentChoices({ ...EMPTY_AGENT, featureValues: { fast_mode: true } }, shown)).toEqual({
      provider: "claude/haiku",
      featureValues: { fast_mode: true },
    });
    expect(agentChoices({ ...EMPTY_AGENT, model: "codex" }, shown)).toEqual({ provider: "codex" });
    // With no model resolved (the read failed), the provider Settings names is all there is to pin.
    expect(agentChoices({ ...EMPTY_AGENT, modeId: "plan" }, { model: null, family: "claude" })).toEqual({
      provider: "claude",
      modeId: "plan",
    });
  });

  test("picking a model starts thinking and features over; a mode survives only within its provider", () => {
    const draft = { model: null, modeId: "plan", thinkingOptionId: "max", featureValues: { fast_mode: true } };
    expect(withModel(draft, "claude/haiku", "claude")).toEqual({
      model: "claude/haiku",
      modeId: "plan",
      thinkingOptionId: null,
      featureValues: {},
    });
    expect(withModel(draft, "codex/gpt-5.5", "claude").modeId).toBeNull();
  });

  test("the work needs a name and a place", () => {
    expect(canSubmit({ title: "", brief: "", repo: "/repo" })).toBe(false);
    expect(canSubmit({ title: "", brief: "x", repo: " " })).toBe(false);
    expect(canSubmit({ title: "x", brief: "", repo: "/repo" })).toBe(true);
    expect(canSubmit({ title: " ", brief: "x", repo: "/repo" })).toBe(true);
  });
});

describe("the words around it", () => {
  test("one sentence says where it runs and where it is filed", () => {
    expect(contractSummary({ project: "broomva", isolation: "worktree", initiative: "hawthorne" })).toBe(
      "Runs in a new worktree of broomva, filed under hawthorne.",
    );
    expect(contractSummary({ project: "paseo", isolation: "directory", initiative: "" })).toBe(
      "Runs in paseo itself, at the top of the work folder.",
    );
    expect(contractSummary({ project: null, isolation: "worktree", initiative: "" })).toBe(
      "Choose where it runs, at the top of the work folder.",
    );
  });

  test("initiatives in use, busiest first", () => {
    const items = [
      { initiative: "kanon" },
      { initiative: "hawthorne" },
      { initiative: null },
      { initiative: "hawthorne" },
    ];
    expect(initiativesOf(items)).toEqual([
      { name: "hawthorne", count: 2 },
      { name: "kanon", count: 1 },
    ]);
  });

  test("paths and icons read the way Paseo shows them", () => {
    expect(shortPath("/Users/me/broomva/apps")).toBe("~/broomva/apps");
    expect(shortPath("/home/me")).toBe("~");
    expect(shortPath("/opt/repo")).toBe("/opt/repo");
    expect(featureIcon("list-todo")).toBe("ListTodo");
    expect(featureIcon("zap")).toBe("Zap");
    expect(featureIcon(undefined)).toBe("Settings2");
  });

  test("a feature shows the draft's value once changed, else its own", () => {
    const fast = { type: "toggle" as const, id: "fast_mode", label: "Fast", value: false };
    expect(featureValue(fast, {})).toBe(false);
    expect(featureValue(fast, { fast_mode: true })).toBe(true);
  });
});
