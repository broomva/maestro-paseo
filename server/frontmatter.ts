// `_work.md`: YAML frontmatter (the Maestro work contract) plus a Markdown
// brief. Field names and shapes follow Maestro's protocol package so the
// Maestro runtime can read files written here. Edits go through the YAML
// Document API, so comments and key order the author wrote survive.
//
// Paseo-specific keys (`repo`, `provider`) sit beside the contract; Maestro's
// parser ignores keys it does not know.

import YAML from "yaml";
import type { CheckSpec } from "../shared/contracts";
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
  checks: CheckRun[];
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
    checks: readChecks(done.check),
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
  const yaml = YAML.stringify(data, { lineWidth: 0 }).replace(/\n+$/, "");
  const brief = input.brief.trim();
  const body = brief ? `\n# ${input.title}\n\n${brief}\n` : `\n# ${input.title}\n`;
  return `---\n${yaml}\n---\n${body}`;
}
