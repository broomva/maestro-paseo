import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { call } from "../bin/maestro";
import { WorkspaceAsks } from "../server/control-home";
import { mcpSocketPath, projectAsk, readMcpSnapshot } from "../server/mcp-read-bridge";
import { controlAskPaths, controlRepoPaths, expandHome, socketPath } from "../server/paths";
import { WorkItemSchema } from "../shared/contracts";
import { homeKey } from "../shared/fleet";
import { askKey, type Snapshot, SnapshotSchema, unavailable } from "../shared/mcp";
import { sampleSnapshot } from "./sample";

export const AnswerRequestSchema = z.object({
  key: z.string().min(1),
  hash: z.string().min(1),
  ledger: z.string().min(1),
  id: z.string().min(1),
  option: z.string().nullable().optional(),
  note: z.string().default(""),
});
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;
export type AnswerResult = { ok: boolean; ask?: unknown; warning?: string | null; error?: string };
export type AnswerHandler = (params: AnswerRequest) => Promise<AnswerResult>;
export type Backend = (() => Promise<Snapshot>) & { answer: AnswerHandler };
export interface BackendOptions {
  demo?: boolean;
  socket?: string;
  controlRepo?: string;
  workSocket?: string;
  answersPath?: string;
  lockRoot?: string;
  receipts?: string;
  /** Isolated fixtures without a remote can disable fetch; live answers keep the existing home rule. */
  fetch?: boolean;
}

export function defaultControlRepo(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.MAESTRO_PASEO_CONTROL_REPO ?? join(homedir(), "broomva"));
}
export function defaultMaestroSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAESTRO_SOCKET ?? socketPath(env);
}
function workspaceFor(options: BackendOptions): WorkspaceAsks {
  const paths = controlAskPaths();
  return new WorkspaceAsks({
    controlRepo: options.controlRepo ?? defaultControlRepo(),
    answersPath: options.answersPath ?? controlRepoPaths().answers,
    lockRoot: options.lockRoot ?? paths.locks,
    receipts: options.receipts ?? paths.receipts,
    fetch: options.fetch,
  });
}
async function workspaceRead(workspace: WorkspaceAsks, options: BackendOptions) {
  const repo = options.controlRepo ?? defaultControlRepo();
  if (!(await stat(repo).catch(() => null))?.isDirectory()) throw new Error(`The control repo ${repo} is unavailable.`);
  const read = await workspace.read(true);
  if (!read.main) throw new Error(read.warnings.join(" ") || "The workspace's origin/main could not be read.");
  return read;
}

/** Use the canonical workspace home rule; unsupported runtime sources remain explicitly unknown. */
export async function readDirectLiveSnapshot(
  options: BackendOptions = {},
  workspace = workspaceFor(options),
): Promise<Snapshot> {
  const read = await workspaceRead(workspace, options);
  const missing = async (): Promise<never> => {
    throw new Error("Requires the live Maestro plugin read bridge.");
  };
  const snapshot = await readMcpSnapshot({
    needs: missing,
    async work() {
      const res = (await call(
        "work.list",
        {},
        { path: options.workSocket ?? defaultMaestroSocket(), timeoutMs: 3000 },
      )) as { items?: unknown[] };
      if (!Array.isArray(res.items)) throw new Error("The work daemon returned no work list.");
      return { items: z.array(WorkItemSchema).parse(res.items) };
    },
    asks: async () => ({ asks: read.all, complete: read.warnings.length === 0 }),
    answers: missing,
    notices: missing,
    fleet: missing,
    loops: missing,
    initiatives: missing,
  });
  if (read.warnings.length) snapshot.errors.asks = read.warnings.join(" ");
  snapshot.capabilities.answerAsks = true;
  snapshot.readOnly = false;
  return snapshot;
}

/** Preserve the client-seen revision all the way into the canonical locked writer. */
export async function answerDecisionAsk(
  input: AnswerRequest,
  options: BackendOptions = {},
  workspace = workspaceFor(options),
): Promise<AnswerResult> {
  try {
    const params = AnswerRequestSchema.parse(input);
    const read = await workspaceRead(workspace, options);
    const matches = read.all.filter(
      (a) => askKey(a) === params.key && a.ledger === params.ledger && a.id === params.id,
    );
    if (matches.length !== 1)
      throw new Error("This decision is no longer at the home you saw. Refresh before answering.");
    const target = matches[0];
    if (target.refusal) throw new Error(target.refusal);
    if (target.state !== "open")
      throw new Error("This decision was already answered or retired. Refresh before answering.");
    if (target.hash !== params.hash)
      throw new Error("This decision changed since you read it. Refresh before answering.");
    const answered = await workspace.answer({
      ledger: target.ledger,
      home: homeKey(target.home),
      uid: target.uid,
      id: target.id,
      hash: params.hash,
      option: params.option ?? null,
      note: params.note,
    });
    return { ok: true, ask: answered.ask, warning: answered.warning };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Demo state belongs to this backend instance; it never calls any filesystem writer. */
export function createBackend(options: BackendOptions = {}): Backend {
  if (options.demo) {
    let snapshot = sampleSnapshot();
    snapshot.capabilities.answerAsks = true;
    snapshot.readOnly = false;
    return Object.assign(async () => structuredClone(snapshot), {
      answer: async (input: AnswerRequest): Promise<AnswerResult> => {
        const parsed = AnswerRequestSchema.safeParse(input);
        if (!parsed.success)
          return { ok: false, error: "Refresh Maestro: this answer needs the decision key and revision." };
        const params = parsed.data;
        const ask = snapshot.asks?.find(
          (a) => a.key === params.key && a.id === params.id && a.ledger === params.ledger,
        );
        if (ask?.state !== "open" || ask.refusal || ask.hash !== params.hash)
          return { ok: false, error: "This sample decision changed or was answered. Refresh before answering." };
        if (params.option && !ask.options.some((o) => o.id === params.option))
          return { ok: false, error: "Choose one of this decision's options." };
        if (!params.option && !params.note.trim()) return { ok: false, error: "Choose an option or write an answer." };
        ask.state = "answered";
        ask.waiting = false;
        snapshot = { ...snapshot, capturedAt: new Date().toISOString() };
        snapshot.needs = snapshot.needs
          ? { ...snapshot.needs, rows: snapshot.needs.rows.filter((r) => r.target?.id !== ask.key) }
          : null;
        if (snapshot.needs) snapshot.needs.total = snapshot.needs.rows.length;
        return { ok: true, ask: structuredClone(ask), warning: "Sample answer only. No live decision was changed." };
      },
    });
  }
  const workspace = workspaceFor(options);
  const read = async () => {
    try {
      const snapshot = SnapshotSchema.parse(
        await call(
          "snapshot",
          {},
          {
            path: options.socket ?? mcpSocketPath(),
            caller: null,
            cwd: null,
            timeoutMs: 3000,
          },
        ),
      );
      // A bridge can include fleet roots. Only exact workspace identities have a writer in this companion.
      try {
        const local = await workspaceRead(workspace, options);
        const authoritative = new Map(local.all.map((ask) => [askKey(ask), projectAsk(ask)]));
        // The plugin may cache reads across an answer. Never return its old revision/state for a workspace key.
        const other = (snapshot.asks ?? [])
          .filter((ask) => !authoritative.has(ask.key))
          .map((ask) => ({
            ...ask,
            refusal:
              ask.refusal ?? "This decision's source does not provide an answer connection here. Open it in Paseo.",
          }));
        snapshot.asks = [...authoritative.values(), ...other];
        if (local.warnings.length) snapshot.errors.asks = local.warnings.join(" ");
        snapshot.capabilities.answerAsks = true;
        snapshot.readOnly = false;
      } catch (error) {
        snapshot.errors.answerConnection =
          error instanceof Error ? error.message : "The workspace answer connection is unavailable.";
        snapshot.capabilities.answerAsks = false;
        snapshot.readOnly = true;
      }
      return snapshot;
    } catch {
      try {
        return await readDirectLiveSnapshot(options, workspace);
      } catch (error) {
        return unavailable(`Maestro connection unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  return Object.assign(read, { answer: (params: AnswerRequest) => answerDecisionAsk(params, options, workspace) });
}
