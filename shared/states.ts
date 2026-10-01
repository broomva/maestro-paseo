// The work lifecycle, shared by the daemon and the app.
//
// The eight system states are Maestro's OrchState enum, unchanged, so a
// `_work.md` written here stays readable by the Maestro runtime. The UI never
// shows them: it shows the six plain-voice labels (Queued, Running, Stuck,
// Needs you, Done, Standing).
//
// Paseo owns execution, so the transition graph differs from the Maestro
// runtime's in two documented places:
//   1. review -> running. A clean run parks at review; "Send back" wakes the
//      same Paseo agent with a note instead of queueing a fresh dispatch. A
//      permission request also parks at review and returns to running once it
//      is answered.
//   2. cancel from proposed, triggered or blocked. Maestro routes this through
//      an audited human override; here it is the "Cancel work" verb, recorded
//      in the event log as a human action.
//   3. review -> blocked, only when the session behind a pending question is
//      gone: nobody is left to answer, so the work is stuck, not waiting.
// The invariant that matters is kept exactly: under gate:human nothing reaches
// done without an approve verdict.

export const ORCH_STATES = [
  "proposed",
  "reviewing",
  "triggered",
  "running",
  "blocked",
  "review",
  "done",
  "canceled",
] as const;
export type OrchState = (typeof ORCH_STATES)[number];

export const GATE_MODES = ["human", "auto"] as const;
export type GateMode = (typeof GATE_MODES)[number];

export const KINDS = ["question", "task", "project", "initiative", "routine"] as const;
export type Kind = (typeof KINDS)[number];

export const VERDICTS = ["approve", "revise", "block"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type PlainVoice = "Queued" | "Running" | "Stuck" | "Needs you" | "Done" | "Standing";
export type Tone = "muted" | "active" | "warn" | "accent" | "success";

export const PLAIN_VOICE: Record<OrchState, { label: PlainVoice; tone: Tone }> = {
  proposed: { label: "Queued", tone: "muted" },
  reviewing: { label: "Queued", tone: "muted" },
  triggered: { label: "Queued", tone: "muted" },
  running: { label: "Running", tone: "active" },
  blocked: { label: "Stuck", tone: "warn" },
  review: { label: "Needs you", tone: "accent" },
  done: { label: "Done", tone: "success" },
  canceled: { label: "Done", tone: "muted" },
};

export const isOrchState = (value: unknown): value is OrchState =>
  typeof value === "string" && (ORCH_STATES as readonly string[]).includes(value);

export const isGateMode = (value: unknown): value is GateMode =>
  typeof value === "string" && (GATE_MODES as readonly string[]).includes(value);

export const isKind = (value: unknown): value is Kind =>
  typeof value === "string" && (KINDS as readonly string[]).includes(value);

export const isTerminal = (state: OrchState): boolean => state === "done" || state === "canceled";

export const isAttention = (state: OrchState): boolean => state === "review" || state === "blocked";

/** Queued states: the ones anyone may dispatch from. Stuck work dispatches too, but only from Maestro. */
export const isDispatchable = (state: OrchState): boolean =>
  state === "proposed" || state === "reviewing" || state === "triggered";

/** Attention first, then what is moving, then backlog, then receipts. */
export const GROUP_ORDER = ["review", "blocked", "running", "queued", "done"] as const;
export type Group = (typeof GROUP_ORDER)[number];

export function groupOf(state: OrchState): Group {
  switch (state) {
    case "review":
      return "review";
    case "blocked":
      return "blocked";
    case "running":
      return "running";
    case "done":
    case "canceled":
      return "done";
    default:
      return "queued";
  }
}

export const GROUP_COPY: Record<Group, { title: PlainVoice; hint: string }> = {
  review: { title: "Needs you", hint: "Runs waiting at your gate" },
  blocked: { title: "Stuck", hint: "A worker stopped and needs a hand" },
  running: { title: "Running", hint: "Dispatched and live in a worktree" },
  queued: { title: "Queued", hint: "Ready when you dispatch it" },
  done: { title: "Done", hint: "The branch is the receipt" },
};

/** The Queued hint while the loop is on (Settings, loopMinutes): it, not only you, starts that work. */
export const QUEUED_LOOP_HINT = "The loop starts these on its next wake, under the run cap";

const LEGAL: Record<OrchState, readonly OrchState[]> = {
  proposed: ["reviewing", "triggered", "running", "canceled"],
  reviewing: ["triggered", "running", "canceled"],
  triggered: ["running", "canceled"],
  running: ["review", "blocked", "done"],
  blocked: ["running", "triggered", "canceled"],
  review: ["done", "running", "canceled", "blocked"],
  done: [],
  canceled: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrchState,
    readonly to: OrchState,
    detail?: string,
  ) {
    super(`Cannot move work from ${from} to ${to}${detail ? `: ${detail}` : ""}`);
    this.name = "IllegalTransitionError";
  }
}

export interface TransitionContext {
  gate: GateMode;
  verdict?: Verdict;
  /** True when every required done check passed on this run. */
  checksPassed?: boolean;
}

/** Validate one transition. Returns the target state or throws. */
export function transition(from: OrchState, to: OrchState, ctx: TransitionContext): OrchState {
  if (!LEGAL[from].includes(to)) {
    throw new IllegalTransitionError(from, to);
  }
  if (from === "review" && to === "done" && ctx.verdict !== "approve") {
    throw new IllegalTransitionError(from, to, "only an approve verdict closes gated work");
  }
  if (from === "running" && to === "done" && !(ctx.gate === "auto" && ctx.checksPassed === true)) {
    throw new IllegalTransitionError(
      from,
      to,
      "a run reaches done on its own only under gate:auto with passing checks",
    );
  }
  return to;
}

/** The state a gate verdict moves review work to. */
export function verdictTarget(verdict: Verdict): OrchState {
  switch (verdict) {
    case "approve":
      return "done";
    case "revise":
      return "running";
    case "block":
      return "canceled";
  }
}

/**
 * Where a finished run lands, given the gate and the check outcome. gate:auto
 * without a check is rejected at creation; a hand-edited file that has one
 * anyway lands at the human gate rather than closing itself.
 */
export function landingState(gate: GateMode, checks: "passed" | "failed" | "none"): OrchState {
  if (gate === "auto" && checks === "passed") return "done";
  if (gate === "auto" && checks === "failed") return "blocked";
  return "review";
}
