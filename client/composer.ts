// The New work composer's logic, kept free of React so it can be tested: what
// each pill shows, given the Paseo provider reads and Settings, and what
// `work.create` receives. A choice the person did not make is not sent, so
// the server applies Settings at dispatch time.

import type { FeatureValue, FeatureValues, Isolation, RunChoices } from "../shared/contracts";
import type { GateMode } from "../shared/states";

/** The fields of Paseo's provider payloads the composer reads (`paseo.providers.*`). */
export interface Choice {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface ModelDef {
  provider: string;
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  isDefault?: boolean;
  isSelectable?: boolean;
  thinkingOptions?: Choice[];
  defaultThinkingOptionId?: string;
}

export interface ModeDef {
  id: string;
  label: string;
  description?: string;
  icon?: string;
}

interface FeatureBase {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
}
export type FeatureDef =
  | (FeatureBase & { type: "toggle"; value: boolean })
  | (FeatureBase & { type: "select"; value: string | null; options: Choice[] });

/** The agent half of a draft: only what the person picked. Null or empty keeps Settings. */
export interface AgentDraft {
  /** `provider` (its default model) or `provider/model`. */
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  /** Only the features the person changed. */
  featureValues: FeatureValues;
}

export const EMPTY_AGENT: AgentDraft = { model: null, modeId: null, thinkingOptionId: null, featureValues: {} };

/** `claude/opus` belongs to `claude`. */
export function family(selection: string): string {
  return selection.trim().split("/")[0] ?? "";
}

export function modelKey(model: Pick<ModelDef, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function selectable(models: readonly ModelDef[]): ModelDef[] {
  return models.filter((model) => model.isSelectable !== false);
}

/**
 * The model a selection means: `provider/model` names one (by id or alias),
 * a bare `provider` means its default model, as the server resolves it.
 */
export function resolveModel(models: readonly ModelDef[], selection: string | null): ModelDef | null {
  if (!selection) return null;
  const slash = selection.indexOf("/");
  const usable = selectable(models).filter((model) => model.provider === family(selection));
  if (slash >= 0) {
    const id = selection.slice(slash + 1);
    return usable.find((model) => model.id === id || model.aliases?.includes(id)) ?? null;
  }
  return usable.find((model) => model.isDefault) ?? usable[0] ?? null;
}

/** The thinking level the pill shows: the pick when the model offers it, else the model's default. */
export function thinkingShown(model: ModelDef | null, picked: string | null): Choice | null {
  const options = model?.thinkingOptions ?? [];
  if (options.length === 0) return null;
  const wanted = picked ?? model?.defaultThinkingOptionId ?? null;
  return (
    options.find((option) => option.id === wanted) ??
    options.find((option) => option.isDefault) ??
    options.find((option) => option.id === model?.defaultThinkingOptionId) ??
    null
  );
}

/**
 * The mode the pill shows: the pick, else the Settings mode while the run
 * uses the Settings provider (the server's rule), else the provider default.
 */
export function modeShown(
  modes: readonly ModeDef[],
  input: {
    picked: string | null;
    shownFamily: string | null;
    settings: { provider: string; modeId: string | null } | null;
    providerDefault: string | null;
  },
): ModeDef | null {
  const { picked, shownFamily, settings, providerDefault } = input;
  const fromSettings =
    settings?.modeId && shownFamily !== null && family(settings.provider) === shownFamily ? settings.modeId : null;
  const wanted = picked ?? fromSettings ?? providerDefault;
  return modes.find((mode) => mode.id === wanted) ?? null;
}

/** Picking a model starts its thinking and features over; a mode survives only within one provider. */
export function withModel(draft: AgentDraft, next: string, shownFamily: string | null): AgentDraft {
  return {
    model: next,
    modeId: family(next) === shownFamily ? draft.modeId : null,
    thinkingOptionId: null,
    featureValues: {},
  };
}

/**
 * The agent fields for `work.create`. A mode, a thinking level or a feature is
 * chosen against the model the pill shows, so choosing any of them pins that
 * model: a bare provider would resolve to its own default at dispatch, which
 * is not always the model Settings names. Nothing chosen sends nothing.
 */
export function agentChoices(
  draft: AgentDraft,
  shown: { model: string | null; family: string | null },
): Pick<RunChoices, "provider" | "modeId" | "thinkingOptionId" | "featureValues"> {
  const hasFeatures = Object.keys(draft.featureValues).length > 0;
  const pinsModel = draft.modeId !== null || draft.thinkingOptionId !== null || hasFeatures;
  const provider = draft.model ?? (pinsModel ? (shown.model ?? shown.family) : null);
  return {
    ...(provider ? { provider } : {}),
    ...(draft.modeId ? { modeId: draft.modeId } : {}),
    ...(draft.thinkingOptionId ? { thinkingOptionId: draft.thinkingOptionId } : {}),
    ...(hasFeatures ? { featureValues: { ...draft.featureValues } } : {}),
  };
}

export interface ContractDraft {
  title: string;
  brief: string;
  repo: string;
  check: string;
  gate: GateMode;
  initiative: string;
  /** Null keeps Settings. */
  isolation: Isolation | null;
}

/** Enough to name the work and to know where it runs. */
export function canSubmit(draft: Pick<ContractDraft, "title" | "brief" | "repo">): boolean {
  return Boolean((draft.title.trim() || draft.brief.trim()) && draft.repo.trim());
}

export function createInput(
  contract: ContractDraft,
  agent: AgentDraft,
  shown: { model: string | null; family: string | null },
  dispatch: boolean,
) {
  const check = contract.check.trim();
  return {
    ...(contract.title.trim() ? { title: contract.title.trim() } : {}),
    brief: contract.brief,
    repo: contract.repo.trim(),
    check,
    gate: check ? contract.gate : ("human" as const),
    initiative: contract.initiative.trim(),
    dispatch,
    ...(contract.isolation ? { isolation: contract.isolation } : {}),
    ...agentChoices(agent, shown),
  };
}

/** One sentence under the composer: where it runs and where it is filed. */
export function contractSummary(input: { project: string | null; isolation: Isolation; initiative: string }): string {
  const where = input.project
    ? input.isolation === "worktree"
      ? `Runs in a new worktree of ${input.project}`
      : `Runs in ${input.project} itself`
    : "Choose where it runs";
  const filed = input.initiative.trim() ? `filed under ${input.initiative.trim()}` : "at the top of the work folder";
  return `${where}, ${filed}.`;
}

/** Initiatives already in use, busiest first. */
export function initiativesOf(
  items: ReadonlyArray<{ initiative: string | null }>,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.initiative) counts.set(item.initiative, (counts.get(item.initiative) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** `/Users/me/broomva` reads as `~/broomva`. Display only. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** Paseo names feature icons in kebab case (`list-todo`); the plugin Icon takes lucide names (`ListTodo`). */
export function featureIcon(icon: string | undefined): string {
  if (!icon) return "Settings2";
  return icon
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** A value the feature can hold, or the feature's own when the draft has none. */
export function featureValue(feature: FeatureDef, draft: FeatureValues): FeatureValue {
  return Object.hasOwn(draft, feature.id) ? (draft[feature.id] ?? null) : feature.value;
}

/**
 * The words on the model, thinking and mode pills. Each pill is always shown:
 * "Loading\u2026" while its read (or Settings) is in flight, the answer once
 * there is one, and "Settings default" when the read failed or listed
 * nothing, since then the run starts the way Settings says.
 */
export function agentPillLabels(input: {
  settingsLoading: boolean;
  modelsLoading: boolean;
  modesLoading: boolean;
  model: Pick<ModelDef, "label"> | null;
  thinking: Pick<Choice, "label"> | null;
  mode: Pick<ModeDef, "label"> | null;
}): { model: string; thinking: string; mode: string } {
  const models = input.settingsLoading || input.modelsLoading;
  return {
    model: pillLabel({ loading: models, label: input.model?.label }),
    thinking: pillLabel({ loading: models, label: input.thinking?.label }),
    mode: pillLabel({ loading: input.settingsLoading || input.modesLoading, label: input.mode?.label }),
  };
}

/** A pill's words while its provider read is in flight, failed, or answered. */
export function pillLabel(read: { loading: boolean; label: string | null | undefined }): string {
  if (read.label) return read.label;
  return read.loading ? "Loading…" : "Settings default";
}
