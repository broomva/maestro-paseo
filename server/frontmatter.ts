// `_work.md`: YAML frontmatter (the Maestro work contract) plus a Markdown
// brief. Field names and shapes follow Maestro's protocol package so the
// Maestro runtime can read files written here. Edits go through the YAML
// Document API, so comments and key order the author wrote survive.
//
// Paseo-specific keys sit beside the contract; Maestro's parser ignores keys
// it does not know. `repo` is where runs start. How they start, when the work
// chose it: `provider` (`claude` or `claude/opus`), `isolation` (`worktree` or
// `directory`), `mode`, `thinking`, and `features` (a mapping of the
// provider's feature ids to simple values). An absent key means Settings.
// `hold`, in words, says the work waits for you to start it: neither the loop
// nor a session starts it (an idea you chose to develop, BRO-2802).

import YAML from "yaml";
import { type CheckSpec, FEATURE_LIMITS, type FeatureValues, ISOLATIONS, type Isolation } from "../shared/contracts";
import { type GateMode, isGateMode, isKind, isOrchState, type Kind, type OrchState } from "../shared/states";

export class WorkFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkFileError";
  }
}

export interface Contract {
  id: string;
  kind: Kind;
  state: OrchState;
  gate: GateMode;
  owner: string | null;
  created: string;
  updated: string;
  repo: string | null;
  provider: string | null;
  isolation: Isolation | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: FeatureValues | null;
  checks: CheckRun[];
  /** Why only you start this work, or null. */
  hold: string | null;
}

export interface CheckRun extends CheckSpec {
  timeoutS: number;
  required: boolean;
}

export interface WorkDoc {
  doc: YAML.Document;
  body: string;
}

export const DEFAULT_CHECK_TIMEOUT_S = 600;
export const MAX_CHECK_TIMEOUT_S = 1800;

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseWorkDoc(source: string): WorkDoc {
  const match = FENCE.exec(source);
  if (!match) throw new WorkFileError("missing the --- frontmatter fence");
  const doc = YAML.parseDocument(match[1] ?? "");
  if (doc.errors.length > 0) {
    throw new WorkFileError(`frontmatter is not valid YAML: ${doc.errors[0]?.message ?? ""}`);
  }
  if (!YAML.isMap(doc.contents)) throw new WorkFileError("frontmatter must be a mapping");
  return { doc, body: match[2] ?? "" };
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}

export function readChecks(raw: unknown): CheckRun[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    return raw.trim() ? [{ name: "check", run: raw, timeoutS: DEFAULT_CHECK_TIMEOUT_S, required: true }] : [];
  }
  if (!Array.isArray(raw)) throw new WorkFileError("done.check must be a string or a list");
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new WorkFileError(`done.check[${index}] must be a mapping`);
    }
    const { name, run, timeout_s, required } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof run !== "string" || !run.trim()) {
      throw new WorkFileError(`done.check[${index}] needs a name and a run command`);
    }
    const timeout =
      typeof timeout_s === "number" && timeout_s > 0
        ? Math.min(timeout_s, MAX_CHECK_TIMEOUT_S)
        : DEFAULT_CHECK_TIMEOUT_S;
    return { name, run, timeoutS: timeout, required: required !== false };
  });
}

function readIsolation(raw: unknown): Isolation | null {
  if (raw === undefined || raw === null) return null;
  const known = ISOLATIONS.find((value) => value === raw);
  if (!known) throw new WorkFileError(`unknown isolation ${JSON.stringify(raw)}: use worktree or directory`);
  return known;
}

/** `features`: the provider's feature ids mapped to simple values. Anything else would reach the agent unchecked. */
export function readFeatures(raw: unknown): FeatureValues | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw) || raw instanceof Date) {
    throw new WorkFileError("features must be a mapping of feature ids to values");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > FEATURE_LIMITS.keys)
    throw new WorkFileError(`features holds at most ${FEATURE_LIMITS.keys} values`);
  const values: FeatureValues = {};
  for (const [key, value] of entries) {
    if (key.length > FEATURE_LIMITS.chars)
      throw new WorkFileError(`a features id is longer than ${FEATURE_LIMITS.chars} characters`);
    const simple =
      value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value as number);
    if (!simple) throw new WorkFileError(`features.${key} must be true, false, a number, a string or null`);
    if (typeof value === "string" && value.length > FEATURE_LIMITS.chars) {
      throw new WorkFileError(`features.${key} is longer than ${FEATURE_LIMITS.chars} characters`);
    }
    values[key] = value as FeatureValues[string];
  }
  return Object.keys(values).length > 0 ? values : null;
}

export function readContract(work: WorkDoc): Contract {
  const data = work.doc.toJS() as Record<string, unknown>;
  const id = str(data.id);
  if (!id) throw new WorkFileError("missing id");
  if (!isOrchState(data.state)) throw new WorkFileError(`unknown state ${JSON.stringify(data.state)}`);
  if (!isGateMode(data.gate)) throw new WorkFileError(`unknown gate ${JSON.stringify(data.gate)}`);
  const kind = isKind(data.kind) ? data.kind : "task";
  const done = (data.done ?? {}) as Record<string, unknown>;
  return {
    id,
    kind,
    state: data.state,
    gate: data.gate,
    owner: str(data.owner),
    created: str(data.created) ?? "",
    updated: str(data.updated) ?? "",
    repo: str(data.repo),
    provider: str(data.provider),
    isolation: readIsolation(data.isolation),
    modeId: str(data.mode),
    thinkingOptionId: str(data.thinking),
    featureValues: readFeatures(data.features),
    checks: readChecks(done.check),
    hold: str(data.hold),
  };
}

export function setFields(work: WorkDoc, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) work.doc.delete(key);
    else work.doc.set(key, value);
  }
}

export function renderWorkDoc(work: WorkDoc): string {
  const yaml = work.doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
  return `---\n${yaml}\n---\n${work.body}`;
}

export const TITLE_MAX = 80;

/**
 * The work's name: the title as written, on one line, or else the brief's
 * first non-empty line (a leading heading marker dropped) clipped at a word
 * near TITLE_MAX. Null when both are empty.
 */
export function workTitle(title: string | undefined, brief: string): string | null {
  const own = (title ?? "").replace(/\s+/g, " ").trim();
  if (own) return own;
  for (const raw of brief.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*#+(?=\s|$)/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line) return clip(line, TITLE_MAX);
  }
  return null;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

/** The first Markdown heading, the Maestro title rule. */
export function titleOf(body: string, fallback: string): string {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return heading?.[1]?.trim() || fallback;
}

/** The body without its title heading: what the agent is asked to do. */
export function briefOf(body: string): string {
  return body.replace(/^\s*#\s+.+\n?/, "").trim();
}

export interface NewWork {
  id: string;
  title: string;
  brief: string;
  kind: Kind;
  state: OrchState;
  gate: GateMode;
  repo: string | null;
  check: string;
  date: string;
  run?: RunKeys;
  /** Why only you start this work (Contract.hold). */
  hold?: string;
}

/** How the work's runs start, as stored. Absent or empty means Settings decides at dispatch. */
export interface RunKeys {
  provider?: string;
  isolation?: Isolation;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: FeatureValues;
}

export function newWorkSource(input: NewWork): string {
  const data: Record<string, unknown> = {
    id: input.id,
    kind: input.kind,
    state: input.state,
    gate: input.gate,
  };
  if (input.check.trim()) data.done = { check: input.check.trim() };
  data.created = input.date;
  data.updated = input.date;
  if (input.repo) data.repo = input.repo;
  const run = input.run ?? {};
  if (run.provider?.trim()) data.provider = run.provider.trim();
  if (run.isolation) data.isolation = run.isolation;
  if (run.modeId?.trim()) data.mode = run.modeId.trim();
  if (run.thinkingOptionId?.trim()) data.thinking = run.thinkingOptionId.trim();
  if (run.featureValues && Object.keys(run.featureValues).length > 0) data.features = { ...run.featureValues };
  if (input.hold?.trim()) data.hold = input.hold.trim();
  const yaml = YAML.stringify(data, { lineWidth: 0 }).replace(/\n+$/, "");
  const brief = input.brief.trim();
  const body = brief ? `\n# ${input.title}\n\n${brief}\n` : `\n# ${input.title}\n`;
  return `---\n${yaml}\n---\n${body}`;
}
