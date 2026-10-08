// The loop reconcile (BRO-2911 spec §4): intent beside observation, and the
// drift between them. Pure: reconcile(intents, observations, now, evidence)
// computes every row from what it is given and reads nothing, so each drift
// class is driven by a test in both polarities (server/loops-model.test.ts).
//
// Joining by subject gives three cases: intent only, observation only, both.
// A bound row (§1a) joins its live Paseo schedule by name, since a rollover
// replaces the schedule and only its name survives. Rows with scope sri get
// badges but never Needs-you; scope external rows never get UNREGISTERED; an
// ephemeral observation no row claims is listed under Session & watchers and
// raises nothing. The pinned fix of each class is words or a command to copy:
// Maestro runs none of it (BRO-2910), and the rollover a BOUND_SESSION_GONE
// asks for is BRO-2933's (rolloverSeam).

import {
  DRIFT_CLASSES,
  type DriftClass,
  driftName,
  type LoopDrift,
  type LoopIntent,
  type LoopNotice,
  type LoopObservation,
  type LoopRow,
  type LoopRun,
  type SubstrateKind,
} from "../shared/loops";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** A fire with no started tick for its slot is TICK_MISSING once its slot is this old (§4); a late tick clears it. */
export const TICK_WAIT_MS = 30 * MIN;
/** A started tick with no end is unclosed after max(this, 2 × the row's median tick length), from the start (§4). */
export const TICK_CLOSE_MS = 60 * MIN;
/** Two live schedules under one name are drift once both have lived this long (one rollover takes minutes). */
export const DUPLICATE_MS = 10 * MIN;
/** SKIPPED_BUSY reaches Needs you after this many busy fires in a row. */
export const BUSY_RUN = 3;
/** A session cron's own maximum life (CronCreate: recurring tasks auto-expire after 7 days). */
export const CRON_LIFE_MS = 7 * DAY;
export const EXPIRING_MS = DAY;

/**
 * The pinned auth-failure list (§4 BOUND_SESSION_GONE (b)): a session whose
 * last error says one of these is dead on its login, not glitching. Matched
 * case-insensitively; each has a fixture in loops-model.test.ts.
 */
export const AUTH_FAILURES: readonly RegExp[] = [
  /organization has disabled Claude subscription access/i,
  /OAuth token has expired/i,
  /Please run \/login/i,
  /Invalid API key/i,
  /authentication_error/i,
  /Login expired/i,
];
export const authFailure = (text: string | null | undefined): boolean =>
  Boolean(text) && AUTH_FAILURES.some((pattern) => pattern.test(text as string));

/** Paseo's word for a heartbeat that landed on an agent mid-turn: the bound session is in use, not failing. */
export const BUSY = /already has an active run/i;
const isBusy = (run: LoopRun) => run.status === "failed" && BUSY.test(run.detail ?? "");

/** A loop.tick.* line of ledger/loops/ticks.jsonl (§1a), as read. */
export interface TickEvent {
  id: string;
  ts: string;
  type: string;
  subject: string;
  cause: string | null;
  data: Record<string, unknown>;
}

/** A loop.rollover.* line of ledger/loops/rollover.jsonl (§7), as read. */
export type RolloverEvent = TickEvent;

/** A Paseo agent as the lookup found it: whether it exists, and when it was archived. */
export interface AgentState {
  found: boolean;
  archivedAt: string | null;
}

/** What a bound row's substrate targets and says: the baseline TARGET_CHANGED compares the live one with. */
export interface Binding {
  agentId: string | null;
  prompt: string | null;
}

/** What the reconcile reads beside intents and observations; each part absent is not judged. */
export interface Evidence {
  ticks?: readonly TickEvent[];
  rollovers?: readonly RolloverEvent[];
  /** A loop's state file (§1a), by loop id. */
  states?: ReadonlyMap<string, "ok" | "missing" | "unparseable">;
  /** Paseo agents, by id. An id not in the map was not looked up: (a) is not judged on it. */
  agents?: ReadonlyMap<string, AgentState>;
  /** The binding last seen for each bound row, by loop id; none: this is the first sight, which sets it. */
  baselines?: ReadonlyMap<string, Binding>;
  /** Substrates that could not be read this time: their rows judge nothing (no false ABSENT). */
  unread?: ReadonlySet<SubstrateKind>;
}

/** The Timeline raises these itself (shared/timeline.ts timelineNotices); Loops shows the badge, never a second notice. */
const TIMELINE_RAISES: Record<SubstrateKind, boolean> = {
  launchd: true,
  "paseo-schedule": true,
  "paseo-heartbeat": true,
  "maestro-loop": true,
  "gha-schedule": false,
  "session-cron": false,
  p9: false,
};

// ── Subjects and joins ───────────────────────────────────────────────────────

/** A ledger row's subject (§1): `loop:<id>`. */
export const rowSubject = (id: string) => `loop:${id}`;

/** The observation subject a substrate ref names (§1 table), for kinds joined by subject. */
export function observationSubject(kind: SubstrateKind, ref: string): string {
  if (kind === "maestro-loop") return "loop:maestro/wake";
  if (kind === "gha-schedule") {
    const [owner, repo, , , file] = ref.split("/");
    return `loop:gha/${owner}/${repo}/${file}`;
  }
  return `loop:${kind}/${ref}`;
}

const isPaseo = (kind: SubstrateKind) => kind === "paseo-heartbeat" || kind === "paseo-schedule";

/** Whether a session-cron row's `<owner>#<prompt prefix>` names this cron (§4 "Matching a session-cron row"). */
export function sessionCronMatches(ref: string, observation: LoopObservation): boolean {
  const at = ref.indexOf("#");
  if (at < 0 || observation.kind !== "session-cron") return false;
  const owner = ref.slice(0, at);
  const prefix = ref.slice(at + 1);
  const prompt = observation.target?.prompt ?? "";
  if (!prompt.startsWith(prefix)) return false;
  if (owner === "*") return true;
  const agent = observation.session?.agentId ?? "";
  return agent !== "" && agent.startsWith(owner);
}

/** The observations a row claims: one, or for a name: ref every live schedule of that name (DUPLICATE_BINDING). */
export function claimed(intent: LoopIntent, observations: readonly LoopObservation[]): LoopObservation[] {
  const { kind, ref } = intent.substrate;
  if (isPaseo(kind) && ref.startsWith("name:")) {
    const name = ref.slice("name:".length);
    const named = observations.filter((one) => isPaseo(one.kind) && one.scheduleName === name);
    const newest = (a: LoopObservation, b: LoopObservation) => instant(b.createdAt) - instant(a.createdAt);
    // The newest live one is the binding; none live, the newest of any. The rest are its own, never unregistered.
    return [
      ...named.filter((one) => one.presence === "on").sort(newest),
      ...named.filter((one) => one.presence !== "on").sort(newest),
    ];
  }
  if (kind === "session-cron") return observations.filter((one) => sessionCronMatches(ref, one));
  if (isPaseo(kind)) return observations.filter((one) => isPaseo(one.kind) && one.ref === ref);
  const subject = observationSubject(kind, ref);
  return observations.filter((one) => one.subject === subject);
}

function instant(value: string | null | undefined): number {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

// ── The pinned fixes ─────────────────────────────────────────────────────────

const gha = (ref: string) => {
  const [owner, repo, , , file] = ref.split("/");
  return { repo: `${owner}/${repo}`, file: file ?? ref };
};

function stopCommand(kind: SubstrateKind, ref: string, id: string | null): string {
  switch (kind) {
    case "launchd":
      return `launchctl bootout gui/$UID/${ref} && launchctl disable gui/$UID/${ref}`;
    case "paseo-heartbeat":
    case "paseo-schedule":
      return `paseo schedule pause ${id ?? ref}`;
    case "gha-schedule":
      return `gh workflow disable ${gha(ref).file} -R ${gha(ref).repo}`;
    case "maestro-loop":
      return "Turn Maestro's loop off in Settings.";
    case "session-cron":
      return "Ask the owning session to CronDelete it.";
    case "p9":
      return "Stop the watcher in the session that started it.";
  }
}

function startCommand(kind: SubstrateKind, ref: string, id: string | null): string {
  switch (kind) {
    case "launchd":
      return `launchctl enable gui/$UID/${ref} && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${ref}.plist`;
    case "paseo-heartbeat":
    case "paseo-schedule":
      return id ? `paseo schedule resume ${id}` : `Re-create the ${ref} schedule (none is live).`;
    case "gha-schedule":
      return `gh workflow enable ${gha(ref).file} -R ${gha(ref).repo}`;
    case "maestro-loop":
      return "Turn Maestro's loop on in Settings.";
    case "session-cron":
      return "Re-create it in a live session, or move it to a Paseo heartbeat.";
    case "p9":
      return "Start the watcher again: p9 watch <pr> --background.";
  }
}

function runOnceCommand(kind: SubstrateKind, ref: string, id: string | null): string {
  switch (kind) {
    case "launchd":
      return `launchctl kickstart gui/$UID/${ref}`;
    case "paseo-heartbeat":
    case "paseo-schedule":
      return `paseo schedule run-once ${id ?? ref}`;
    case "gha-schedule":
      return `gh workflow run ${gha(ref).file} -R ${gha(ref).repo}`;
    case "maestro-loop":
      return "Wake the loop now from its panel.";
    default:
      return "Run it once by hand.";
  }
}

/** A ledger row stub for an observation no row claims (UNREGISTERED's pinned fix). */
export function rowStub(observation: LoopObservation): { id: string; yaml: string } {
  const base =
    observation.kind === "launchd"
      ? observation.ref.replace(/^com\.broomva\./, "")
      : observation.kind === "gha-schedule"
        ? `${observation.ref.split("/")[1] ?? ""}-${(observation.ref.split("/").at(-1) ?? "").replace(/\.ya?ml$/, "")}`
        : (observation.scheduleName ?? observation.name);
  const id =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "loop";
  const yaml = [
    `id: ${id}`,
    `title: ${JSON.stringify(observation.name)}`,
    'purpose: "<why it runs>"',
    "owner: unknown",
    "scope: broomva",
    `substrate: {kind: ${observation.kind}, ref: ${JSON.stringify(observation.ref)}}`,
    `cadence: ${JSON.stringify(observation.cadence)}`,
    "desired: active",
    'retires: {none: "<what it replaced, or why nothing>"}',
    'contract: {produces: "<what it must produce>"}',
    "review_by: <YYYY-MM-DD>",
    "links: {asks: [<the ask that names its owner>]}",
  ].join("\n");
  return { id, yaml };
}

/**
 * The rollover a BOUND_SESSION_GONE asks for (§7). Maestro queues nothing yet:
 * the verb and its work item are BRO-2933's, which reads this seam, so the
 * item's key is (loop id, old agent id, attempt).
 */
export function rolloverSeam(intent: LoopIntent, oldAgent: string | null, attempt = 1): { key: string; steps: string } {
  const agentOwned = intent.owner === "coordinator" || intent.owner === "fleet";
  const script = `scripts/loop_rollover.py ${intent.id} --expect-agent ${oldAgent ?? "<old agent>"}`;
  const steps = [
    "1. Check the provider login is usable and is not the one the old session died on.",
    `2. Create a fresh agent in the loop's cwd, seeded with ${intent.prompt ?? "the prompt"} and its state file.`,
    `3. It creates its own heartbeat named ${intent.id}, same cron and zone, carrying the pointer.`,
    `4. Delete the old schedule (only if it still targets ${oldAgent ?? "the old agent"}), harvest the old session's last message, archive it.`,
  ].join("\n");
  return {
    key: `${intent.id}:${oldAgent ?? "none"}:${attempt}`,
    steps: agentOwned
      ? `Roll over ${intent.id}: a Maestro-dispatched session runs ${script} (BRO-2933 queues it; until then, run it by hand).\n${steps}`
      : `Roll over ${intent.id} by hand:\n${steps}`,
  };
}

// ── Ticks (§1a) ──────────────────────────────────────────────────────────────

const ticksOf = (ticks: readonly TickEvent[], id: string) =>
  ticks.filter((tick) => tick.subject === rowSubject(id) || tick.data.loop === id);

const fireOf = (tick: TickEvent) => instant(typeof tick.data.fire === "string" ? tick.data.fire : null);

/** The started tick that answers a fire: data.fire (the loop derives it, §1a) equal to the run's slot, however late. */
function tickFor(started: readonly TickEvent[], run: LoopRun): TickEvent | null {
  const due = instant(run.scheduledFor);
  if (due === Number.NEGATIVE_INFINITY) return null;
  return started.find((tick) => fireOf(tick) === due) ?? null;
}

/** A fire whose slot is past TICK_WAIT_MS with no started tick for it: delivered, and nothing ran. */
const untickedFire = (started: readonly TickEvent[], run: LoopRun, now: number) =>
  Boolean(run.scheduledFor) && now - instant(run.scheduledFor) > TICK_WAIT_MS && !tickFor(started, run);

/** When the row's last tick that ended ok ended: an auth failure older than it was fixed. */
function lastOkEnd(ticks: readonly TickEvent[]): number {
  return Math.max(
    Number.NEGATIVE_INFINITY,
    ...ticks
      .filter((tick) => tick.type === "loop.tick.ended" && tick.data.outcome === "ok")
      .map((tick) => instant(tick.ts)),
  );
}

// ── The reconcile ────────────────────────────────────────────────────────────

interface Found {
  kind: DriftClass;
  detail: string;
  fix: string;
}

/** The drift of one row with intent; `primary` is the observation it joined, null for none. */
function rowDrift(
  intent: LoopIntent,
  primary: LoopObservation | null,
  all: readonly LoopObservation[],
  now: number,
  evidence: Evidence,
): Found[] {
  const found: Found[] = [];
  const { kind, ref } = intent.substrate;
  const id = primary && isPaseo(kind) ? primary.ref : null;
  const runs = primary?.runs ?? [];
  const bound = intent.session === "bound";
  const desired = intent.desired;

  // ORPHANED / EXPIRING: a recurring session cron, judged on its session.
  const orphan = primary ? orphaned(primary, now) : null;
  if (orphan) found.push(orphan);
  const expiry = primary ? expiring(primary, now) : null;
  if (expiry) found.push(expiry);

  if (desired === "paused" || desired === "retired") {
    const since = intent.desiredSince ? Date.parse(`${intent.desiredSince}T00:00:00Z`) : Number.NaN;
    const after = Number.isNaN(since)
      ? null
      : runs.find((run) => instant(run.at) >= since + DAY && run.status !== "missed");
    if (primary && (primary.presence === "on" || after)) {
      found.push({
        kind: "paused_but_running",
        detail:
          primary.presence === "on"
            ? `It is ${desired} in the ledger, and ${kind} will run it.`
            : `It is ${desired} in the ledger since ${intent.desiredSince}, and it ran at ${after?.at}.`,
        fix: stopCommand(kind, ref, id),
      });
    }
  }

  if (desired === "active") {
    if (!orphan && primary?.presence !== "on") {
      found.push({
        kind: "active_but_absent",
        detail: primary
          ? `It is active in the ledger, and ${kind} has it ${primary.presence === "off" ? "present but off" : "gone"}.`
          : `It is active in the ledger, and nothing on ${kind} matches ${ref}.`,
        fix: startCommand(kind, ref, id),
      });
    }
    if (primary && primary.presence === "on") {
      // A bound row's busy fires are SKIPPED_BUSY's, never FAILING's.
      const judged = bound ? runs.filter((run) => !isBusy(run)) : runs;
      const failing = bound ? judged[0]?.status === "failed" : primary.status === "failed";
      if (failing) {
        found.push({
          kind: "failing",
          detail: (bound ? judged[0]?.detail : null) ?? primary.reason,
          fix: primary.where ? `Open the log end: ${primary.where}` : "Open its last run.",
        });
      }
      if (primary.status === "missed") {
        found.push({ kind: "missed", detail: primary.reason, fix: runOnceCommand(kind, ref, id) });
      }
    }
    if (bound) {
      let busy = 0;
      while (busy < runs.length && isBusy(runs[busy] as LoopRun)) busy++;
      if (busy >= BUSY_RUN) {
        found.push({
          kind: "skipped_busy",
          detail: `Its last ${busy} fires found the bound session busy ("already has an active run").`,
          fix: `The loop has been busy for ${busy} fires; consider ${runOnceCommand(kind, ref, id)} when it is idle.`,
        });
      }
    }
    if (bound && primary) found.push(...boundDrift(intent, primary, all, now, evidence));
    if (intent.prompt && primary) found.push(...tickDrift(intent, primary, now, evidence));
    if (intent.prompt && evidence.states) {
      const state = evidence.states.get(intent.id);
      if (state && state !== "ok") {
        found.push({
          kind: "state_lost",
          detail: `Its state file notes/loops/${intent.id}/state.yaml is ${state}.`,
          fix: "Reseeded from the last tick summary; check what was lost.",
        });
      }
    }
  } else if (desired === null && primary) {
    // scope sri: read-only badges on what the substrate says.
    if (primary.status === "failed")
      found.push({ kind: "failing", detail: primary.reason, fix: "Not ours: the SRI orchestrator's." });
    if (primary.status === "missed")
      found.push({ kind: "missed", detail: primary.reason, fix: "Not ours: the SRI orchestrator's." });
  }

  if (
    intent.prompt &&
    primary?.target &&
    primary.target.prompt !== null &&
    !primary.target.prompt.includes(intent.prompt)
  ) {
    found.push({
      kind: "prompt_mismatch",
      detail: `The ${kind} prompt does not name ${intent.prompt}.`,
      fix: `Reset the prompt to the pointer: "git -C <repo> fetch -q origin main, then follow origin/main:${intent.prompt}".`,
    });
  }
  return found;
}

/**
 * The text a dead session itself produced: a failed run's error, or an output
 * that IS an API error. A healthy session's prose about someone's login
 * failure (run 6c5147fd) never counts, nor a replayed earlier message.
 */
export function ownFailure(run: LoopRun): string | null {
  const error = run.status === "failed" ? run.detail : null;
  if (authFailure(error)) return error;
  const output = run.output?.trim() ?? "";
  return output.startsWith("API Error") && authFailure(output) ? output : null;
}

/**
 * BOUND_SESSION_GONE (b), as a property contract (spec §4): judged only on
 * runs at or after the row's first started tick, and never while the row has
 * no ok tick; busy fires never count; each of the last two judged runs failed
 * or never ticked, and each carries a login failure of its own (ownFailure),
 * ended after the row's last ok tick. Returns that failure, or null.
 */
export function deadLogin(
  intent: LoopIntent,
  runs: readonly LoopRun[],
  now: number,
  ticks: readonly TickEvent[],
): string | null {
  const mine = ticksOf(ticks, intent.id);
  const started = mine.filter((tick) => tick.type === "loop.tick.started");
  const okAt = lastOkEnd(mine);
  if (started.length === 0 || okAt === Number.NEGATIVE_INFINITY) return null;
  const adopted = adoptedAt(started);
  const judged = runs
    .filter((run) => run.status !== "running" && run.status !== "missed" && !isBusy(run))
    .filter((run) => instant(run.scheduledFor ?? run.at) >= adopted)
    .slice(0, 2);
  if (judged.length < 2) return null;
  const failures = judged.map((run) => {
    const bad = run.status === "failed" || untickedFire(started, run, now);
    const own = ownFailure(run);
    return bad && own && instant(run.endedAt ?? run.at) > okAt ? own : null;
  });
  return failures.every(Boolean) ? (failures[0] as string) : null;
}

/** When a row adopted ticks: its first started tick, or that tick's fire if earlier. */
function adoptedAt(started: readonly TickEvent[]): number {
  const at = Math.min(...started.flatMap((tick) => [instant(tick.ts), fireOf(tick)].filter(Number.isFinite)));
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

function boundDrift(
  intent: LoopIntent,
  primary: LoopObservation,
  all: readonly LoopObservation[],
  now: number,
  evidence: Evidence,
): Found[] {
  const found: Found[] = [];
  const agentId = primary.target?.agentId ?? null;
  const agent = agentId ? evidence.agents?.get(agentId) : undefined;
  // (a) archived or not found; (b) the last two fires bad, and the agent's last error a login failure.
  let gone: string | null = null;
  if (agent && (!agent.found || agent.archivedAt)) {
    gone = agent.found
      ? `Its session ${short(agentId)} was archived at ${agent.archivedAt}.`
      : `Its session ${short(agentId)} is not in Paseo.`;
  } else if (agent) {
    const why = deadLogin(intent, primary.runs, now, evidence.ticks ?? []);
    if (why) gone = `Its last two fires failed or never ticked, each on a login failure: ${why}`;
  }
  if (gone) {
    const attempt =
      1 +
      ticksOf(evidence.rollovers ?? [], intent.id).filter(
        (event) => event.type === "loop.rollover.failed" && JSON.stringify(event.data).includes(agentId ?? "\0"),
      ).length;
    const seam = rolloverSeam(intent, agentId, attempt);
    found.push({ kind: "bound_session_gone", detail: gone, fix: seam.steps });
  }
  // DUPLICATE_BINDING: two live schedules under its name, both older than one rollover.
  const name = intent.substrate.ref.slice("name:".length);
  const live = all.filter((one) => isPaseo(one.kind) && one.scheduleName === name && one.presence === "on");
  if (live.length > 1) {
    const newest = Math.max(...live.map((one) => instant(one.createdAt)));
    if (newest !== Number.NEGATIVE_INFINITY && now - newest > DUPLICATE_MS) {
      const stale = live.filter((one) => one !== primary).map((one) => one.ref);
      found.push({
        kind: "duplicate_binding",
        detail: `${live.length} live schedules are named ${name}: ${live.map((one) => one.ref).join(", ")}.`,
        fix: stale.map((one) => `paseo schedule delete ${one}`).join(" && "),
      });
    }
  }
  // TARGET_CHANGED: the live target or prompt moved off the baseline with no rollover naming the change.
  const baseline = evidence.baselines?.get(intent.id);
  const current: Binding = { agentId, prompt: primary.target?.prompt ?? null };
  if (baseline) {
    // The latest loop.rollover.completed explains a target or prompt equal to its own (§7 data shape).
    const completed = ticksOf(evidence.rollovers ?? [], intent.id)
      .filter((event) => event.type === "loop.rollover.completed")
      .sort((a, b) => instant(b.ts) - instant(a.ts))[0];
    const targetMoved = baseline.agentId !== current.agentId && completed?.data.new_agent !== current.agentId;
    const promptMoved =
      baseline.prompt !== current.prompt &&
      !(completed && typeof completed.data.prompt === "string" && completed.data.prompt === current.prompt);
    if (targetMoved || promptMoved) {
      const what = targetMoved
        ? `its target moved from ${short(baseline.agentId)} to ${short(current.agentId)}`
        : "its prompt changed";
      found.push({
        kind: "target_changed",
        detail: `Outside a rollover, ${what}.`,
        fix: "Someone changed the loop outside rollover: confirm or revert.",
      });
    }
  }
  return found;
}

function tickDrift(intent: LoopIntent, primary: LoopObservation, now: number, evidence: Evidence): Found[] {
  if (!evidence.ticks) return [];
  const found: Found[] = [];
  const mine = ticksOf(evidence.ticks, intent.id);
  const started = mine.filter((tick) => tick.type === "loop.tick.started");
  const ends = new Map(mine.filter((tick) => tick.type === "loop.tick.ended").map((tick) => [tick.cause, tick]));
  // TICK_UNCLOSED, a row state: its most recent started tick has no end after the limit, measured from the start
  // (a Paseo run can end while its turn goes on). A later tick that closes clears it.
  const lengths = started.flatMap((tick) => {
    const end = ends.get(tick.id);
    return end ? [instant(end.ts) - instant(tick.ts)] : [];
  });
  const limit = Math.max(TICK_CLOSE_MS, 2 * median(lengths));
  const latest = [...started].sort((a, b) => instant(b.ts) - instant(a.ts))[0];
  if (latest && !ends.has(latest.id) && now - instant(latest.ts) > limit) {
    found.push({
      kind: "tick_unclosed",
      detail: `The tick started at ${latest.ts}${typeof latest.data.fire === "string" ? ` for the ${latest.data.fire} fire` : ""} has not ended after ${Math.round(limit / MIN)} min.`,
      fix: "Read the session's last turn; the next fire reseeds from state.",
    });
  }
  // TICK_MISSING, a row state: its most recent judged run (not failed, at or after adoption, the first started
  // tick) has no started tick for its slot TICK_WAIT_MS on. A later run that pairs, or the late tick, clears it.
  const adopted = adoptedAt(started);
  const fire = primary.runs.find(
    (run) =>
      run.status !== "failed" &&
      run.status !== "missed" &&
      run.status !== "running" &&
      run.scheduledFor &&
      instant(run.scheduledFor) >= adopted &&
      now - instant(run.scheduledFor) > TICK_WAIT_MS,
  );
  if (fire && untickedFire(started, fire, now)) {
    found.push({
      kind: "tick_missing",
      detail: `The ${fire.scheduledFor} fire was delivered (${fire.status}) and no tick started for it.`,
      fix: "Check the bound session; BOUND_SESSION_GONE follows if it repeats.",
    });
  }
  return found;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function orphaned(observation: LoopObservation, now: number): Found | null {
  const session = observation.session;
  if (observation.kind !== "session-cron" || !observation.recurring || !session || session.alive !== false) return null;
  const latest = Math.max(instant(session.lastEventAt), instant(session.endedAt));
  if (now - latest >= CRON_LIFE_MS) return null;
  return {
    kind: "orphaned",
    detail: `It died with its session ${short(session.id)}${session.endedAt ? ` at ${session.endedAt}` : ""}.`,
    fix: "Re-create in a live session or register it on a durable substrate; else dismiss.",
  };
}

function expiring(observation: LoopObservation, now: number): Found | null {
  if (observation.kind !== "session-cron" || !observation.recurring || observation.session?.alive !== true) return null;
  const expires =
    observation.expiresAt != null ? instant(observation.expiresAt) : instant(observation.createdAt) + CRON_LIFE_MS;
  if (expires === Number.NEGATIVE_INFINITY || expires - now >= EXPIRING_MS) return null;
  const at = new Date(expires).toISOString();
  return {
    kind: "expiring",
    detail: `It expires at ${at}${observation.createdAtLowerBound ? " at the latest (its creation predates the hook, so this is a lower bound)" : ""}.`,
    fix: `Re-create it before ${at}, or move it to a Paseo heartbeat.`,
  };
}

const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "none");
const rank = (kind: DriftClass) => DRIFT_CLASSES.indexOf(kind);

function drifts(found: Found[], needs: (kind: DriftClass) => boolean): LoopDrift[] {
  const seen = new Set<DriftClass>();
  return found
    .filter((one) => !seen.has(one.kind) && seen.add(one.kind))
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map((one) => ({ ...one, needsYou: needs(one.kind) }));
}

/** Every loop: one row per ledger row, then one per observation no row claims. */
export function reconcile(
  intents: readonly LoopIntent[],
  observations: readonly LoopObservation[],
  now: number,
  evidence: Evidence = {},
): LoopRow[] {
  const used = new Set<LoopObservation>();
  const rows: LoopRow[] = [];
  for (const intent of intents) {
    const mine = claimed(intent, observations);
    for (const one of mine) used.add(one);
    const primary = mine[0] ?? null;
    const unread = evidence.unread?.has(intent.substrate.kind) ?? false;
    const found = unread ? [] : rowDrift(intent, primary, observations, now, evidence);
    const sri = intent.scope === "sri";
    rows.push({
      subject: rowSubject(intent.id),
      id: intent.id,
      name: intent.title,
      kind: intent.substrate.kind,
      ref: intent.substrate.ref,
      scope: intent.scope,
      owner: intent.owner,
      purpose: intent.purpose,
      desired: intent.desired,
      section: "loops",
      intent,
      observed: primary,
      unread,
      drift: drifts(
        found,
        (kind) => !sri && !((kind === "failing" || kind === "missed") && TIMELINE_RAISES[intent.substrate.kind]),
      ),
    });
  }
  for (const observation of observations) {
    if (used.has(observation)) continue;
    const found: Found[] = [];
    const orphan = orphaned(observation, now);
    if (orphan) found.push(orphan);
    const expiry = expiring(observation, now);
    if (expiry) found.push(expiry);
    if (!observation.ephemeral && observation.scope === "broomva" && observation.presence !== "gone") {
      const stub = rowStub(observation);
      found.push({
        kind: "unregistered",
        detail: `${observation.kind} runs ${observation.ref} and no ledger row claims it.`,
        fix: `Add .broomva/loops/${stub.id}.yaml: owner, purpose, desired, retires.\n${stub.yaml}`,
      });
    }
    rows.push({
      subject: observation.subject,
      id: null,
      name: observation.name,
      kind: observation.kind,
      ref: observation.ref,
      scope: observation.scope,
      owner: null,
      purpose: null,
      desired: null,
      section: observation.ephemeral ? "ephemeral" : "loops",
      intent: null,
      observed: observation,
      unread: false,
      // An unclaimed ephemeral's own trouble is a badge: one /loop per session would flood Needs you.
      drift: drifts(found, (kind) => kind === "unregistered"),
    });
  }
  return rows;
}

/** What needs you from the loops (spec §6 loopNeeds()): each drift a row raises, with its pinned fix. */
export function loopNeeds(rows: readonly LoopRow[]): LoopNotice[] {
  return rows.flatMap((row) =>
    row.drift
      .filter((drift) => drift.needsYou)
      .map((drift) => ({
        id: `${row.subject}#${drift.kind}`,
        subject: row.subject,
        loop: row.id ?? row.name,
        kind: drift.kind,
        detail: drift.detail,
        fix: drift.fix,
      })),
  );
}

/** The bindings to keep as the next read's baselines: a row with TARGET_CHANGED keeps its old one until it is answered. */
export function nextBaselines(rows: readonly LoopRow[], previous: ReadonlyMap<string, Binding>): Map<string, Binding> {
  const next = new Map<string, Binding>();
  for (const row of rows) {
    if (!row.id || row.intent?.session !== "bound" || !row.observed?.target) continue;
    const kept = previous.get(row.id);
    next.set(
      row.id,
      kept && row.drift.some((drift) => drift.kind === "target_changed")
        ? kept
        : { agentId: row.observed.target.agentId, prompt: row.observed.target.prompt },
    );
  }
  return next;
}

// ── Transitions (drift.jsonl) ────────────────────────────────────────────────

export interface Transition {
  type: "loop.drift.detected" | "loop.drift.cleared";
  subject: string;
  kind: DriftClass;
  detail: string;
}

/** `<subject>#<class>` → the detail it was detected with: the drift that is open now. */
export type OpenDrift = Map<string, { subject: string; kind: DriftClass; detail: string }>;

/**
 * The transitions from what was open to what the rows hold now; only
 * transitions, never a line per read. A row that could not be read keeps
 * what it had open: an unread substrate clears nothing.
 */
export function transitions(open: OpenDrift, rows: readonly LoopRow[]): { lines: Transition[]; open: OpenDrift } {
  const now: OpenDrift = new Map();
  const keep = new Set(rows.filter((row) => row.unread).map((row) => row.subject));
  for (const row of rows) {
    for (const drift of row.drift)
      now.set(`${row.subject}#${drift.kind}`, { subject: row.subject, kind: drift.kind, detail: drift.detail });
  }
  for (const [key, value] of open) if (keep.has(value.subject) && !now.has(key)) now.set(key, value);
  const lines: Transition[] = [];
  for (const [key, value] of now) if (!open.has(key)) lines.push({ type: "loop.drift.detected", ...value });
  for (const [key, value] of open) if (!now.has(key)) lines.push({ type: "loop.drift.cleared", ...value });
  return { lines, open: now };
}

/** What drift.jsonl's lines leave open: each (subject, class) whose last line is a detection. */
export function openFrom(
  lines: readonly { type: string; subject: string; data: Record<string, unknown> }[],
): OpenDrift {
  const open: OpenDrift = new Map();
  for (const line of lines) {
    const kind = line.data.kind;
    if (typeof kind !== "string" || !DRIFT_CLASSES.includes(kind as DriftClass)) continue;
    const key = `${line.subject}#${kind}`;
    if (line.type === "loop.drift.detected") {
      open.set(key, { subject: line.subject, kind: kind as DriftClass, detail: String(line.data.detail ?? "") });
    } else if (line.type === "loop.drift.cleared") open.delete(key);
  }
  return open;
}

export { driftName };
