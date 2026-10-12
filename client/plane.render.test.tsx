// Render tests: the real surface components, mounted with react-dom through
// react-native-web in a happy-dom window, the way Paseo's web and desktop
// builds run them. The setup block below must run before anything imports
// React DOM, so everything past it is imported dynamically. It does three
// things: puts happy-dom's window on globalThis (react-dom and react-native-web
// read it at import) with 16 ms animation frames (happy-dom runs them back to
// back, which starves act) and a matchMedia whose reduced-motion answer
// `setReduced` flips live. Motion starts reduced, so the running dot's frames
// cannot land between act scopes; the live-signal tests turn it on; mocks `react-native` as react-native-web (loaded once outside
// NODE_ENV=test, where it would swap Animated for a mock that never moves); and mocks
// `@getpaseo/plugin/client/react-native`, the kit the host substitutes at
// runtime, with plain react-native-web parts. `mount(node, { state })` wraps a
// node in the providers a surface gets (query client, Paseo API, an RPC
// `invoke` backed by the `items` fixture; the client-state source only when
// `state` is given) and returns helpers to read text, find by aria-label, press
// and re-render. To test another component, import it after the setup block
// and pass it to mount(). console.error is captured: the ChangeScope probe's
// error is counted, anything else fails the test.
//
// Teardown has to hold when a test times out, which a loaded machine makes
// likely (the first mount compiles react-dom and react-native-web): bun moves
// on while the timed-out test keeps running. So every harness step is owned by
// the test that started it and refuses once that test has ended, afterEach
// waits for the step still in flight before unmounting, a surface is recorded
// for unmounting before it renders, and afterAll unmounts anything left,
// clears the intent listeners, and restores the spies, the kit mock and the
// globals. A surface left mounted would take the next file's intents.

import { afterAll, afterEach, describe, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import { Window } from "happy-dom";
import type { ComponentProps, ReactNode } from "react";
import type { AnswersLanding } from "../shared/answers";
import type { MaestroConfig, Scoreboard, WakeEntry, WorkItem } from "../shared/contracts";
import {
  type AskSession,
  type DecisionAsk,
  type FleetNotice,
  type FleetProposal,
  type FleetSession,
  type FleetView,
  groupProposals,
} from "../shared/fleet";
import type { Initiative, InitiativesView } from "../shared/initiatives";
import type { LoopNotice, LoopRow, LoopsView } from "../shared/loops";
import type { NeedKind } from "../shared/needs";
import type { HistoryEvent } from "../shared/records";
import { groupOf, type OrchState } from "../shared/states";
import type { TimelineNotice, TimelineRun, TimelineSource, TimelineView } from "../shared/timeline";

// A cold first mount alone can pass bun's 5 s default under load; that is not a failure of the surface.
setDefaultTimeout(60_000);

const win = new Window({ url: "http://localhost/" });
let reduced = true;
const motionListeners = new Set<(event: { matches: boolean }) => void>();
Object.assign(win, {
  matchMedia: (query: string) => ({
    media: query,
    get matches() {
      return reduced && query.includes("reduce");
    },
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => motionListeners.add(fn),
    removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) => motionListeners.delete(fn),
  }),
});
const added: string[] = [];
for (const key of [...Object.getOwnPropertyNames(win), "window", "document", "navigator"]) {
  if (key in globalThis && key !== "window" && key !== "document" && key !== "navigator") continue;
  (globalThis as Record<string, unknown>)[key] =
    key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
  added.push(key);
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (frame: (now: number) => void) => setTimeout(() => frame(performance.now()), 16),
  cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
});
const web = (() => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  const module = require("react-native-web");
  void module.Animated;
  process.env.NODE_ENV = env;
  return module;
})();
// react-native itself cannot load under bun (its source is Flow), so it has no original to go
// back to: it stays on react-native-web, the shim every render file maps it to.
mock.module("react-native", () => web);
const KIT = "@getpaseo/plugin/client/react-native";
// The kit as the package ships it, read under a key of its own: loading it by name before the
// mock would bind every later import to the empty original.
const realKit = { ...(await import(`${Bun.resolveSync(KIT, import.meta.dir)}?original`)) };
mock.module(KIT, () => {
  return {
    ScrollView: web.ScrollView,
    FlatList: web.FlatList,
    TextInput: web.TextInput,
    Icon: () => null,
    Modal: Object.assign(({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null), {
      Content: ({ children }: { children: ReactNode }) => children,
    }),
    useToast: () => ({
      show: (message: string) => void toasts.push(message),
      error: (message: string) => void toasts.push(message),
    }),
    useRevealedText: (text: string) => text,
  };
});

// Settings' kit (SettingsSection, SettingsSelect, ...) is the host's at runtime too: plain parts here, a
// select as one button per option, restored in afterAll like the kit above.
const UI = "@getpaseo/plugin/client/ui";
const realUi = { ...(await import(`${Bun.resolveSync(UI, import.meta.dir)}?original`)) };
mock.module(UI, () => {
  const { Pressable, Text, View } = web as typeof import("react-native");
  type Row = { label: string; hint?: string; children?: ReactNode };
  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <View>
      <Text>{title}</Text>
      {children}
    </View>
  );
  return {
    SettingsSection: Section,
    SettingsGroup: Section,
    SettingsCard: ({ children }: { children: ReactNode }) => <View>{children}</View>,
    SettingsRow: ({ label, children }: Row) => (
      <View>
        <Text>{label}</Text>
        {children}
      </View>
    ),
    SettingsInput: ({ label }: Row) => <Text>{label}</Text>,
    SettingsSwitch: ({ label }: Row) => <Text>{label}</Text>,
    SettingsSelect: ({
      label,
      hint,
      value,
      options,
      onValueChange,
    }: Row & { value: string; options: { label: string; value: string }[]; onValueChange(value: string): void }) => (
      <View>
        <Text>{label}</Text>
        {hint ? <Text>{hint}</Text> : null}
        {options.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            {...{ "aria-pressed": option.value === value }}
            accessibilityLabel={`${label}: ${option.label}`}
            onPress={() => onValueChange(option.value)}
          >
            <Text>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    ),
    SettingsAction: ({
      label,
      actionLabel,
      onPress,
      disabled,
    }: Row & { actionLabel: string; onPress(): void; disabled?: boolean }) => (
      <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}>
        <Text>{actionLabel}</Text>
      </Pressable>
    ),
  };
});

const { act } = await import("react");
const { createRoot } = require("react-dom/client") as {
  createRoot(container: unknown): { render(node: ReactNode): void; unmount(): void };
};
const { QueryClient, QueryClientProvider, notifyManager } = await import("@tanstack/react-query");
// Queries here refetch on an interval (4 s for the work reads), and under load a test outlives one:
// the refetch's answer then updates a component outside any act scope (FilesSection's files read
// failed three CI runs that way, and 10 of 12 local runs under parallel load). Every update React
// Query delivers goes through act instead, as TanStack's testing notes advise; afterAll restores it.
notifyManager.setNotifyFunction((notify) => {
  act(notify);
});
const { PaseoApiProvider, PluginClientStateProvider, PluginRpcProvider } = await import("@getpaseo/plugin/client/host");
const { MaestroSurface } = await import("./plane");
const { WorkDetail } = await import("./detail");
const { createGateCard } = await import("./gate-card");
const { createWorkPanel } = await import("./agent-panel");
const { requestIntent, resetIntents, takeIntent } = await import("./intent");
const { MaestroSettings } = await import("./settings");
const { handledOf, needsOf } = await import("../server/needs");
const { answersStatus } = await import("../server/answers-status");
const { noticesOf } = await import("../server/notices");
const { askHoldKey } = await import("../shared/needs");
const { needsYouOf } = await import("../shared/needs-you");
const { headerFace } = await import("./header-count");
const { onNeeds, publishNeeds, readTicket, resetNeedsBus } = await import("./needs-bus");
const { linkSettings } = await import("./settings-link");
const { LOOP_HINT: LOOP_SETTINGS_HINT } = await import("./loop-model");
const { focusRing } = await import("./ui");

function setReduced(value: boolean) {
  reduced = value;
  for (const listener of motionListeners) listener({ matches: value });
}

function work(id: string, state: OrchState, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    path: `/work/${id}`,
    title: `Work ${id}`,
    kind: "task",
    state,
    group: groupOf(state),
    gate: "human",
    owner: null,
    initiative: null,
    project: null,
    repo: null,
    createdAt: "2026-09-29T10:00:00Z",
    updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    lastEventAt: null,
    phase: null,
    worker: null,
    reason: null,
    verdict: null,
    look: null,
    // Work at the gate holds a prompt unless a test says it finished (`permission: null`): only a held action needs you (A1).
    permission: state === "review" ? { requestId: `req-${id}`, title: "Run a command", detail: "git push" } : null,
    checks: [],
    pending: null,
    flag: null,
    ...extra,
  };
}
const worker = (id: string, branch: string | null) => ({
  agentId: `ag-${id}`,
  workspaceId: `ws-${id}`,
  provider: "claude",
  branch,
  cwd: "/src",
});
const look = { ran: "Ran on its own", decided: [], ask: "Approve the branch" };
const fixture = (): WorkItem[] => [
  work("a", "review", { initiative: "hawthorne", project: "core", worker: worker("a", "maestro/a-1"), look }),
  work("b", "blocked", { initiative: "hawthorne", worker: worker("b", null), reason: "Needs a Linear scope" }),
  work("c", "running", { initiative: "genesis", worker: worker("c", "maestro/c-1"), phase: "working" }),
  work("d", "proposed", { initiative: "hawthorne" }),
  work("f", "done", { initiative: "genesis" }),
  work("g", "review", { worker: worker("g", null), look }),
];
/** The fixture with some work finished at the gate (nothing held), as an older run that ended without asking. */
const finished = (...ids: string[]): WorkItem[] =>
  fixture().map((item) => (ids.includes(item.id) ? { ...item, permission: null } : item));
let items = fixture();

// Work fleet-reconcile raised, as the producer writes it (BRO-2839): an old count title, its brief for the run.
const FLEET_ITEM = work("fleet-1", "review", {
  title: "1 ask (tick 7) [fleet-reconcile sri batch 7-3]",
  initiative: "fleet-reconcile-sri",
  project: "maestro-asks",
  look: { ran: "1m unsupervised · 1 turn · ran to the gate", decided: ["nothing"], ask: "Approve to close" },
  display: {
    title: "The core comparison (ctx doctor --compare) is not run in scope sri…",
    fleet: { scope: "sri", what: "batch 7-3", tick: "7" },
  },
});
const FLEET_TURN = (minutesAgo: number) => ({
  ts: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  type: "turn.ended",
  actor: "agent" as const,
  text: "Turn finished",
  detail: "Yes, there are two now.",
});
// The contract's shape (fleet-reconcile paseo_ask.brief, BRO-2840): For you with a verbs line, then For the run.
const FLEET_DETAIL = {
  item: FLEET_ITEM,
  brief: [
    "## For you",
    "",
    "The fleet has 1 question for you from scope sri (tick 7). In a terminal, `fleet asks --scope sri` lists them too.",
    "",
    "```text",
    "- [a1] (observe) The core comparison (ctx doctor --compare) is not run in scope sri: move it aside, then register.",
    "```",
    "",
    "Approve acknowledges them · Send back answers with your note (the fleet reads it at its next tick) · Cancel dismisses them.",
    "",
    "## For the run",
    "",
    "Change nothing and run no tools. End your turn at once with exactly two sections.",
  ].join("\n"),
  events: [FLEET_TURN(180), FLEET_TURN(120), FLEET_TURN(60)],
  checkResults: [],
};

// Local times around today's midnight, so each lands in the day its test says wherever it runs.
const midnight = new Date();
midnight.setHours(0, 0, 0, 0);
const local = (dayOffset: number, hour: number, minute = 0) => {
  const at = new Date(midnight);
  at.setDate(at.getDate() + dayOffset);
  at.setHours(hour, minute);
  return at;
};
const keyOf = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
const historyEvent = (itemId: string, at: Date, actor: HistoryEvent["actor"], text: string): HistoryEvent => {
  const item = fixture().find((entry) => entry.id === itemId);
  return {
    ts: at.toISOString(),
    type: "note",
    actor,
    text,
    detail: null,
    itemId,
    title: item?.title ?? itemId,
    initiative: item?.initiative ?? null,
    project: item?.project ?? null,
  };
};
const history = (): HistoryEvent[] => [
  historyEvent("a", local(0, 0, 2), "human", "You approved"),
  historyEvent("c", local(0, 0, 1), "agent", "Turn finished"),
  historyEvent("b", local(-1, 22), "maestro", "Checks failed"),
];
const H = 3_600_000;
const board = (): Scoreboard => ({
  unsupervisedMs: 1.25 * H,
  looks: 1,
  longestRunMs: H,
  live: false,
  segments: [],
  notches: [],
  week: [0, 1, 4, 0, 0.5, 2, 1.25].map((hours, index) => ({
    date: keyOf(local(index - 6, 12)),
    unsupervisedMs: hours * H,
    looks: index === 6 ? 1 : 0,
    longestRunMs: 0,
  })),
  weekByInitiative: [
    { initiative: "hawthorne", unsupervisedMs: 6 * H },
    { initiative: null, unsupervisedMs: 2.75 * H },
  ],
});
const files = [
  { name: "_work.md", size: 412, mtime: new Date(Date.now() - 5 * 60_000).toISOString() },
  { name: "image.png", size: 2048, mtime: new Date(Date.now() - 5 * 60_000).toISOString() },
  { name: "run.log", size: 90_000, mtime: new Date(Date.now() - 5 * 60_000).toISOString() },
];
/** One wake as the log keeps it, `minutesAgo` before now. */
const wakeEntry = (tickId: string, minutesAgo: number, extra: Partial<WakeEntry> = {}): WakeEntry => ({
  tickId,
  cause: "timer",
  wokeAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  dispatched: [],
  deferred: [],
  needsYou: { gate: 0, stuck: 0, asking: 0 },
  quiet: [],
  unasked: [],
  flagged: [],
  cleared: [],
  narrative: ["Woke on a scheduled check.", "Did nothing new this tick."],
  ...extra,
});
const loopOff = () => ({
  minutes: null as number | null,
  nextAt: null as string | null,
  ticking: false,
  recent: [] as WakeEntry[],
});
let loopState = loopOff();
/** What loop.wake answers next. */
/** What waits in the ledger (verbs.list), as approval.decide leaves it for 8 s. */
let pendingVerbs: Array<{
  receipt: string;
  verb: string;
  key: string;
  label: string;
  at: string;
  appliesAt: string;
  remainingMs: number;
}> = [];
let nextWake: () => WakeEntry = () => wakeEntry("w-now", 0, { cause: "manual" });
const settingsFixture = (): MaestroConfig => ({
  workRoot: "/work",
  provider: "claude/haiku",
  modeId: "acceptEdits",
  isolation: "worktree",
  concurrencyCap: 3,
  archiveOnApprove: true,
  defaultGate: "auto",
  loopMinutes: null,
});
let settings = settingsFixture();
/** What work.stop refuses with when it is not told to discard, as the host does for a worktree with uncommitted work. */
let stopRefusal: string | null = null;
/** While set, work.stop answers only once it resolves: a Stop still in flight. */
let stopHeld: Promise<void> | null = null;
/** The fleet as fleet.get answers: broomva missed its tick, sri runs only by hand. */
const fleetProposals = (): FleetProposal[] => [
  {
    key: "session:de2dd335:4:aaaa1111",
    source: "report",
    tick: 35,
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    action: "report",
    session: {
      id: "de2dd335-x",
      short: "de2dd335",
      name: "sri-sti-2761-rce",
      kind: "background",
      status: "failed",
      cwd: "~",
      branch: null,
      agentId: null,
    },
    classId: "4",
    className: "error",
    evidence: "listing: state failed",
    verb: null,
    review: null,
  },
  {
    key: "session:5dd4ed18:10:bbbb2222",
    source: "report",
    tick: 35,
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    action: "report only",
    session: {
      id: "5dd4ed18-x",
      short: "5dd4ed18",
      name: "worried-walrus",
      kind: "interactive",
      status: "idle",
      cwd: "~",
      branch: null,
      agentId: null,
    },
    classId: "10",
    className: "unmanaged",
    evidence: "no fleet key, not adopted (Paseo agent)",
    verb: null,
    review: { verdict: "accept", note: null, at: new Date(Date.now() - 60 * 60_000).toISOString(), tick: 34 },
  },
];
const FLEET_REPORT =
  "# fleet-reconcile · broomva · tick 35\n\nReport only (phase 1).\n\n## Classes\n\n| # | class | sessions |\n|---|---|---|\n| 1 | out of scope | 53 |\n| 4 | error | 1 |\n";
let fleetNotices: FleetNotice[] = [];
/** While set, broomva's tick is on time: no health card, only what the fleet raised (BRO-2908). */
let broomvaOnTime = false;
/** While set, fleet.get answers only once it resolves: a refetch still on its way. */
let fleetHeld: Promise<void> | null = null;
/** While set, fleet.get for this scope fails: a scope that cannot be read. */
let fleetFails: string | null = null;
/** Sessions added to broomva's roster by a test. */
let rosterExtra: FleetSession[] = [];
/** Fields of broomva's ask a1 a test changes. */
let askOverride: Record<string, unknown> = {};
/** sri: one class and one action across three sessions, which is one decision. */
let sriProposals: FleetProposal[] = [];
const sriFixture = (): FleetProposal[] =>
  ["aaaa1111", "bbbb2222", "cccc3333", "dddd4444"].map((short) => ({
    key: `session:${short}:10:feedface`,
    source: "report" as const,
    tick: 6,
    at: null,
    action: "report only",
    session: {
      id: `${short}-x`,
      short,
      name: `sri-${short}`,
      kind: "background",
      status: "done",
      cwd: "~",
      branch: null,
      agentId: null,
    },
    classId: "10",
    className: "unmanaged",
    evidence: "no fleet key, not adopted",
    verb: null,
    review: null,
  }));
let proposalsNow = fleetProposals();
// sri's proposals from the first test on, not only after the first reset.
sriProposals = sriFixture();
/** A decision ask in broomva's ask root, shaped like maestro-paseo-gaps.yaml's A10. */
const decisionFixture = (): DecisionAsk => ({
  ledger: "maestro-paseo-gaps.yaml",
  uid: null,
  id: "A10",
  hash: "0123456789abcdef",
  arc: "maestro-paseo-gaps",
  headline: "Four small review follow-ups from #7 and #8: ticket them, or drop them?",
  question: "Four review follow-ups are open and unscheduled: file or drop?",
  stakes: "None blocks a lane; untracked, a test gap stays invisible.",
  whyYou: "Scheduling is yours.",
  options: [
    {
      id: "ticket-all",
      label: "File all four",
      consequence: "Each becomes a Linear issue.",
      reversible: true,
      recommended: true,
    },
    {
      id: "drop",
      label: "Drop all four",
      consequence: "They stay in this ledger.",
      reversible: false,
      recommended: false,
    },
  ],
  fallback: "file all four once Linear is signed in",
  blocking: false,
  askedAt: new Date(Date.now() - 2 * H).toISOString(),
  answeredAt: null,
  answer: null,
  answerOption: null,
  state: "open",
  origin: { agentId: "agent-asker", cwd: "~/broomva" },
  refusal: null,
  home: { kind: "root", path: "/state/broomva/.control/asks", branch: null },
  batched: false,
  waiting: false,
});
/** The fleet's decision asks now: none unless a test puts one there. */
let decisionsNow: DecisionAsk[] = [];
/** The workspace's asks (asks.workspace) now: none unless a test puts some there. */
let workspaceNow: DecisionAsk[] = [];
/** While set, asks.workspace fails with it. */
let workspaceFail: string | null = null;
/** While set, ask.answer answers only once it resolves: a reply still on its way. */
let answerHeld: Promise<void> | null = null;
/** While set, ask.answer fails with it (after any hold). */
/** While set, ask.answer queues the answer for its undo window (B4): the ask stays open and a receipt comes back. */
let answerQueued = false;
let answerFail: string | null = null;
/** The answers batch as the last wake left it: none unless a test says. */
let landingNow: AnswersLanding | null = null;
/** While set, needs.list fails with it. */
let needsFail: string | null = null;
let workFail: string | null = null;
/** Loop drift work.attention says needs you: none unless a test says. */
let loopNoticesNow: LoopNotice[] = [];
/** The Loops tab's read (loops.get): two standing rows, one drifting, and a p9 watcher. */
const loopRow = (extra: Partial<LoopRow>): LoopRow => ({
  subject: "loop:kg-lint",
  id: "kg-lint",
  name: "Knowledge-graph weekly lint",
  kind: "launchd",
  ref: "com.broomva.kg-lint",
  scope: "broomva",
  owner: "owner",
  purpose: "Lint every entity page.",
  desired: "paused",
  section: "loops",
  intent: null,
  observed: null,
  unread: false,
  drift: [],
  ...extra,
});
const loopsView = (): LoopsView => ({
  now: "2026-10-08T16:00:00.000Z",
  ledger: { repo: "/Users/me/broomva", sha: "4c744b7071", path: "origin/main:.broomva/loops" },
  rows: [
    loopRow({
      observed: {
        subject: "loop:launchd/com.broomva.kg-lint",
        kind: "launchd",
        ref: "com.broomva.kg-lint",
        name: "kg-lint",
        scope: "broomva",
        presence: "on",
        status: "ok",
        reason: "On schedule.",
        since: null,
        cadence: "Sundays at 02:30",
        next: null,
        last: null,
        runs: [],
        ephemeral: false,
        where: "/tmp/kg-lint.log",
      },
      drift: [
        {
          kind: "paused_but_running",
          detail: "It is paused in the ledger, and launchd will run it.",
          fix: "launchctl bootout gui/$UID/com.broomva.kg-lint && launchctl disable gui/$UID/com.broomva.kg-lint",
          needsYou: true,
        },
      ],
    }),
    loopRow({
      subject: "loop:maestro-wake",
      id: "maestro-wake",
      name: "Maestro loop wake",
      kind: "maestro-loop",
      ref: "wake",
      desired: "active",
      purpose: "Every 30 min, Maestro wakes.",
    }),
    loopRow({
      subject: "loop:p9/w1",
      id: null,
      name: "p9 PR #11 broomva/skene",
      kind: "p9",
      ref: "w1",
      owner: null,
      purpose: null,
      desired: null,
      section: "ephemeral",
    }),
  ],
  ledgerErrors: [{ file: ".broomva/loops/bad.yaml", error: "unknown key colour" }],
  warnings: [],
});
/** The session broomva's ask a1 is about: none unless a test says. */
let askSessionNow: AskSession | null = null;
/** Paseo sessions the surface asked the host to open. */
let opened: string[] = [];
/** An idea-triage ask in ideas-mod-anything.yaml, as workspace#894 files them. */
const ideaFixture = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ...decisionFixture(),
  ledger: "ideas-mod-anything.yaml",
  id,
  hash: `hash-${id}`,
  arc: "ideas-mod-anything",
  headline: `Build idea ${id}, or park it?`,
  question: `Develop, park or kill idea ${id}?`,
  stakes: "Nothing is blocked.",
  whyYou: "Your call.",
  options: [
    { id: "develop", label: "Develop", consequence: "A queued work item.", reversible: true, recommended: false },
    {
      id: "park",
      label: "Park until 2099-01-10",
      consequence: "Back on the wake date.",
      reversible: true,
      recommended: true,
    },
    { id: "kill", label: "Kill", consequence: "Closed.", reversible: true, recommended: false },
  ],
  fallback: "park until 2099-01-10",
  origin: null,
  home: { kind: "main", path: "/Users/me/broomva", branch: null },
  idea: {
    initiative: "mod-anything",
    idea: `The idea ${id} in one line`,
    source: { kind: "report", ref: "docs/reports/beyond-games.html" },
    evidence: "BRO-2810",
    wake: "2099-01-10",
  },
  ...extra,
});
const initiativeFixture = (id: string, extra: Partial<Initiative> = {}): Initiative => ({
  id,
  file: `${id}.yaml`,
  home: { kind: "main", path: "/Users/me/broomva", branch: null },
  error: null,
  title: `Initiative ${id}`,
  quote: null,
  intentSource: null,
  summary: null,
  status: "active",
  stated: "2026-10-01",
  reviewBy: "2099-01-01",
  wake: null,
  nextAction: `Next for ${id}`,
  driver: "owner",
  waitingOn: [],
  linear: [],
  prs: [],
  repos: [],
  sessions: [],
  asks: [],
  exit: "Done.",
  closedAt: null,
  outcome: null,
  stale: null,
  local: [],
  ideas: { open: 0, triaged: 0 },
  ...extra,
});
const initiativesFixture = (): InitiativesView => ({
  controlRepo: "/Users/me/broomva",
  today: "2026-10-05",
  initiatives: [
    initiativeFixture("broken", { error: "broken.yaml: it has a YAML error: Map keys must be unique.", title: null }),
    initiativeFixture("mod-anything", {
      title: "mod-anything skill",
      status: "blocked_on_owner",
      reviewBy: "2026-10-01",
      stale: { kind: "overdue", date: "2026-10-01" },
      driver: "coordinator:f5307ce7",
      waitingOn: [
        {
          kind: "ask",
          ref: "maestro-paseo-gaps.yaml#A10",
          note: null,
          ledger: "maestro-paseo-gaps.yaml",
          askId: "A10",
        },
        { kind: "owner-step", ref: "pick a path on the P20 stop", note: null, ledger: null, askId: null },
        { kind: "pr", ref: "broomva/skills#267", note: null, ledger: null, askId: null },
      ],
      linear: ["BRO-2808"],
      prs: [{ ref: "broomva/skills#267", url: "https://github.com/broomva/skills/pull/267", state: "open" }],
      sessions: [
        { id: "445aac2a", agentId: "445aac2a-full-agent-id" },
        { id: "deadbeef", agentId: null },
      ],
      local: [
        {
          path: "/Users/me/wt/park-mods",
          branch: "feat/park",
          fields: ["status", "wake"],
          status: "parked",
          nextAction: null,
        },
      ],
      ideas: { open: 2, triaged: 1 },
    }),
    initiativeFixture("fleet-autonomy", {
      title: "Fleet autonomy",
      quote: "the work we start get forgotten",
      intentSource: "owner, 2026-10-03",
    }),
  ],
  ideas: [
    ideaFixture("I1"),
    ideaFixture("I2"),
    ideaFixture("I3", {
      state: "answered",
      answerOption: "develop",
      answer: "Develop: already in progress.",
      answeredAt: "2026-10-05T13:34:21Z",
    }),
  ],
  warnings: [],
});
let initiativesNow = initiativesFixture();
/** The initiatives whose review is due, as initiatives.reviews() reads them: none unless a test says. */
let reviewsNow: Initiative[] = [];
/** While set, initiatives.list fails with it. */
let initiativesFail: string | null = null;
/** URLs the surface asked the host to open. */
const urls: string[] = [];
/** What the toast was asked to say, in order. */
const toasts: string[] = [];
spyOn(web.Linking, "openURL").mockImplementation(async (url: string) => {
  urls.push(url);
});
/** Whether the timeline carries runs that open something: a schedule's, and the fleet's ticks. */
let timelineRuns = false;
const fleetView = (scope: string | undefined): FleetView => {
  const missed = {
    status: "missed" as const,
    reason: "No tick for 3h: the last was tick 35. It runs every hour.",
    notice: "No tick since tick 35. It runs every hour.",
    since: new Date(Date.now() - 3 * H).toISOString(),
    item: null,
    needsYou: true,
  };
  const scopes = [
    {
      id: "broomva",
      mode: "report",
      dryRun: true,
      health: broomvaOnTime ? { ...missed, status: "ok" as const, reason: "", needsYou: false } : missed,
      lastTick: { tick: 35, at: new Date(Date.now() - 3 * H).toISOString(), status: "ok" as const },
      unreviewed: proposalsNow.filter((entry) => entry.review === null).length,
      openAsks: 1,
    },
    {
      id: "sri",
      mode: "report",
      dryRun: true,
      health: {
        status: "unscheduled" as const,
        reason: "Not scheduled: no LaunchAgent runs it.",
        notice: "Not scheduled: no LaunchAgent runs it.",
        since: null,
        item: null,
        needsYou: false,
      },
      lastTick: { tick: 6, at: new Date(Date.now() - 40 * H).toISOString(), status: "ok" as const },
      unreviewed: groupProposals(sriProposals).filter((group) => group.review === null).length,
      openAsks: 0,
    },
  ];
  const id = scope ?? "broomva";
  return {
    scopes,
    error: null,
    detail: {
      id,
      stateDir: `/state/${id}`,
      schedule: { scheduled: id === "broomva", intervalMinutes: id === "broomva" ? 60 : null },
      ticks: [
        {
          tick: id === "broomva" ? 35 : 6,
          at: new Date(Date.now() - 3 * H).toISOString(),
          finishedAt: null,
          status: "ok",
          exit: 0,
          steps: "recover=0 observe=0",
          failedStep: null,
          dryRun: true,
          mode: "report",
          classCounts: [
            { id: "1", name: "out of scope", count: 53 },
            { id: "4", name: "error", count: 1 },
          ],
          openAsks: 1,
          proposals: 2,
        },
        {
          tick: 34,
          at: new Date(Date.now() - 4 * H).toISOString(),
          finishedAt: null,
          status: "failed",
          exit: 1,
          steps: "recover=0 observe=1",
          failedStep: "observe",
          dryRun: true,
          mode: "report",
          classCounts: null,
          openAsks: null,
          proposals: null,
        },
      ],
      report: id === "broomva" ? { tick: 35, markdown: FLEET_REPORT, truncated: false } : null,
      proposals: id === "broomva" ? proposalsNow : sriProposals,
      asks:
        id === "broomva"
          ? [
              {
                id: "a1",
                key: "records-without-process",
                question: "13 Paseo records are not archived and have no live process.",
                class: "count",
                className: null,
                firstTick: 2,
                session: askSessionNow,
                batch: "2-1",
                item: { id: "a", title: "Work a", state: "review", group: "review", needsYou: true },
                ...askOverride,
              },
            ]
          : [],
      decisions: id === "broomva" ? decisionsNow : [],
      askRoot: `/state/${id}/.control/asks`,
      alerts: [],
      warnings: [],
      roster: {
        tick: id === "broomva" ? 35 : 6,
        at: new Date(Date.now() - 3 * H).toISOString(),
        sessions: rosterOf(id),
      },
      stepWords: id === "broomva" ? { tick: 35, said: { recover: "0 open intent(s) closed" } } : null,
    },
  };
};
/** The newest report's sessions: each proposal's, a running Paseo agent, and one out of scope. */
const rosterOf = (id: string): FleetSession[] => {
  const history = (classId: string) => [
    { tick: 35, classId },
    { tick: 34, classId: null },
  ];
  const fromProposals = (id === "broomva" ? proposalsNow : sriProposals).flatMap((proposal) =>
    proposal.session
      ? [
          {
            id: proposal.session.id,
            short: proposal.session.short,
            name: proposal.session.name,
            kind: proposal.session.kind,
            state: proposal.session.status,
            cwd: proposal.session.cwd,
            branch: proposal.session.branch,
            agentId: proposal.session.agentId,
            classId: proposal.classId ?? "unknown",
            className: proposal.className,
            action: proposal.action,
            evidence: proposal.evidence,
            activeAt: new Date(Date.now() - 2 * H).toISOString(),
            scope: id,
            placement: "cwd",
            inScope: true,
            history: history(proposal.classId ?? "unknown"),
          },
        ]
      : [],
  );
  if (id !== "broomva") return fromProposals;
  return [
    ...fromProposals,
    ...rosterExtra,
    {
      id: "db279ca1-x",
      short: "db279ca1",
      name: "hanging-pug",
      kind: "interactive",
      state: "busy",
      cwd: "~/.paseo/worktrees/0t10/hanging-pug",
      branch: "hanging-pug",
      agentId: "agent-pug",
      classId: "5",
      className: "running",
      action: "nothing",
      evidence: "busy; last activity 33s ago",
      activeAt: new Date(Date.now() - 60_000).toISOString(),
      scope: id,
      placement: "cwd",
      inScope: true,
      history: history("5"),
    },
    {
      id: "015a2e1e-x",
      short: "015a2e1e",
      name: "stoic-goat",
      kind: "background",
      state: "done",
      cwd: "~/.paseo/worktrees/0t6j/stoic-goat",
      branch: null,
      agentId: null,
      classId: "1",
      className: "out of scope",
      action: "nothing",
      evidence: "cwd gone and no board row or worktree parent to place it",
      activeAt: null,
      scope: null,
      placement: "unplaced",
      inScope: false,
      history: [],
    },
  ];
};
const scheduleRun = (at: string): TimelineRun => ({
  at,
  endedAt: at,
  status: "failed",
  exit: null,
  detail: "Scheduled agent b8c26013 was canceled",
  agentId: "b8c26013-30f3-4ebc-bd29-bbfdf08383ee",
  workspaceId: "wks_25a7dc0476779681",
  output: "Waiting on four background jobs.",
});
/** The timeline as timeline.get answers: kg-lint failed, moltbook on time, the fleet scope and the loop. */
const timelineView = (): TimelineView => {
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  const row = (id: string, extra: Partial<TimelineSource>): TimelineSource => ({
    id,
    kind: "launchd",
    name: id,
    cadence: "every 15 minutes",
    status: "ok",
    reason: "On schedule; its last run passed.",
    since: null,
    needsYou: false,
    next: null,
    upcoming: [],
    runs: [],
    runsCut: false,
    last: null,
    where: null,
    hasLog: false,
    link: null,
    ...extra,
  });
  const failed = { at: at(-2 * H), endedAt: at(-2 * H + 5000), status: "failed" as const, exit: 1, detail: "exit 1" };
  return {
    now: at(0),
    from: at(-24 * H),
    to: at(24 * H),
    warnings: [],
    sources: [
      row("fleet:broomva", {
        kind: "fleet",
        name: "fleet-reconcile broomva",
        cadence: "every hour",
        reason: "Ticks every hour. The last, tick 35, passed.",
        next: at(25 * 60_000),
        link: { kind: "fleet", scope: "broomva" },
        runs: timelineRuns
          ? [{ at: at(-3 * H), endedAt: at(-3 * H + 9000), status: "ok", exit: 0, detail: "tick 35", tick: 35 }]
          : [],
      }),
      ...(timelineRuns
        ? [
            row("schedule:c171bfb9", {
              kind: "schedule",
              name: "Morning sweep",
              cadence: "cron 0 9 * * *",
              runs: [scheduleRun(at(-2 * H))],
              last: scheduleRun(at(-2 * H)),
              link: { kind: "agent", agentId: "b8c26013-30f3-4ebc-bd29-bbfdf08383ee" },
            }),
          ]
        : []),
      row("launchd:com.broomva.moltbook-loop", {
        name: "moltbook-loop",
        next: at(10 * 60_000),
        upcoming: [at(10 * 60_000), at(25 * 60_000)],
        runs: [{ at: at(-5 * 60_000), endedAt: at(-5 * 60_000 + 22), status: "ok", exit: 0, detail: "exit 0" }],
        last: { at: at(-5 * 60_000), endedAt: at(-5 * 60_000 + 22), status: "ok", exit: 0, detail: "exit 0" },
      }),
      row("launchd:com.broomva.kg-lint", {
        name: "kg-lint",
        cadence: "Sundays at 02:30",
        status: "failed",
        needsYou: true,
        reason: "Its last run failed: exit 1.",
        since: failed.at,
        runs: [failed],
        last: failed,
        where: "/tmp/broomva-kg-lint.log",
        hasLog: true,
      }),
      row("loop", {
        kind: "loop",
        name: "Maestro's loop",
        cadence: "off",
        status: "off",
        reason: "The loop is off; turn it on in Settings.",
        link: { kind: "loop" },
      }),
    ],
  };
};
let timelineNotices: TimelineNotice[] = [];
/** Every ask the daemon reads: the workspace's, and each fleet root's tagged with its scope (as asks.workspace). */
const allAsks = (): DecisionAsk[] => [...workspaceNow, ...decisionsNow.map((ask) => ({ ...ask, scope: "broomva" }))];
/** needs.list from the fixtures: the work, every ask, the answers batch and the due reviews. */
const needsNow = (kind?: NeedKind) =>
  needsOf({ items, asks: allAsks(), reviews: reviewsNow, landing: landingNow, workspace: "broomva" }, Date.now(), kind);
const calls: { method: string; input: unknown }[] = [];
const invoke = async (method: string, input: unknown) => {
  calls.push({ method, input });
  if (method === "work.stop" && stopHeld) await stopHeld;
  if (method === "work.stop" && stopRefusal && !(input as { discard?: boolean }).discard) {
    throw new Error(stopRefusal);
  }
  if (method === "loop.get") return loopState;
  if (method === "loop.wake") {
    // Your wake takes effect 8 s later (B4): its entry is listed once it has run.
    loopState = { ...loopState, recent: [nextWake(), ...loopState.recent] };
    return { receipt: "r-wake", appliesAt: new Date(Date.now() + 8_000).toISOString() };
  }
  if (method === "verbs.list") return { pending: pendingVerbs, recent: [] };
  if (method === "approval.decide") {
    const { key, allow, action } = input as { key: string; allow: boolean; action: string };
    const entry = {
      receipt: `r-${pendingVerbs.length + 1}`,
      verb: "approval.decide",
      key,
      label: `${allow ? "Allowed" : "Denied"} ${action}`,
      at: new Date().toISOString(),
      appliesAt: new Date(Date.now() + 8_000).toISOString(),
      remainingMs: 8_000,
    };
    pendingVerbs = [entry, ...pendingVerbs];
    return { receipt: entry.receipt, appliesAt: entry.appliesAt };
  }
  if (method === "notice.snooze") {
    const { key } = input as { key: string };
    const entry = {
      receipt: `r-snooze-${pendingVerbs.length + 1}`,
      verb: "notice.snooze",
      key,
      label: `Snoozed ${key} for 4 h`,
      at: new Date().toISOString(),
      appliesAt: new Date(Date.now() + 8_000).toISOString(),
      remainingMs: 8_000,
    };
    pendingVerbs = [entry, ...pendingVerbs];
    return { receipt: entry.receipt, appliesAt: entry.appliesAt };
  }
  if (method === "initiatives.review") {
    const { id } = input as { id: string };
    const entry = {
      receipt: `r-review-${pendingVerbs.length + 1}`,
      verb: "initiative.review",
      key: `review:${id}`,
      label: `Review of ${id}`,
      at: new Date().toISOString(),
      appliesAt: new Date(Date.now() + 8_000).toISOString(),
      remainingMs: 8_000,
    };
    pendingVerbs = [entry, ...pendingVerbs];
    return { receipt: entry.receipt, appliesAt: entry.appliesAt };
  }
  if (method === "verb.undo") {
    const { receipt } = input as { receipt: string };
    pendingVerbs = pendingVerbs.filter((entry) => entry.receipt !== receipt);
    return { undone: true };
  }
  if (method === "config.get") return settings;
  if (method === "config.set") return input;
  if (method === "work.list" && workFail) throw new Error(workFail);
  if (method === "work.list") return { root: "/work", items, warnings: [], scoreboard: board() };
  if (method === "work.history") return { events: history(), capped: false };
  if (method === "work.attention") {
    // What you watch (the pills' sessions and the notices above the views); nothing counts from it any more.
    return {
      waiting: needsYouOf(items).map(({ id, group, flag }) => ({ id, group, flag })),
      sessions: [],
      fleet: fleetNotices,
      timeline: timelineNotices,
      asks: [],
      initiatives: [],
      answers: [],
      loops: loopNoticesNow,
    };
  }
  // What needs you and what was handled, as the server builds them (server/needs.ts) from the same fixtures.
  if (method === "needs.list") {
    if (needsFail) throw new Error(needsFail);
    return needsNow((input as { kind?: NeedKind }).kind);
  }
  if (method === "handled.list") {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    return handledOf(items, allAsks(), Date.now(), day.getTime());
  }
  if (method === "notices.list")
    return noticesOf(
      {
        items,
        fleet: fleetNotices,
        timeline: timelineNotices,
        loops: loopNoticesNow,
        reviews: reviewsNow,
        snoozed: new Map<string, string>(),
      },
      Date.now(),
    );
  if (method === "loops.get") return loopsView();
  // Where your answers went, as the server builds it (server/answers-status.ts) from the same fixtures.
  if (method === "answers.status") return answersStatus(workspaceNow, landingNow);
  if (method === "asks.workspace") {
    if (workspaceFail) throw new Error(workspaceFail);
    return {
      controlRepo: "/Users/me/broomva",
      main: { sha: "1c7740c5", fetchedAt: null },
      decisions: workspaceNow,
      // Each fleet scope's own root asks, tagged as the server tags them (Fleet.scopeDecisions).
      fleet: decisionsNow.map((ask) => ({ ...ask, scope: "broomva" })),
      warnings: [],
    };
  }
  if (method === "initiatives.list") {
    if (initiativesFail) throw new Error(initiativesFail);
    return initiativesNow;
  }
  if (method === "initiatives.file") {
    const { ledger, id } = input as { ledger: string; id: string };
    const work = { id: `filed-${id}`, title: `Work for ${id}`, path: `mod-anything/filed-${id}` };
    initiativesNow = {
      ...initiativesNow,
      developed: [...(initiativesNow.developed ?? []), { ref: `${ledger}#${id}`, ...work }],
    };
    return { work, warning: null };
  }
  if (method === "timeline.get") return timelineView();
  if (method === "timeline.log") {
    const { id } = input as { id: string };
    return id === "launchd:com.broomva.kg-lint"
      ? { path: "/tmp/broomva-kg-lint.log", tail: "[2026-10-02T07:30:00Z] lint: 3 pages fail the schema" }
      : { path: null, tail: null };
  }
  if (method === "fleet.get") {
    if (fleetHeld) await fleetHeld;
    if (fleetFails && (input as { scope?: string }).scope === fleetFails) throw new Error("fleet.get timed out");
    return fleetView((input as { scope?: string }).scope);
  }
  if (method === "fleet.tick") {
    const { tick } = input as { tick: number };
    return {
      tick,
      notes: [],
      report: { markdown: `# fleet-reconcile · broomva · tick ${tick}\n\nReport of tick ${tick}.\n`, truncated: false },
      log: {
        path: "/state/broomva/tick.log",
        text: `[2026-10-03T16:15:39Z] tick ${tick} scope broomva\n[2026-10-03T16:15:48Z] step observe rc=1\n[2026-10-03T16:15:48Z] tick ${tick} done: recover=0 observe=1`,
        truncated: false,
      },
    };
  }
  // Your decision on an answer for the conductor: pending in its undo window until undone (BRO-2990).
  if (method === "conductor.decide") {
    const { key, verb } = input as { key: string; verb: "file" | "dismiss" };
    const appliesAt = new Date(Date.now() + 8_000).toISOString();
    workspaceNow = workspaceNow.map((ask) =>
      ask.fate?.key === key
        ? { ...ask, fate: { ...ask.fate, pending: { verb, receipt: `r-${verb}`, appliesAt } } }
        : ask,
    );
    return { verb, receipt: `r-${verb}`, appliesAt };
  }
  if (method === "conductor.undo") {
    const { receipt } = input as { receipt: string };
    workspaceNow = workspaceNow.map((ask) =>
      ask.fate?.pending?.receipt === receipt ? { ...ask, fate: { ...ask.fate, pending: null } } : ask,
    );
    return { undone: true };
  }
  if (method === "ask.answer") {
    if (answerHeld) await answerHeld;
    if (answerFail) throw new Error(answerFail);
    const { id, option, note, where } = input as {
      id: string;
      option: string | null;
      note: string;
      where: { kind: "fleet" | "workspace" };
    };
    const idea = where.kind === "workspace" ? initiativesNow.ideas.find((entry) => entry.id === id) : undefined;
    if (idea) {
      const { wake } = input as { wake?: string };
      const chosen = idea.options.find((entry) => entry.id === option);
      const answered: DecisionAsk = {
        ...idea,
        state: "answered",
        answerOption: option,
        answer: [chosen ? `${chosen.label}: ${chosen.consequence}` : "", note].filter(Boolean).join("\n"),
        answeredAt: new Date().toISOString(),
        idea: idea.idea ? { ...idea.idea, wake: wake ?? idea.idea.wake } : null,
      };
      initiativesNow = {
        ...initiativesNow,
        ideas: initiativesNow.ideas.map((entry) => (entry.id === id ? answered : entry)),
      };
      // Develop files work: here, the fixture's queued item d.
      return {
        ask: answered,
        warning: null,
        work: option === "develop" ? { id: "d", title: "Work d", path: "mod-anything/d" } : null,
      };
    }
    const held = where.kind === "workspace" ? workspaceNow : decisionsNow;
    const ask = held.find((entry) => entry.id === id);
    if (!ask) throw new Error("no such ask");
    if (answerQueued) {
      const entry = {
        receipt: `r-answer-${pendingVerbs.length + 1}`,
        verb: "ask.answer",
        key: askHoldKey(ask),
        label: `Answered ${ask.id}`,
        at: new Date().toISOString(),
        appliesAt: new Date(Date.now() + 8_000).toISOString(),
        remainingMs: 8_000,
      };
      pendingVerbs = [entry, ...pendingVerbs];
      return { ask, warning: null, receipt: entry.receipt, appliesAt: entry.appliesAt };
    }
    const chosen = ask.options.find((entry) => entry.id === option);
    const answered: DecisionAsk = {
      ...ask,
      state: "answered",
      answerOption: option,
      answer: [chosen ? `${chosen.label}: ${chosen.consequence}` : "", note].filter(Boolean).join("\n"),
      answeredAt: new Date().toISOString(),
    };
    if (where.kind === "workspace") workspaceNow = workspaceNow.map((entry) => (entry.id === id ? answered : entry));
    else decisionsNow = decisionsNow.map((entry) => (entry.id === id ? answered : entry));
    return { ask: answered, warning: null };
  }
  if (method === "fleet.review") {
    const { keys, verdict, note } = input as { keys: string[]; verdict: "accept" | "reject"; note: string };
    const review = { verdict, note: note || null, at: new Date().toISOString(), tick: 35 };
    const mark = (list: FleetProposal[]) =>
      list.map((entry) => (keys.includes(entry.key) ? { ...entry, review } : entry));
    proposalsNow = mark(proposalsNow);
    sriProposals = mark(sriProposals);
    return { proposals: [...proposalsNow, ...sriProposals].filter((entry) => keys.includes(entry.key)) };
  }
  if (method === "work.adopt") return { item: items.find((entry) => entry.id === "a") };
  if (method === "work.for-agent") {
    const { agentId } = input as { agentId: string };
    return { item: items.find((entry) => entry.worker?.agentId === agentId) ?? null };
  }
  if (method === "work.files") return { files };
  if (method === "work.file") {
    const { name } = input as { name: string };
    if (name === "image.png") throw new Error(`Request failed: ${name} is a binary file, so it is not shown.`);
    if (name === "run.log") return { name, text: "step 1\nstep 2\n", truncated: true };
    return { name, text: "# Work a\n\nStore it on the Run record.\n", truncated: false };
  }
  if ((input as { id?: string }).id === FLEET_ITEM.id) return FLEET_DETAIL;
  const item = items.find((entry) => entry.id === (input as { id: string }).id);
  return { item, brief: "", events: [], checkResults: [] };
};
const theme = {
  colors: {
    surface0: "#fff",
    surface1: "#f3f4f6",
    surface2: "#eee",
    border: "#e1e3e6",
    foreground: "#0c101a",
    foregroundMuted: "#5f636c",
    accent: "#5480c7",
    accentForeground: "#fff",
    statusSuccess: "#0a0",
    statusWarning: "#a60",
    statusDanger: "#a00",
  },
};
const diffState = {
  subscribe: () => () => {},
  getWorkspace: (id: string) => (id === "ws-a" ? { id, diffStat: { additions: 12, deletions: 3 } } : null),
  getAgent: () => null,
};
const surface = (compact: boolean, params: Record<string, string> = {}) => (
  <MaestroSurface
    theme={theme}
    host={{ id: "h", label: "h" }}
    layout={{ compact, platform: "web" }}
    params={params}
    navigation={{
      openAgent({ agentId }: { agentId: string }) {
        opened.push(agentId);
      },
      openWorkspace() {},
    }}
  />
);

/** Bumped when each test ends: a step owned by an earlier test refuses to run. */
let generation = 0;
let closed = false;
/** The act scope running now, so teardown can wait for it to close. */
let inFlight: Promise<unknown> = Promise.resolve();

function step(owner: number, run: () => unknown): Promise<void> {
  if (closed || owner !== generation) {
    return Promise.reject(new Error("This test already ended (it timed out); the harness refused its next step."));
  }
  // act hands back a thenable without catch: adopt it as a promise (which also awaits it, as act asks).
  const running = Promise.resolve(
    act(async () => {
      await run();
    }),
  );
  inFlight = running.catch(() => undefined);
  return running;
}

const settle = (ms = 20) => step(generation, () => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const mounted: (() => void)[] = [];

async function mount(node: ReactNode, options: { state?: PluginClientStateSource } = {}) {
  const owner = generation;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Recorded before it renders, so a test that times out mid-mount still gets unmounted.
  mounted.push(() => {
    try {
      act(() => root.unmount());
    } finally {
      client.clear();
      container.remove();
    }
  });
  const wrap = (inner: ReactNode) => {
    const scoped = options.state ? (
      <PluginClientStateProvider source={options.state}>{inner}</PluginClientStateProvider>
    ) : (
      inner
    );
    return (
      <QueryClientProvider client={client}>
        <PaseoApiProvider paseo={{} as never}>
          <PluginRpcProvider invoke={invoke}>{scoped}</PluginRpcProvider>
        </PaseoApiProvider>
      </QueryClientProvider>
    );
  };
  await step(owner, () => root.render(wrap(node)));
  await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`);
  const byId = (id: string) => container.querySelector(`[id="${id}"]`);
  const picker = () => container.querySelector('[aria-label^="View: "]');
  const press = async (target: Element | null | undefined) => {
    if (!target) throw new Error("nothing to press");
    await step(owner, () => (target as unknown as { click(): void }).click());
    await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  };
  return {
    text: () => container.textContent ?? "",
    byLabel,
    byId,
    tabs: () => [...container.querySelectorAll('[role="tab"]')],
    pressed: (label: string) => byLabel(label)?.getAttribute("aria-pressed"),
    all: (selector: string) => [...container.querySelectorAll(selector)],
    press,
    type: async (target: Element | null | undefined, value: string) => {
      if (!target) throw new Error("nothing to type in");
      const field = target as unknown as { tagName: string; dispatchEvent(event: unknown): boolean };
      const proto = field.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      await step(owner, () => {
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
        field.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
      await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    },
    rerender: async (next: ReactNode) => {
      await step(owner, () => root.render(wrap(next)));
      await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    },
    /** Every query asks again now, as the 4 s poll would: how a change to the fixture reaches a mounted surface. */
    refetch: async () => {
      await step(owner, () => client.invalidateQueries());
      await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    },
    // The pulse ring is the absolutely placed dot that scales; a button's press scale is not one.
    rings: () =>
      [...container.querySelectorAll("div")].filter(
        (el) => el.style.transform.includes("scale") && el.style.position === "absolute",
      ),
    /** Goes to a view by its name: its tab on a wide window, the view picker's menu on a phone. */
    goto: async (label: string) => {
      const named = (el: { getAttribute(name: string): string | null }) => {
        const name = el.getAttribute("aria-label") ?? "";
        return name === label || name.startsWith(`${label}, `);
      };
      const tab = [...container.querySelectorAll('[role="tab"]')].find(named);
      if (tab) return press(tab);
      // On a wide window a view that is not a header tab sits under one (Work: Board, List, History; Health: Fleet,
      // Timeline, Loops): its tab first, then its segment.
      const parent = {
        Board: "Work",
        List: "Work",
        History: "Work",
        Fleet: "Health",
        Timeline: "Health",
        Loops: "Health",
      }[label];
      const header = parent
        ? [...container.querySelectorAll('[role="tab"]')].find(
            (el) => (el.getAttribute("aria-label") ?? "").split(", ")[0] === parent,
          )
        : null;
      if (header) {
        await press(header);
        const segment = container.querySelector(`[role="radio"][aria-label="${label}"]`);
        if (segment?.getAttribute("aria-checked") !== "true") await press(segment);
        return;
      }
      if (!container.querySelector('[role="menu"]')) await press(picker());
      await press([...container.querySelectorAll('[role="menuitem"]')].find(named));
    },
    /** The view on screen, by its name: the selected tab, or what the phone's view picker says. */
    viewNow: () => {
      const tab = [...container.querySelectorAll('[role="tab"]')].find(
        (el) => el.getAttribute("aria-selected") === "true",
      );
      // Under a header tab with several views, the checked segment names the view.
      const segment = [...container.querySelectorAll('[role="radiogroup"][aria-label$=" views"] [role="radio"]')].find(
        (el) => el.getAttribute("aria-checked") === "true",
      );
      const name =
        segment?.getAttribute("aria-label") ??
        tab?.getAttribute("aria-label") ??
        picker()?.getAttribute("aria-label")?.slice("View: ".length);
      return name?.split(/[,.]/)[0] ?? null;
    },
  };
}

const consoleError = spyOn(console, "error").mockImplementation(() => {});
const isProbe = (args: unknown[]) => args.some((arg) => String(arg).includes("inside a workspace panel"));
const probeLogs = () => consoleError.mock.calls.filter(isProbe).length;

/** Waits out the act scope still open (a timed-out test's), then unmounts every surface, each on its own. */
async function unmountAll(): Promise<string[]> {
  await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  const failures: string[] = [];
  for (const unmount of mounted.splice(0)) {
    try {
      unmount();
    } catch (error) {
      failures.push(String(error));
    }
  }
  return failures;
}

afterEach(async () => {
  generation += 1;
  const failures = await unmountAll();
  takeIntent();
  items = fixture();
  pendingVerbs = [];
  loopState = loopOff();
  nextWake = () => wakeEntry("w-now", 0, { cause: "manual" });
  settings = settingsFixture();
  stopRefusal = null;
  stopHeld = null;
  fleetNotices = [];
  broomvaOnTime = false;
  fleetHeld = null;
  fleetFails = null;
  rosterExtra = [];
  askOverride = {};
  timelineNotices = [];
  proposalsNow = fleetProposals();
  sriProposals = sriFixture();
  decisionsNow = [];
  workspaceNow = [];
  workspaceFail = null;
  answerHeld = null;
  answerFail = null;
  answerQueued = false;
  loopNoticesNow = [];
  landingNow = null;
  needsFail = null;
  workFail = null;
  askSessionNow = null;
  opened = [];
  initiativesNow = initiativesFixture();
  reviewsNow = [];
  initiativesFail = null;
  urls.length = 0;
  toasts.length = 0;
  timelineRuns = false;
  calls.length = 0;
  setReduced(true);
  // The message and its first argument: React's act warning names the component there ("An update to %s").
  const unexpected = consoleError.mock.calls
    .filter((args) => !isProbe(args))
    .map((args) => (args.length > 1 ? `${String(args[0])} [${String(args[1])}]` : String(args[0])));
  consoleError.mockClear();
  expect(failures).toEqual([]);
  expect(unexpected).toEqual([]);
});

afterAll(async () => {
  closed = true;
  generation += 1;
  await unmountAll();
  resetIntents();
  consoleError.mockRestore();
  notifyManager.setNotifyFunction((notify) => {
    notify();
  });
  mock.restore();
  mock.module(KIT, () => realKit);
  mock.module(UI, () => realUi);
  for (const key of added) delete (globalThis as Record<string, unknown>)[key];
  await win.happyDOM.close();
});

describe("the changed line", () => {
  test("a surface without client state renders, logs once, and shows no changed stat", async () => {
    items = finished("a");
    const view = await mount(surface(true));
    // needs.list's holds: Work g at your gate, holding a prompt (Work a finished, Work b is stuck: watched, A1).
    expect(view.text()).toContain("1 needs you · 1 running");
    expect(view.text()).toContain("hawthorne · core");
    expect(view.text()).toContain("maestro/a-1");
    expect(view.text()).not.toMatch(/\+\d+ −\d+/);
    expect(probeLogs()).toBe(1);
    await view.press(view.byLabel("Work a, Finished, hawthorne · core, updated 12 minutes ago"));
    expect(view.text()).toContain("Changed");
    await view.press(view.byLabel("Back to all work"));
    await view.press(view.byLabel("Work g, Needs you, updated 12 minutes ago"));
    expect(view.text()).toContain("Approve the branch");
    expect(view.text()).not.toContain("Changed");
    expect(probeLogs()).toBe(1);
  });

  test("while needs.list cannot be read, the subtitle never says nothing needs you, and says why (BRO-3001)", async () => {
    needsFail = "socket closed";
    const view = await mount(surface(true));
    for (let tries = 0; tries < 100 && !view.text().includes("could not be read"); tries += 1) await settle(20);
    expect(view.text()).toContain("What needs you could not be read");
    // What the work alone says, in words that say so: never a bare number, never "Nothing needs you".
    expect(view.text()).toContain("2 work items need you · 1 running");
    expect(view.text()).not.toContain("Nothing needs you");
  });

  test("with no work waiting and needs.list unread, it still never says nothing needs you: an ask may wait", async () => {
    needsFail = "socket closed";
    items = fixture().filter((item) => item.state !== "review");
    const view = await mount(surface(true));
    for (let tries = 0; tries < 100 && !view.text().includes("could not be read"); tries += 1) await settle(20);
    expect(view.text()).toContain("What needs you could not be read");
    expect(view.text()).not.toContain("Nothing needs you");
  });

  test("one snapshot with the header button: the screen's reads reach it, and its reads fill the screen (BRO-3001)", async () => {
    resetNeedsBus();
    const toHeader: number[] = [];
    const stop = onNeeds((next, from) => {
      if (from === "screen") toHeader.push(next.summary.total);
    });
    try {
      const view = await mount(surface(true));
      for (let tries = 0; tries < 100 && !view.byLabel("View: Feed, 2 need you. Change view"); tries += 1)
        await settle(20);
      expect(toHeader).toEqual([2]);
      // You act on the screen (a verb settles, every query refetches): the header hears the new number.
      items = [...fixture(), work("n", "review")];
      await view.refetch();
      for (let tries = 0; tries < 100 && toHeader.at(-1) !== 3; tries += 1) await settle(20);
      expect(toHeader).toEqual([2, 3]);
      // The header read a newer snapshot first: the open screen says it at once, with no read of its own.
      const reads = calls.filter((call) => call.method === "needs.list").length;
      const header = needsNow();
      const newer = { ...header, rows: header.rows.slice(0, 1), summary: { ...header.summary, total: 1 } };
      await step(generation, () => publishNeeds(newer, "header", readTicket()));
      for (let tries = 0; tries < 100 && !view.byLabel("View: Feed, 1 needs you. Change view"); tries += 1)
        await settle(20);
      expect(view.byLabel("View: Feed, 1 needs you. Change view")).not.toBeNull();
      expect(view.text()).toContain("1 needs you · 1 running");
      expect(calls.filter((call) => call.method === "needs.list").length).toBe(reads);
    } finally {
      stop();
      resetNeedsBus();
    }
  });

  test("with client state, the card and the detail show +a −d", async () => {
    items = finished("a");
    const view = await mount(surface(true), { state: diffState as unknown as PluginClientStateSource });
    expect(view.text()).toContain("+12 −3");
    expect(view.byLabel("12 lines added, 3 removed")).not.toBeNull();
    const card = view.byLabel("Work a, Finished, hawthorne · core, updated 12 minutes ago");
    expect(card?.getAttribute("aria-current")).toBe("false");
    await view.press(card);
    // A phone's detail takes the page: the stat is on the detail, and the list is behind it.
    expect(view.byLabel("12 lines added, 3 removed")).not.toBeNull();
    expect(view.text().match(/\+12 −3/g)).toHaveLength(1);
    expect(probeLogs()).toBe(0);
  });

  test("the server's changed line shows on the card and the detail with no client state", async () => {
    items = finished("a").map((item) =>
      item.id === "a" ? { ...item, changed: { additions: 5, deletions: 1 } } : item,
    );
    const view = await mount(surface(true));
    expect(view.byLabel("5 lines added, 1 removed")).not.toBeNull();
    await view.press(view.byLabel("Work a, Finished, hawthorne · core, updated 12 minutes ago"));
    expect(view.text().match(/\+5 −1/g)).toHaveLength(1);
  });

  test("the detail alone, as the agent panel mounts it, survives a host without state", async () => {
    items = finished("a");
    const view = await mount(
      <WorkDetail id="a" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    expect(view.text()).toContain("Approve the branch");
    expect(view.text()).toContain("Changed");
    expect(view.text()).toContain("maestro/a-1");
  });
});

describe("before a verb that can start a run", () => {
  const fromSettings = (extra: Partial<NonNullable<WorkItem["nextRun"]>> = {}) => ({
    provider: "claude",
    isolation: "worktree" as const,
    modeId: "bypassPermissions",
    thinkingOptionId: null,
    featureValues: null,
    fromSettings: ["provider" as const, "isolation" as const, "modeId" as const],
    ...extra,
  });

  test("a queued item whose mode comes only from Settings says so and warns before Dispatch", async () => {
    items = [...fixture(), work("q", "proposed", { nextRun: fromSettings() })];
    const view = await mount(
      <WorkDetail id="q" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    expect(view.text()).toContain("Runs with claude (from Settings): mode bypassPermissions (from Settings).");
    expect(view.text()).toContain("This run skips permission prompts");
    expect(view.byLabel("Dispatch")).not.toBeNull();
  });

  test("a stuck item says Unblock may start a new run with the Settings mode, and warns", async () => {
    items = [
      ...fixture(),
      work("s", "blocked", { worker: worker("s", null), reason: "The session was archived", nextRun: fromSettings() }),
    ];
    const view = await mount(
      <WorkDetail id="s" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    expect(view.text()).toContain(
      "If the session is gone, Unblock starts a new run in a fresh worktree on its own run branch (from Settings), with claude (from Settings): mode bypassPermissions (from Settings).",
    );
    expect(view.text()).toContain("That new run would skip permission prompts");
    expect(view.byLabel("Unblock")).not.toBeNull();
  });

  test("a run that asks before it acts carries no warning", async () => {
    items = [...fixture(), work("p", "proposed", { nextRun: fromSettings({ modeId: "acceptEdits" }) })];
    const view = await mount(
      <WorkDetail id="p" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    expect(view.text()).toContain("mode acceptEdits (from Settings)");
    expect(view.text()).not.toContain("skip");
  });
});

describe("work the loop flagged", () => {
  const yours = {
    kind: "yours" as const,
    reason: "Start it yourself: it runs without permission prompts.",
    at: new Date(Date.now() - 2 * 60_000).toISOString(),
  };
  const flagged = () => [...fixture(), work("y", "proposed", { flag: yours })];

  test("is in Needs you: the Feed's hold, the List's chip, and the board's column, with the reason on its card", async () => {
    items = flagged();
    const view = await mount(surface(false));
    for (let tries = 0; tries < 100 && !view.byLabel("Feed, 3 need you"); tries += 1) await settle(20);
    // An owner step (only you may start it), beside the two at your gate: a hold card, with where it is done.
    const card = view.byId("hold-work:y") ?? view.all('[data-testid="hold-work:y"]')[0];
    expect(card?.textContent).toContain("Work y");
    expect(card?.textContent).toContain("Needs you · owner step");
    // The state chips are the List's (the Feed's sections already put what needs you first).
    await view.goto("List");
    await view.press(view.byLabel("Needs you, 3"));
    expect(view.text()).toContain("Work y");
    expect(view.text()).not.toContain("Work d");
    // J6: Work y is in the Needs you tray, once, and not in Queued (which still holds Work d).
    await view.goto("Board");
    const lane = (id: string) => view.all(`[data-testid="lane-${id}"]`)[0]?.textContent ?? "";
    expect(lane("needs")).toContain("Work y");
    expect(lane("needs")).toContain("owner step");
    expect(lane("queued")).not.toContain("Work y");
    expect(lane("queued")).toContain("Work d");
    expect(view.text().match(/Work y/g)).toHaveLength(1);
  });

  test("the Feed home's Needs you lists exactly needs.list's holds: as many as the header, the Feed tab and the tile say (BRO-3001, BRO-3035)", async () => {
    const quiet = { kind: "quiet" as const, reason: "Quiet for 41 minutes, worth a look.", at: yours.at };
    items = [
      ...fixture(),
      work("y", "proposed", { flag: yours }),
      work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet }),
    ];
    const view = await mount(surface(false));
    for (let tries = 0; tries < 100 && !view.byLabel("Feed, 3 need you"); tries += 1) await settle(20);
    // needs.list as the server builds it: the two at your gate (approvals) and the one only you may start.
    const needs = needsNow();
    const count = needs.summary.total;
    expect(count).toBe(3);
    // The header (Paseo's), the Feed tab's badge, the Needs you tile and the section say the same number.
    expect(headerFace(count).label).toBe("3 need you");
    expect(view.byLabel(`Feed, ${count} need you`)).not.toBeNull();
    expect(view.all('[aria-label^="Needs you, 3, holds"]')).toHaveLength(1);
    // The section lists exactly the rows, in their order.
    const heading = view.all('[role="heading"]').find((el) => el.textContent === "Needs you");
    const header = heading?.parentElement;
    expect(header?.textContent).toBe(`Needs you${count}2 approvals · 1 owner step`);
    const cards = view.all('[data-testid^="hold-"]').map((el) => el.getAttribute("data-testid"));
    expect(cards).toEqual(needs.rows.map((row) => `hold-${row.key}`));
    expect(cards).toHaveLength(count);
    expect(cards).toEqual(["hold-work:a", "hold-work:g", "hold-work:y"]);
    // Watched, not held (A1): stuck work under Health, the quiet run under Running, each listed once.
    const headings = view.all('[role="heading"]').map((el) => el.textContent);
    expect(headings).toContain("Health");
    expect(headings).toContain("Running");
    for (const title of ["Work y", "Work z", "Work b"])
      expect(view.text().match(new RegExp(title, "g"))).toHaveLength(1);
    const section = view
      .all('[data-testid^="hold-"]')
      .map((el) => el.textContent ?? "")
      .join(" ");
    expect(section).not.toContain("Needs a Linear scope");
    expect(section).not.toContain(quiet.reason);
    // The List's chip the header opens holds the same work.
    await view.goto("List");
    expect(view.byLabel(`Needs you, ${count}`)).not.toBeNull();
  });

  test("a quiet run's notice offers Leave it running, which asks the host; other flags offer nothing of their own", async () => {
    const quiet = { kind: "quiet" as const, reason: "Quiet for 41 minutes, worth a look.", at: yours.at };
    items = [...flagged(), work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet })];
    const view = await mount(
      <WorkDetail id="z" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    const [alert] = view.all('[role="alert"]');
    expect(alert?.textContent).toContain(quiet.reason);
    const leave = alert?.querySelector('[aria-label="Leave it running"]');
    expect(leave).not.toBeNull();
    await view.press(leave);
    expect(calls.filter((call) => call.method === "work.leave-running").map((call) => call.input)).toEqual([
      { id: "z" },
    ]);
    // A start left to you clears when you dispatch or cancel: its notice has no verb of its own.
    await view.rerender(
      <WorkDetail id="y" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    expect(view.byLabel("Leave it running")).toBeNull();
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toContain(yours.reason);
  });

  test("the detail says why, as a warning Notice; unflagged work has none", async () => {
    items = flagged();
    const view = await mount(
      <WorkDetail id="y" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toContain(yours.reason);
    expect(view.byLabel("Dispatch")).not.toBeNull();
    await view.rerender(
      <WorkDetail id="d" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    expect(view.text()).not.toContain(yours.reason);
    expect(view.all('[role="alert"]')).toHaveLength(0);
  });
});

describe("a finished arc at your gate (BRO-2856)", () => {
  const detail = (id: string) => (
    <WorkDetail id={id} theme={theme} compact={false} navigation={undefined} open={requestIntent} />
  );
  const root = { kind: "root" as const, path: "/state/broomva/.control/asks", branch: null };
  const arcLook = {
    ran: "2h unsupervised · 1 turn · ran to the gate",
    decided: [],
    ask: "It hands 1 thing back to you. Approve to close the work once you have taken it on, or send it back with a note.",
    arc: { status: "HANDBACK", line: "ARC-STATUS: HANDBACK 1" },
    closing: "What's left for you:\n1. Redeploy main to production.",
    archived: true,
  };

  test("it says what the arc reported, shows what it left verbatim, says the session is archived, and links its ask exactly", async () => {
    // The run's folder is the arc's name: its ledger's open ask is linked, a ledger of another arc is not.
    items = [
      ...fixture(),
      work("arc", "review", {
        permission: null,
        worker: { ...worker("arc", null), cwd: "/wt/0t6jwuf0/sti-3485-approval-reply" },
        look: arcLook,
      }),
    ];
    decisionsNow = [
      { ...decisionFixture(), ledger: "sti-3485.yaml", arc: "sti-3485-approval-reply", id: "redeploy", home: root },
      { ...decisionFixture(), ledger: "sti-3485.yaml", arc: "another-arc", id: "twin", home: root },
    ];
    const view = await mount(detail("arc"));
    for (let tries = 0; tries < 100 && !view.text().includes("Answer its"); tries += 1) await settle(20);
    const text = view.text();
    expect(text).toContain("It hands 1 thing back to you.");
    expect(text).toContain("Its session is archived.");
    expect(text).toContain("Its last words · ARC-STATUS: HANDBACK 1");
    expect(text).toContain("Redeploy main to production.");
    expect(text).toContain("Answer its 1 decision in Decisions");
    takeIntent();
    await view.press(view.byLabel("Answer its 1 decision in Decisions"));
    // The ask's full identity (askKey: home, ledger, uid, id), so Decisions opens that ask and no other.
    expect(takeIntent()).toEqual({
      kind: "decisions",
      ledger: "broomva/sti-3485.yaml",
      id: "redeploy",
      key: JSON.stringify([root.path, "sti-3485.yaml", null, "redeploy"]),
    });
  });

  test("asks of one arc in two ledgers: the link opens every ledger, at the first ask", async () => {
    items = [
      ...fixture(),
      work("arc", "review", {
        permission: null,
        worker: { ...worker("arc", null), cwd: "/wt/0t6jwuf0/sti-3485-approval-reply" },
        look: arcLook,
      }),
    ];
    decisionsNow = [
      { ...decisionFixture(), ledger: "a.yaml", arc: "sti-3485-approval-reply", id: "first", home: root },
      { ...decisionFixture(), ledger: "b.yaml", arc: "sti-3485-approval-reply", id: "second", home: root },
    ];
    const view = await mount(detail("arc"));
    for (let tries = 0; tries < 100 && !view.text().includes("Answer its"); tries += 1) await settle(20);
    takeIntent();
    await view.press(view.byLabel("Answer its 2 decisions in Decisions"));
    expect(takeIntent()).toEqual({
      kind: "decisions",
      ledger: null,
      id: "first",
      key: JSON.stringify([root.path, "a.yaml", null, "first"]),
    });
  });

  test("from a session's gate card, the link goes through the card's opener, which opens Maestro too", async () => {
    items = [
      ...fixture(),
      work("arc", "review", {
        permission: null,
        worker: { ...worker("arc", null), cwd: "/wt/0t6jwuf0/sti-3485-approval-reply" },
        look: arcLook,
        landing: 3,
      }),
    ];
    decisionsNow = [
      { ...decisionFixture(), ledger: "sti-3485.yaml", arc: "sti-3485-approval-reply", id: "redeploy", home: root },
    ];
    const asked: unknown[] = [];
    const Card = createGateCard((intent) => asked.push(intent));
    const props = {
      item: { data: { workId: "arc", landing: 3, agentId: "ag-arc" } },
      theme,
      layout: { compact: false },
    } as unknown as ComponentProps<typeof Card>;
    const view = await mount(<Card {...props} />);
    for (let tries = 0; tries < 100 && !view.text().includes("Answer its"); tries += 1) await settle(20);
    takeIntent();
    await view.press(view.byLabel("Answer its 1 decision in Decisions"));
    // Not left for a surface that may not be open: handed to the card's opener.
    expect(takeIntent()).toBeNull();
    expect(asked).toEqual([
      {
        kind: "decisions",
        ledger: "broomva/sti-3485.yaml",
        id: "redeploy",
        key: JSON.stringify([root.path, "sti-3485.yaml", null, "redeploy"]),
      },
    ]);
  });

  /** The session's gate card for work `id` landed at 3, mounted as Paseo mounts it. */
  async function gateCard(id: string) {
    const Card = createGateCard(() => undefined);
    const props = {
      item: { data: { workId: id, landing: 3, agentId: `ag-${id}` } },
      theme,
      layout: { compact: false },
    } as unknown as ComponentProps<typeof Card>;
    const view = await mount(<Card {...props} />);
    for (
      let tries = 0;
      tries < 100 && !view.text().includes("Change course") && !view.text().includes("The agent is asking");
      tries += 1
    ) {
      await settle(20);
    }
    return view;
  }

  test("a card for a run that asked nothing shows its last words and says what the verbs do, inventing no ask", async () => {
    const said = "Stored it on the Run record. All 40 tests pass and the branch is pushed.";
    const look = { ran: "18m unsupervised · 1 turn · ran to the gate", decided: [], ask: "", arc: null, closing: said };
    items = [
      ...fixture(),
      work("plain", "review", { permission: null, worker: worker("plain", null), look, landing: 3 }),
    ];
    const text = (await gateCard("plain")).text();
    expect(text).toContain("Its last words");
    expect(text).toContain(said);
    expect(text).toContain(
      "Change course reopens its session with your note. Gates merge finished work; you do not approve it.",
    );
    expect(text).not.toContain("Ask");
    expect(text).not.toContain("Approve to close it");
    // What it asks comes before how long it ran: the run's meta is the footer.
    expect(text.indexOf(said)).toBeLessThan(text.indexOf("18m unsupervised"));
  });

  test("a card for a handback shows its ⛔ block verbatim as what it handed you", async () => {
    const look = {
      ran: "40m unsupervised · 2 turns · ran to the gate",
      decided: [],
      ask: "⛔ Blocked on you — 1 item, ~2 min",
      arc: null,
      closing: null,
      handed: "| # | ask | unblocks |\n|---|---|---|\n| 1 | Merge #2134 | the deploy |",
    };
    items = [
      ...fixture(),
      work("handed", "review", { permission: null, worker: worker("handed", null), look, landing: 3 }),
    ];
    const text = (await gateCard("handed")).text();
    expect(text).toContain("⛔ Blocked on you — 1 item, ~2 min");
    expect(text).toContain("What it handed you");
    expect(text).toContain("Merge #2134");
  });

  test("in the work panel beside a session, the link goes through the panel's opener, which opens Maestro too", async () => {
    items = [
      ...fixture(),
      work("arc", "review", {
        permission: null,
        worker: { ...worker("arc", null), cwd: "/wt/0t6jwuf0/sti-3485-approval-reply" },
        look: arcLook,
      }),
    ];
    decisionsNow = [
      { ...decisionFixture(), ledger: "sti-3485.yaml", arc: "sti-3485-approval-reply", id: "redeploy", home: root },
    ];
    const asked: unknown[] = [];
    const Panel = createWorkPanel((intent) => asked.push(intent));
    const props = {
      theme,
      layout: { compact: false },
      agentId: "ag-arc",
      navigation: undefined,
    } as unknown as ComponentProps<typeof Panel>;
    const view = await mount(<Panel {...props} />);
    for (let tries = 0; tries < 100 && !view.text().includes("Answer its"); tries += 1) await settle(20);
    takeIntent();
    await view.press(view.byLabel("Answer its 1 decision in Decisions"));
    expect(takeIntent()).toBeNull();
    expect(asked).toEqual([
      {
        kind: "decisions",
        ledger: "broomva/sti-3485.yaml",
        id: "redeploy",
        key: JSON.stringify([root.path, "sti-3485.yaml", null, "redeploy"]),
      },
    ]);
  });

  test("with nothing left above the verdict and the session alive, the card adds nothing", async () => {
    const bare = {
      ...arcLook,
      closing: null,
      archived: false,
      ask: "It reports its arc finished. Approve to close the work, or send it back with a note.",
    };
    items = [...fixture(), work("arc", "review", { permission: null, worker: worker("arc", null), look: bare })];
    const view = await mount(detail("arc"));
    const text = view.text();
    expect(text).toContain("It reports its arc finished.");
    expect(text).not.toContain("Its last words");
    expect(text).not.toContain("Its session is archived.");
    expect(text).not.toContain("in Decisions");
  });
});

describe("Stop run", () => {
  const permission = { requestId: "r1", title: "Run a command", detail: "rm -rf dist" };
  const asking = (id: string, extra: Partial<WorkItem> = {}) =>
    work(id, "review", {
      worker: worker(id, `maestro/${id}-1`),
      phase: "asking",
      permission,
      look: { ran: "4m unsupervised · 1 turn · paused on a question", decided: [], ask: "Run a command: rm -rf dist" },
      ...extra,
    });
  const detail = (id: string) => (
    <WorkDetail id={id} theme={theme} compact={false} navigation={undefined} open={requestIntent} />
  );
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
  const move = (id: string, next: WorkItem) => {
    items = items.map((item) => (item.id === id ? next : item));
  };
  const CONFIRM = "Stopping archives the session. The branch and its commits stay.";
  const CONFIRM_ASKING =
    "Stopping archives the session and leaves its question unanswered. The branch and its commits stay.";

  test("the asking card offers Stop run beside Allow and Deny, and no Cancel work", async () => {
    items = [...fixture(), asking("k")];
    const view = await mount(detail("k"));
    expect(view.text()).toContain("The agent is asking");
    for (const label of ["Allow", "Deny", "Stop run"]) expect(view.byLabel(label)).not.toBeNull();
    // Cancel would close the work and leave the session waiting on the question: Stop, then cancel from Stuck.
    expect(view.byLabel("Cancel work")).toBeNull();

    // Stop confirms first, as it does for a working run, and says the question goes unanswered.
    await view.press(view.byLabel("Stop run"));
    expect(view.text()).toContain(CONFIRM_ASKING);
    expect(view.byLabel("Keep it waiting")).not.toBeNull();
    expect(view.byLabel("Cancel work")).toBeNull();
    expect(sent("work.stop")).toEqual([]);
    await view.press(view.byLabel("Stop run"));
    expect(sent("work.stop")).toEqual([{ id: "k" }]);
    expect(view.text()).not.toContain(CONFIRM_ASKING);
  });

  test("a Stop at the question that would delete uncommitted work asks again, and Discard and stop says so", async () => {
    stopRefusal =
      "Not stopped: the worktree has 2 paths not committed (edits, new or ignored files), and stopping archives it, which deletes them. Stop again and confirm to discard them.";
    items = [...fixture(), asking("k")];
    const view = await mount(detail("k"));
    await view.press(view.byLabel("Stop run"));
    await view.press(view.byLabel("Stop run"));
    expect(view.text()).toContain("the worktree has 2 paths not committed");
    await view.press(view.byLabel("Discard and stop"));
    expect(sent("work.stop")).toEqual([{ id: "k" }, { id: "k", discard: true }]);
  });

  test("with a decision in its undo window, the asking card keeps Stop run and drops Cancel work", async () => {
    items = [
      ...fixture(),
      asking("k", {
        pending: {
          verdict: "block",
          note: "",
          decidedAt: new Date().toISOString(),
          effectiveAt: new Date(Date.now() + 9_000).toISOString(),
          remainingMs: 9_000,
        },
      }),
    ];
    const view = await mount(detail("k"));
    expect(view.text()).toContain("Canceling the work in");
    expect(view.byLabel("Stop run")).not.toBeNull();
    expect(view.byLabel("Cancel work")).toBeNull();
  });

  test("an open confirm survives the run asking a question, and the question being answered", async () => {
    const view = await mount(detail("c"));
    await view.press(view.byLabel("Stop run"));
    expect(view.text()).toContain(CONFIRM);
    move("c", asking("c"));
    await view.refetch();
    expect(view.text()).toContain("The agent is asking");
    expect(view.text()).toContain(CONFIRM_ASKING);
    move("c", fixture().find((item) => item.id === "c") as WorkItem);
    await view.refetch();
    expect(view.text()).toContain(CONFIRM);
    expect(view.all('[role="alert"]')).toHaveLength(0);
  });

  test("a run that moves on before you confirm says so in a Notice, instead of the confirm vanishing", async () => {
    const view = await mount(detail("c"));
    await view.press(view.byLabel("Stop run"));
    expect(view.text()).toContain(CONFIRM);
    move("c", work("c", "blocked", { worker: worker("c", "maestro/c-1"), reason: "Rate limited" }));
    await view.refetch();
    expect(view.text()).not.toContain(CONFIRM);
    const [alert] = view.all('[role="alert"]');
    expect(alert?.textContent).toContain("The run moved on before you confirmed: it is now Stuck.");
    // The state's own verbs are under it.
    expect(view.byLabel("Unblock")).not.toBeNull();
    await view.press(alert?.querySelector('[aria-label="Dismiss"]'));
    expect(view.all('[role="alert"]')).toHaveLength(0);
    expect(sent("work.stop")).toEqual([]);
  });

  test("the second confirm, and the asking state's, say it too, with the state's plain label", async () => {
    stopRefusal = "Not stopped: the worktree has 1 path not committed (edits, new or ignored files).";
    items = [...fixture(), asking("k")];
    const view = await mount(detail("k"));
    await view.press(view.byLabel("Stop run"));
    await view.press(view.byLabel("Stop run"));
    expect(view.byLabel("Discard and stop")).not.toBeNull();
    move("k", work("k", "review", { permission: null, worker: worker("k", "maestro/k-1"), look }));
    await view.refetch();
    expect(view.byLabel("Discard and stop")).toBeNull();
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toContain(
      "The run moved on before you confirmed: it is now Finished.Dismiss",
    );
  });

  test("your own Stop in flight is not a move on: a poll that sees it stuck first shows no Notice", async () => {
    let release = () => {};
    stopHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await mount(detail("c"));
    await view.press(view.byLabel("Stop run"));
    await view.press(view.byLabel("Stop run"));
    expect(sent("work.stop")).toEqual([{ id: "c" }]);
    // The host stopped it and a poll read that before the call answered.
    move("c", work("c", "blocked", { worker: worker("c", "maestro/c-1"), reason: "You stopped the run" }));
    await view.refetch();
    expect(view.text()).toContain("You stopped the run");
    expect(view.all('[role="alert"]')).toHaveLength(0);
    release();
    await settle(50);
    expect(view.all('[role="alert"]')).toHaveLength(0);
  });

  test("checks starting count as moving on: the run is done, and the checks decide", async () => {
    const view = await mount(detail("c"));
    await view.press(view.byLabel("Stop run"));
    move("c", work("c", "running", { worker: worker("c", "maestro/c-1"), phase: "checking" }));
    await view.refetch();
    expect(view.text()).toContain("The run moved on before you confirmed: it finished, and its checks are running.");
    expect(view.byLabel("Stop run")).toBeNull();
  });
});

describe("views and filters", () => {
  test("each chip counts exactly what it shows; the section chips match the feed's sections and add up to All", async () => {
    const at = new Date(Date.now() - 2 * 60_000).toISOString();
    const yours = { kind: "yours" as const, reason: "Start it yourself: it runs without permission prompts.", at };
    const quiet = { kind: "quiet" as const, reason: "Quiet for 41 minutes, worth a look.", at };
    items = [
      ...fixture(),
      work("y", "proposed", { flag: yours }),
      work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet }),
      work("q", "proposed"),
    ];
    const view = await mount(surface(false));
    // The chips live on the List: its sections are the same groups the chips count.
    await view.goto("List");
    /** The chips as the toolbar shows them: label to count. */
    const chips = () =>
      new Map(
        view.all('[aria-label="Filter by state"] [role="button"]').map((el) => {
          const label = el.getAttribute("aria-label") ?? "";
          const comma = label.lastIndexOf(", ");
          return [label.slice(0, comma), Number(label.slice(comma + 2))] as const;
        }),
      );
    type El = ReturnType<typeof view.all>[number];
    const isCard = (el: El) => el.getAttribute("aria-label")?.startsWith("Work ") ?? false;
    const cards = (root: El | null | undefined) =>
      [...(root?.querySelectorAll('[role="button"]') ?? [])].filter(isCard);
    /** The feed's sections: title to how many cards it lists. */
    const sections = () =>
      new Map(
        view
          .all('[role="heading"]')
          .filter((el) => ["Needs you", "Stuck", "Running", "Queued", "Done"].includes(el.textContent ?? ""))
          .map((el) => [el.textContent ?? "", cards(el.parentElement?.parentElement).length] as const),
      );
    const all = chips();
    // Needs you: the two at your gate and the one only you may start; stuck and quiet work are watched (A1).
    expect([...all]).toEqual([
      ["All", 9],
      ["Needs you", 3],
      ["Stuck", 1],
      ["Running", 2],
      ["Queued", 2],
      ["Done", 1],
    ]);
    // In the All view, each section chip counts its section, Stuck's included.
    const listed = sections();
    expect([...listed]).toEqual([
      ["Needs you", 3],
      ["Stuck", 1],
      ["Running", 2],
      ["Queued", 2],
      ["Done", 1],
    ]);
    for (const title of ["Needs you", "Stuck", "Running", "Queued", "Done"])
      expect([title, all.get(title)]).toEqual([title, listed.get(title)]);
    expect(
      ["Needs you", "Stuck", "Running", "Queued", "Done"].reduce((sum, title) => sum + (all.get(title) ?? 0), 0),
    ).toBe(all.get("All") ?? -1);
    // Every chip, All included, shows as many cards as it counts.
    for (const [title, count] of all) {
      await view.press(view.byLabel(`${title}, ${count}`));
      expect(view.pressed(`${title}, ${count}`)).toBe("true");
      expect([title, view.all('[role="button"]').filter(isCard).length]).toEqual([title, count]);
    }
  });

  test("the Needs you chip and each initiative's count are needs.list's: asks included, as the header says (BRO-3001)", async () => {
    workspaceNow = [
      {
        ...decisionFixture(),
        id: "W1",
        headline: "Ship the hawthorne cut?",
        blocking: true,
        waiting: true,
        initiative: "hawthorne",
      },
    ];
    const view = await mount(surface(false));
    // needs.list: Work a and Work g at your gate, and the ask: 3, the header's number.
    for (let tries = 0; tries < 100 && !view.byLabel("Feed, 3 need you"); tries += 1) await settle(20);
    expect(needsNow().summary.total).toBe(3);
    await view.goto("List");
    for (let tries = 0; tries < 100 && !view.byLabel("Needs you, 3"); tries += 1) await settle(20);
    // The chip counts what its filter lists, the ask among them, not only the work.
    await view.press(view.byLabel("Needs you, 3"));
    expect(view.text()).toContain("Ship the hawthorne cut?");
    expect(view.text()).toContain("Work a");
    expect(view.text()).toContain("Work g");
    // hawthorne's own holds: Work a and the ask that names it.
    const hawthorne = view.all('[aria-label^="hawthorne, "]').map((el) => el.getAttribute("aria-label"));
    expect(hawthorne.some((label) => label?.endsWith("2 waiting on you"))).toBe(true);
  });

  test("a filter intent opens the feed, drops the scope, and checks its chip on the List", async () => {
    const view = await mount(surface(false));
    await view.goto("List");
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    await view.goto("Board");
    expect(view.viewNow()).toBe("Board");
    await act(async () => requestIntent({ kind: "filter", group: "review" }));
    await settle();
    expect(view.viewNow()).toBe("Feed");
    // On the Feed, what needs you is its first section, Needs you; the scope menu is back to all.
    expect(view.byLabel("Workspace: All workspaces")).not.toBeNull();
    const headings = view.all('[role="heading"]').map((el) => el.textContent);
    expect(headings.indexOf("Needs you")).toBeGreaterThan(-1);
    expect(headings.indexOf("Needs you")).toBeLessThan(headings.indexOf("Running"));
    await view.goto("List");
    expect(view.pressed("Needs you, 2")).toBe("true");
    expect(view.pressed("All work")).toBe("true");
    expect(view.text()).toContain("Work a");
    expect(view.text()).not.toContain("Work c");
  });

  test("the board bypasses the state filter, and choosing it clears the filter", async () => {
    const view = await mount(surface(false));
    await view.goto("List");
    await view.press(view.byLabel("Running, 1"));
    expect(view.text()).not.toContain("Work a");
    await view.goto("Board");
    // Stuck work (Work b) is a notice, Health's: it is in no tray; Done keeps only the last 24 h (Work f closed before).
    for (const title of ["Work a", "Work c", "Work d"]) expect(view.text()).toContain(title);
    expect(view.text()).not.toContain("Work f");
    expect(view.text()).not.toContain("Work b");
    await view.goto("List");
    expect(view.pressed("All, 6")).toBe("true");
    // A search typed in the compact feed while the board is the chosen view: J6's board is narrowed by the header's search.
    await view.goto("Board");
    await view.rerender(surface(true));
    await view.type(view.byLabel("Find work, ticket or branch"), "genesis");
    await view.rerender(surface(false));
    expect(view.viewNow()).toBe("Board");
    expect(view.text()).toContain("1 work item in scope");
    expect(view.text()).toContain("Work c");
    expect(view.text()).not.toContain("Work d");
  });

  test("a scope whose initiative leaves the list does not come back", async () => {
    const view = await mount(surface(false));
    await view.goto("List");
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    items = fixture().filter((item) => item.initiative !== "genesis");
    await view.refetch();
    items = fixture();
    await view.refetch();
    expect(view.pressed("All work")).toBe("true");
    expect(view.text()).toContain("Work a");
  });

  test("list rows pair the dot with words", async () => {
    items = [...fixture(), work("x", "canceled")];
    const view = await mount(surface(false));
    await view.goto("List");
    expect(view.text()).toContain("Canceled");
    expect(view.byLabel("Work x, Canceled, updated 12 minutes ago")).not.toBeNull();
    expect(view.byLabel("Work f, Done, genesis, updated 12 minutes ago")).not.toBeNull();
  });

  test("wide: Maestro's header has five tabs with needs.list's counts, and Work and Health hold their views", async () => {
    const view = await mount(surface(false));
    for (let tries = 0; tries < 100 && !view.byLabel("Feed, 2 need you"); tries += 1) await settle(20);
    // The Feed carries needs.list's total (BRO-3001): Work a and Work g at your gate. Work is the running work;
    // Health the watched rows the Feed lists (Work b is stuck).
    expect(view.tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Feed, 2 need you",
      "Decisions",
      "Work, 1 running",
      "Health, 1 watched item",
      "Initiatives",
    ]);
    await view.goto("Work");
    expect(view.all('[aria-label="Work views"] [role="radio"]').map((el) => el.getAttribute("aria-label"))).toEqual([
      "Board",
      "List",
      "History",
    ]);
    await view.goto("Health");
    expect(view.all('[aria-label="Health views"] [role="radio"]').map((el) => el.getAttribute("aria-label"))).toEqual([
      "Overview",
      "Fleet",
      "Timeline",
      "Loops",
    ]);
  });

  test("compact picks a view from one menu: the feed, History and the system views, in their groups", async () => {
    const view = await mount(surface(true));
    // No row of tabs to clip: one button names the view you are on.
    expect(view.tabs()).toEqual([]);
    expect(view.viewNow()).toBe("Feed");
    const picker = view.byLabel("View: Feed, 2 need you. Change view");
    expect(picker?.getAttribute("aria-expanded")).toBe("false");
    await view.press(picker);
    expect(view.all('[role="menuitem"]').map((item) => item.getAttribute("aria-label"))).toEqual([
      "Feed, 2 need you",
      "History",
      "Fleet",
      "Decisions",
      "Timeline",
      "Initiatives",
      "Loops",
    ]);
    expect(view.text()).toContain("WORKFeed2HistorySYSTEMFleetDecisionsTimelineInitiativesLoops");
    expect(view.byLabel("Feed, 2 need you")?.getAttribute("aria-current")).toBe("true");
    await view.press(view.byLabel("Feed, 2 need you"));
    expect(view.all('[role="menuitem"]')).toEqual([]);
    expect(view.text()).toContain("claude · own worktree");
    await view.goto("History");
    expect(view.viewNow()).toBe("History");
    await settle(50);
    expect(view.text()).toContain("You approved");
    await view.press(view.all('[aria-label^="You approved, Work a"]')[0]);
    // Compact pushes the work over the list, with a way back.
    expect(view.byLabel("Back to all work")).not.toBeNull();
  });
});

describe("the live signal", () => {
  const opacities = async (view: Awaited<ReturnType<typeof mount>>) => {
    const sample = () => view.rings().map((ring) => ring.style.opacity);
    const first = sample();
    await settle(200);
    return [first, sample()];
  };

  test("the running dot pulses, holds still under reduced motion, and chip dots never pulse", async () => {
    setReduced(false);
    const view = await mount(surface(true));
    expect(view.rings()).toHaveLength(1);
    const [before, after] = await opacities(view);
    expect(after).not.toEqual(before);
    await act(async () => setReduced(true));
    await settle();
    const [still, later] = await opacities(view);
    expect(later).toEqual(still);
  });

  test("a surface opened under reduced motion starts still", async () => {
    const view = await mount(surface(true));
    const [before, after] = await opacities(view);
    expect(view.rings()).toHaveLength(1);
    expect(after).toEqual(before);
  });

  test("reduced motion holds from the first frame, before AccessibilityInfo answers", async () => {
    // The async answer never lands: only the synchronous read can keep the dot still.
    const ask = spyOn(web.AccessibilityInfo, "isReduceMotionEnabled").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );
    try {
      const view = await mount(surface(true));
      const [before, after] = await opacities(view);
      expect(view.rings()).toHaveLength(1);
      expect(after).toEqual(before);
    } finally {
      ask.mockRestore();
    }
  });
});

describe("History", () => {
  test("groups by day, filters you or the loop, groups by work, and a row opens its work", async () => {
    const view = await mount(surface(false));
    await view.goto("History");
    await settle(50);
    expect(view.viewNow()).toBe("History");
    // History has its own chips; the state filter is not one of them.
    expect(view.byLabel("Needs you, 3")).toBeNull();
    const headers = () => view.all('[role="heading"]').map((el) => el.textContent);
    expect(headers()).toContain("Today");
    expect(headers()).toContain("Yesterday");
    expect(view.text()).toContain("You approved");
    expect(view.text()).toContain("Checks failed");

    await view.press(view.byLabel("You, 1"));
    expect(view.pressed("You, 1")).toBe("true");
    expect(view.text()).toContain("You approved");
    expect(view.text()).not.toContain("Turn finished");
    await view.press(view.byLabel("Autonomous, 2"));
    expect(view.text()).not.toContain("You approved");
    expect(view.text()).toContain("Turn finished");

    await view.press(view.byLabel("All, 3"));
    await view.press(view.byLabel("By work"));
    expect(headers()).toEqual(expect.arrayContaining(["Work a", "Work c", "Work b"]));
    expect(headers()).not.toContain("Yesterday");

    // A scope narrows History to its initiative.
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    expect(view.text()).toContain("Turn finished");
    expect(view.text()).not.toContain("You approved");
    await view.press(view.byLabel("All work"));

    const row = view.all('[aria-label^="You approved, Work a, hawthorne · core, You, Today at "]')[0];
    await view.press(row);
    expect(row?.getAttribute("aria-current")).toBe("true");
    expect(view.text()).toContain("Approve the branch");
  });
});

describe("work the fleet raised (BRO-2839)", () => {
  test("reads by its asks: no marker, the fleet's place, verbs explained, the run's words folded, repeats once", async () => {
    const view = await mount(
      <WorkDetail id="fleet-1" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    await settle(50);
    const text = view.text();
    // The displayed title is the source's text exactly (no U+2011); the flag token is kept from wrapping.
    expect(text).toContain("The core comparison (ctx doctor --compare) is not run in scope sri…");
    expect(text).not.toContain("\u2011");
    const flag = view.all("*").find((el) => el.children.length === 0 && el.textContent === "--compare");
    expect(flag?.getAttribute("style") ?? "").toContain("white-space: nowrap");
    expect(text).not.toContain("[fleet-reconcile");
    expect(text).toContain("fleet · sri");
    expect(text).toContain("tick 7 · batch 7-3");
    expect(text).not.toContain("fleet-reconcile-sri / maestro-asks");
    expect(text).toContain("observe");
    expect(text).toContain("move it aside, then register.");
    // The producer's lead says what is asked; it is shown whole, and no heading repeats it.
    expect(text).not.toContain("The fleet asks you");
    expect(text).not.toContain("```");
    // The producer's own verbs line, once.
    expect(text.split("Approve acknowledges them").length - 1).toBe(1);
    expect(text).toContain("The fleet has 1 question for you from scope sri");
    // The run's instructions are folded until asked for.
    const fold = view.byLabel("Instructions to the run");
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    expect(text).not.toContain("Change nothing and run no tools.");
    await view.press(fold);
    expect(view.byLabel("Instructions to the run")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.text()).toContain("Change nothing and run no tools.");
    // Three identical turn receipts read once, counted.
    expect(view.text().split("Yes, there are two now.").length - 1).toBe(1);
    expect(view.text()).toContain("\u00d73 · 3h\u20131h");
    expect(view.byLabel("Turn finished, 3 times in a row, from 3 hours ago to 1 hour ago")).not.toBeNull();
    // The fold's row is a phone-sized target.
    expect(view.byLabel("Instructions to the run")?.getAttribute("style") ?? "").toContain("min-height: 44px");
  });
});

describe("the work folder's files", () => {
  test("lists them; a file opens as text, a long one says it was cut, a binary one says why", async () => {
    const view = await mount(
      <WorkDetail id="a" theme={theme} compact={false} navigation={undefined} open={requestIntent} />,
    );
    // The detail loads first; the file list is its own read after that.
    await settle(50);
    expect(view.text()).toContain("Files");
    const file = (name: string) => view.all(`[aria-label^="${name}, "]`)[0];
    expect(file("_work.md")?.getAttribute("aria-label")).toBe("_work.md, 412 B, updated 5 minutes ago");
    await view.press(file("_work.md"));
    await settle(50);
    expect(file("_work.md")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.byLabel("Contents of _work.md")?.textContent).toContain("Store it on the Run record.");
    await view.press(file("run.log"));
    await settle(50);
    expect(view.byLabel("Contents of _work.md")).toBeNull();
    expect(view.text()).toContain("Showing the first 64 KB.");
    await view.press(file("image.png"));
    await settle(50);
    expect(view.text()).toContain("image.png is a binary file, so it is not shown.");
    expect(view.byLabel("Contents of image.png")).toBeNull();
  });
});

describe("the week", () => {
  test("seven bars, each with its day and hours in words; tapping shows where the hours went", async () => {
    const view = await mount(surface(true));
    const bars = view.all('[aria-label*=" unsupervised, "]');
    const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = [0, 1, 2, 3, 4, 5].map((index) => short[local(index - 6, 12).getDay()]).concat("Today");
    expect(bars.map((bar) => bar.textContent)).toEqual(
      ["0m", "1h", "4h", "0m", "30m", "2h", "1.3h"].map((value, index) => `${value}${days[index]}`),
    );
    expect(bars[6]?.getAttribute("aria-label")).toBe("Today: 1h 15m unsupervised, 1 look");
    const toggle = view.byLabel("This week, 8h 45m unsupervised. Show where the hours went");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(view.byLabel("hawthorne: 6h unsupervised this week")).toBeNull();

    await view.press(bars[2]);
    expect(view.byLabel("This week, 8h 45m unsupervised. Hide where the hours went")).not.toBeNull();
    expect(view.byLabel("hawthorne: 6h unsupervised this week")).not.toBeNull();
    expect(view.byLabel("No initiative: 2h 45m unsupervised this week")).not.toBeNull();

    await view.press(view.byLabel("Open History"));
    await settle(50);
    expect(view.viewNow()).toBe("History");
    expect(view.text()).toContain("You approved");
  });
});

describe("the loop", () => {
  const minutesAhead = (minutes: number) => new Date(Date.now() + minutes * 60_000 - 1_000).toISOString();
  const rows = (view: Awaited<ReturnType<typeof mount>>) => view.all('[aria-label^="Wake, "]');

  test("the header says when it wakes next; the panel says how often, and lists the wakes newest first", async () => {
    loopState = {
      minutes: 15,
      nextAt: minutesAhead(12),
      ticking: false,
      recent: [
        wakeEntry("w2", 3, {
          cause: "manual",
          narrative: ["Woke because you asked.", "Did:", "  Started Cache the Rust build in CI."],
        }),
        wakeEntry("w1", 18, {
          narrative: [
            "Woke on a scheduled check.",
            "Did nothing new this tick.",
            "Left alone:",
            "  Bypass: Start it yourself: it runs without permission prompts.",
          ],
        }),
      ],
    };
    const view = await mount(surface(true));
    const control = view.byLabel("Next wake in 12 min. Show the loop");
    expect(control?.getAttribute("aria-expanded")).toBe("false");
    expect(view.text()).not.toContain("Recent wakes");
    await view.press(control);
    expect(view.byLabel("Next wake in 12 min. Hide the loop")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.text()).toContain("The loop wakes every 15 minutes.");
    const [first, second] = rows(view);
    expect(first?.getAttribute("aria-label")).toMatch(/^Wake, Today at \d\d:\d\d, you asked$/);
    expect(first?.textContent).toContain("Started Cache the Rust build in CI.");
    // The cause is the row's header: the narrative's own "Woke ..." line is not repeated under it.
    expect(first?.textContent).not.toContain("Woke because you asked.");
    expect(second?.getAttribute("aria-label")).toMatch(/, on schedule$/);
    expect(second?.textContent).toContain("Bypass: Start it yourself: it runs without permission prompts.");
    // Closing it takes the panel away; polling goes on only while the control is mounted.
    await view.press(view.byLabel("Close the loop"));
    expect(view.text()).not.toContain("Recent wakes");
  });

  test("Wake now asks for a wake and shows it on top", async () => {
    loopState = { ...loopOff(), minutes: 30, nextAt: minutesAhead(20), recent: [wakeEntry("w1", 18)] };
    nextWake = () =>
      wakeEntry("w-now", 0, {
        cause: "manual",
        narrative: ["Woke because you asked.", "Did:", "  Started Persist the cart across devices."],
      });
    const view = await mount(surface(true));
    await view.press(view.byLabel("Next wake in 20 min. Show the loop"));
    await view.press(view.byLabel("Wake now"));
    expect(calls.filter((call) => call.method === "loop.wake")).toHaveLength(1);
    const [first, second] = rows(view);
    expect(first?.getAttribute("aria-label")).toMatch(/, you asked$/);
    expect(first?.textContent).toContain("Started Persist the cart across devices.");
    expect(second?.getAttribute("aria-label")).toMatch(/, on schedule$/);
    expect(view.all('[role="alert"]')).toHaveLength(0);
  });

  test("a wake that was skipped says why", async () => {
    loopState = { ...loopOff(), minutes: 15, nextAt: minutesAhead(5), ticking: true };
    nextWake = () =>
      wakeEntry("w-skip", 0, {
        cause: "manual",
        skipped: "another check was already running",
        narrative: ["Woke because you asked.", "Skipped: another check was already running."],
      });
    const view = await mount(surface(true));
    await view.press(view.byLabel("Waking…. Show the loop"));
    await view.press(view.byLabel("Wake now"));
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toEqual([
      "Not woken: another check was already running.",
    ]);
  });

  test("off and never woken: it says so, and says where its period is set", async () => {
    const view = await mount(surface(true));
    await view.press(view.byLabel("Loop off. Show the loop"));
    expect(view.text()).toContain("The loop is off.");
    expect(view.text()).toContain("No wakes yet.");
    expect(view.text()).toContain("Its period is set in Settings.");
    expect(view.byLabel("Open Settings")).toBeNull();
  });

  test("with Settings linked, the panel opens them", async () => {
    let opened = 0;
    const unlink = linkSettings(() => {
      opened += 1;
    });
    try {
      const view = await mount(surface(true));
      await view.press(view.byLabel("Loop off. Show the loop"));
      await view.press(view.byLabel("Open Settings"));
      expect(opened).toBe(1);
    } finally {
      unlink();
    }
  });
});

describe("the Queued hint", () => {
  const LOOP_HINT = "Started by you, a lane or the conductor, never the loop";
  const YOURS_HINT = "Ready when you dispatch it";

  for (const [on, shown, hidden] of [
    [false, YOURS_HINT, LOOP_HINT],
    [true, LOOP_HINT, YOURS_HINT],
  ] as const) {
    test(`with the loop ${on ? "on" : "off"}, the feed and the list say "${shown}", and the board says who starts it`, async () => {
      if (on) loopState = { ...loopOff(), minutes: 15, nextAt: new Date(Date.now() + 9 * 60_000).toISOString() };
      const view = await mount(surface(false));
      for (const name of ["Feed", "List"]) {
        await view.goto(name);
        expect(view.text()).toContain(shown);
        expect(view.text()).not.toContain(hidden);
      }
      // J6's tray says who starts it, which is true whether or not the loop is on: it never does (A8).
      await view.goto("Board");
      expect(view.text()).toContain("you or a lane start these");
      expect(view.text()).not.toContain(hidden);
    });
  }
});

describe("J1, the Feed home on the desktop (BRO-3035)", () => {
  const panel = (view: Awaited<ReturnType<typeof mount>>) => view.all('[data-testid="inspector-panel"]')[0];
  const holds = (view: Awaited<ReturnType<typeof mount>>) =>
    view.all('[data-testid^="hold-"]').map((el) => el.getAttribute("data-testid"));
  const until = async (ok: () => boolean) => {
    for (let tries = 0; tries < 150 && !ok(); tries += 1) await settle(20);
  };
  const press = (name: string, init: { metaKey?: boolean; repeat?: boolean } = {}, target?: unknown) =>
    step(generation, () => {
      const at = (target ?? win.document.body) as unknown as { dispatchEvent(event: unknown): boolean };
      at.dispatchEvent(new win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
    }).then(() => settle(30));

  test("the home is the Feed tab: holds as cards, the four tiles, the scope bar, no rail until there is something to say", async () => {
    const view = await mount(surface(false));
    await until(() => holds(view).length === 2);
    expect(holds(view)).toEqual(["hold-work:a", "hold-work:g"]);
    // Four tiles at most (JE): Needs you, Running, Handled today, Unsupervised today.
    const tiles = view.all('[data-testid^="glance-tile-"]');
    expect(tiles).toHaveLength(4);
    expect(tiles.map((tile) => tile.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "Needs you",
      "Running",
      "Handled today",
      "Unsupervised today",
    ]);
    // The scope bar's chips are needs.list's kinds, and the first says the total.
    expect(view.byLabel("All")).not.toBeNull();
    expect(view.byLabel("2 approvals")).not.toBeNull();
    // Running work wears the Undertow; a hold never does (B1).
    expect(view.byLabel("Running: Work c")).not.toBeNull();
  });

  test("a card opens the inspector from the right, lit in the stream; J and K walk the holds; Esc closes it", async () => {
    const view = await mount(surface(false));
    await until(() => holds(view).length === 2);
    expect(panel(view)).toBeUndefined();
    await view.press(view.byLabel("Approval: Work a"));
    await until(() => panel(view) !== undefined);
    expect(panel(view)?.textContent).toContain("Work a");
    expect(view.byLabel("Approval: Work a")?.getAttribute("aria-current")).toBe("true");
    // J walks to the next hold, K back: one hold selected at a time. Keys are Maestro's inside its screen.
    const inside = view.byLabel("Approval: Work a");
    await press("j", {}, inside);
    expect(panel(view)?.textContent).toContain("Work g");
    expect(view.byLabel("Approval: Work g")?.getAttribute("aria-current")).toBe("true");
    expect(view.byLabel("Approval: Work a")?.getAttribute("aria-current")).toBe("false");
    await press("k", {}, inside);
    expect(panel(view)?.textContent).toContain("Work a");
    // From the page's body or from Paseo's own chrome they are not.
    await press("j");
    const chrome = win.document.createElement("button");
    win.document.body.appendChild(chrome);
    await press("j", {}, chrome);
    chrome.remove();
    expect(panel(view)?.textContent).toContain("Work a");
    // Esc from Paseo's own chrome (outside Maestro's screen) is not Maestro's: the inspector stays.
    const outside = win.document.createElement("button");
    win.document.body.appendChild(outside);
    await press("Escape", {}, outside);
    expect(panel(view)).toBeDefined();
    outside.remove();
    // Esc closes it.
    await press("Escape");
    await until(() => panel(view) === undefined);
    expect(panel(view)).toBeUndefined();
    // A key typed in the search keeps its own meaning: J there is a letter, not a step.
    await view.press(view.byLabel("Approval: Work a"));
    await until(() => panel(view) !== undefined);
    await press("j", {}, view.byLabel("Search work, ticket or branch"));
    expect(panel(view)?.textContent).toContain("Work a");
  });

  test("opening on params.hold opens that hold's inspector (BRO-3033 fact 2); a hold already answered says so", async () => {
    const view = await mount(surface(false, { hold: "work:g" }));
    await until(() => panel(view) !== undefined);
    expect(panel(view)?.textContent).toContain("Work g");
    expect(view.byLabel("Approval: Work g")?.getAttribute("aria-current")).toBe("true");
    const gone = await mount(surface(false, { hold: "work:answered" }));
    await until(() => gone.text().includes("no longer waiting on you"));
    expect(gone.text()).toContain("That hold is no longer waiting on you");
    expect(panel(gone)).toBeUndefined();
  });

  test("a hold opened from a push is acted on once: another tab and back does not reopen it", async () => {
    const view = await mount(surface(false, { hold: "work:g" }));
    await until(() => panel(view) !== undefined);
    await press("Escape");
    await until(() => panel(view) === undefined);
    await view.goto("Decisions");
    await view.goto("Feed");
    await settle(60);
    expect(panel(view)).toBeUndefined();
  });

  test("work that holds nothing opens in the Feed's inspector from an intent, not into a pane that is not there", async () => {
    const view = await mount(surface(false));
    await until(() => holds(view).length === 2);
    await step(generation, () => requestIntent({ kind: "select", id: "d" }));
    await until(() => panel(view) !== undefined);
    expect(panel(view)?.textContent).toContain("Work d");
  });

  test("the Needs you tile opens the first hold even under a chip that hides it", async () => {
    const view = await mount(surface(false));
    await until(() => holds(view).length === 2);
    await view.press(view.byLabel("1 health"));
    expect(holds(view)).toHaveLength(0);
    await view.press(view.all('[aria-label^="Needs you, 2, holds"]')[0]);
    await until(() => panel(view) !== undefined);
    expect(panel(view)?.textContent).toContain("Work a");
    expect(holds(view)).toHaveLength(2);
  });

  test("the counts are one number: the header tab, the tile, the section and needs.list's total", async () => {
    const view = await mount(surface(false));
    await until(() => holds(view).length === 2);
    const total = needsNow().summary.total;
    expect(total).toBe(2);
    expect(view.byLabel(`Feed, ${total} need you`)).not.toBeNull();
    expect(view.all(`[aria-label^="Needs you, ${total}, holds"]`)).toHaveLength(1);
    expect(holds(view)).toHaveLength(total);
    expect(view.byLabel(`${total} approvals`)).not.toBeNull();
    // A kind chip narrows the section, never a tile or a tab.
    await view.press(view.byLabel("2 approvals"));
    expect(holds(view)).toHaveLength(total);
    await view.press(view.byLabel("1 health"));
    expect(holds(view)).toHaveLength(0);
    expect(view.byLabel(`Feed, ${total} need you`)).not.toBeNull();
    expect(view.all(`[aria-label^="Needs you, ${total}, holds"]`)).toHaveLength(1);
  });

  test("Allow goes through the verbs adapter, and the toast counts down with Undo for eight seconds (B4)", async () => {
    const view = await mount(surface(false, { hold: "work:g" }));
    await until(() => panel(view) !== undefined);
    calls.length = 0;
    await view.press(view.all('[data-testid="inspector-bar"] [aria-label="Allow"]')[0]);
    await until(() => calls.some((call) => call.method === "approval.decide"));
    // One exact action, and the prompt it names: never a verdict on the work, and never a call on Paseo itself.
    expect(calls.filter((call) => call.method === "approval.decide").map((call) => call.input)).toEqual([
      { key: "work:g", allow: true, action: "Run a command: git push", requestId: "req-g" },
    ]);
    expect(calls.some((call) => call.method === "work.verdict")).toBe(false);
    const toast = view.all('[data-testid="undo-toast"]')[0];
    expect(toast?.textContent).toContain("Allowed");
    // The window is UNDO_MS (8 s): the toast counts down to when it applies.
    expect(toast?.textContent).toMatch(/applies in [78] s/);
    await view.press(view.all('[aria-label^="Undo: "]')[0]);
    await until(() => calls.some((call) => call.method === "verb.undo"));
    expect(calls.filter((call) => call.method === "verb.undo").map((call) => call.input)).toEqual([{ receipt: "r-1" }]);
  });

  test("⌘↵ allows only from inside Maestro's screen, once: the body and Paseo's chrome do nothing, a held key is ignored, two at once send one", async () => {
    const view = await mount(surface(false, { hold: "work:g" }));
    await until(() => panel(view) !== undefined);
    const verdicts = () => calls.filter((call) => call.method === "approval.decide").length;
    calls.length = 0;
    await press("Enter", { metaKey: true });
    const chrome = win.document.createElement("button");
    win.document.body.appendChild(chrome);
    await press("Enter", { metaKey: true }, chrome);
    chrome.remove();
    expect(verdicts()).toBe(0);
    const inside = panel(view);
    await press("Enter", { metaKey: true, repeat: true }, inside);
    expect(verdicts()).toBe(0);
    // Two presses in one frame: the second finds the hold still being decided.
    await step(generation, () => {
      for (let n = 0; n < 2; n += 1)
        (inside as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
          new win.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
        );
    });
    await settle(60);
    expect(verdicts()).toBe(1);
  });

  test("Allow from a card is not sent twice while the first is being decided", async () => {
    const view = await mount(surface(false));
    await until(() => holds(view).length === 2);
    calls.length = 0;
    const allow = view.all('[data-testid="hold-work:g"] [aria-label="Allow"]')[0];
    await step(generation, () => {
      (allow as unknown as { click(): void }).click();
      (allow as unknown as { click(): void }).click();
    });
    await settle(60);
    expect(calls.filter((call) => call.method === "approval.decide")).toHaveLength(1);
  });

  test("the Needs you tile opens the first hold you can see: a workspace that hides the first does not select it", async () => {
    const view = await mount(surface(false));
    await until(() => holds(view).length === 2);
    const rows = needsNow().rows;
    const second = rows[1];
    await view.press(view.byLabel("Workspace: All workspaces"));
    await view.press(view.all('[role="menuitemradio"]').find((el) => el.getAttribute("aria-label") === second.scope));
    expect(holds(view)).toEqual(rows.filter((row) => row.scope === second.scope).map((row) => `hold-${row.key}`));
    await view.press(view.all('[aria-label^="Needs you, 2, holds"]')[0]);
    await until(() => panel(view) !== undefined);
    expect(panel(view)?.textContent).toContain(second.title);
  });

  test("a hold card keeps the changed line the old Feed card had, from the client state", async () => {
    const view = await mount(surface(false), { state: diffState as unknown as PluginClientStateSource });
    await until(() => holds(view).length === 2);
    const card = view.all('[data-testid="hold-work:a"]')[0];
    expect(card?.textContent).toContain("+12 −3");
    expect(card?.querySelector('[aria-label="12 lines added, 3 removed"]')).not.toBeNull();
  });

  test("an owner step's card says why only you may start it", async () => {
    const yoursFlag = {
      kind: "yours" as const,
      reason: "Start it yourself: it runs without permission prompts.",
      at: new Date(Date.now() - 2 * 60_000).toISOString(),
    };
    items = [...fixture(), work("y", "proposed", { flag: yoursFlag })];
    const view = await mount(surface(false));
    await until(() => holds(view).includes("hold-work:y"));
    expect(view.all('[data-testid="hold-work:y"]')[0]?.textContent).toContain(yoursFlag.reason);
  });

  test("the presence pill opens P1: the three states, and it says choosing is not built yet", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("Presence: Present"));
    const text = view.text();
    expect(text).toContain("from signals");
    expect(text).toContain("Away");
    expect(text).toContain("reachable on the phone");
    expect(text).toContain("held for the morning digest");
    expect(text).toContain("until I change it");
    expect(text).toContain("BRO-2987");
    expect(view.all('[role="menuitemradio"]')).toHaveLength(3);
  });

  test("the workspace menu narrows the holds, never the counts; its holds are needs.list's rows by scope", async () => {
    const view = await mount(surface(false));
    await until(() => holds(view).length === 2);
    await view.press(view.byLabel("Workspace: All workspaces"));
    const options = view.all('[role="menuitemradio"]');
    const named = options.find((el) => el.getAttribute("aria-label") !== "All workspaces");
    expect(named).toBeDefined();
    const scope = named?.getAttribute("aria-label") ?? "";
    await view.press(named);
    const rows = needsNow().rows.filter((row) => row.scope === scope);
    expect(holds(view)).toEqual(rows.map((row) => `hold-${row.key}`));
    expect(view.byLabel(`Workspace: ${scope}`)).not.toBeNull();
    expect(view.byLabel(`Feed, ${needsNow().summary.total} need you`)).not.toBeNull();
  });

  test("the header's tabs open the views; the workspace menu is on the tabs it narrows (Feed, Decisions, Work)", async () => {
    const view = await mount(surface(false));
    expect(view.byLabel("Workspace: All workspaces")).not.toBeNull();
    await view.goto("Decisions");
    expect(view.byLabel("Workspace: All workspaces")).not.toBeNull();
    await view.goto("Initiatives");
    expect(view.byLabel("Workspace: All workspaces")).toBeNull();
    await view.goto("Feed");
    expect(view.byLabel("Workspace: All workspaces")).not.toBeNull();
    expect(view.tabs().filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  test("the wake chip says when the loop wakes next and opens the loop's panel", async () => {
    loopState = { ...loopOff(), minutes: 15, nextAt: new Date(Date.now() + 9 * 60_000 + 20_000).toISOString() };
    const view = await mount(surface(false));
    await until(() => view.byLabel("Next wake: 10 min. Show the loop") !== null);
    await view.press(view.byLabel("Next wake: 10 min. Show the loop"));
    expect(view.text()).toContain("Wake now");
  });
});

describe("J2–J4 in the Feed's inspector (BRO-3036)", () => {
  const panel = (view: Awaited<ReturnType<typeof mount>>) => view.all('[data-testid="inspector-panel"]')[0];
  const until = async (ok: () => boolean) => {
    for (let tries = 0; tries < 150 && !ok(); tries += 1) await settle(20);
  };
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
  const bar = (view: Awaited<ReturnType<typeof mount>>, label: string) =>
    view.all(`[data-testid="inspector-bar"] [aria-label="${label}"]`)[0];

  test("an ask answered from its inspector sends the option you chose and the words you typed, as one answer", async () => {
    workspaceNow = [
      { ...decisionFixture(), headline: "File or drop the follow-ups?", blocking: true, waiting: true, fallback: null },
    ];
    const view = await mount(surface(false));
    await until(() => view.byLabel("Ask: File or drop the follow-ups?") !== null);
    await view.press(view.byLabel("Ask: File or drop the follow-ups?"));
    await until(() => panel(view) !== undefined);
    const text = panel(view)?.textContent ?? "";
    // J3: the two tiles, the numbered answers, where it goes; the cost once, not under the title as well.
    expect(text).toContain("What waiting costsNone blocks a lane; untracked, a test gap stays invisible.");
    expect(text).toContain("Why youScheduling is yours.");
    expect(text).toContain("File all fourRecommended");
    // The recommended one is pre-chosen in the Feed (as J1 draws it): its number is on the primary.
    expect(bar(view, "Answer with 1")).toBeDefined();
    await view.press(view.all('[data-testid="inspector-panel"] [aria-label="File all four, recommended"]')[0]);
    await view.type(view.byLabel("Your words for File or drop the follow-ups?"), "After the release.");
    calls.length = 0;
    await view.press(bar(view, "Answer with 1"));
    await until(() => sent("ask.answer").length > 0);
    expect(sent("ask.answer")).toEqual([
      {
        where: { kind: "workspace", home: "/state/broomva/.control/asks" },
        ledger: "maestro-paseo-gaps.yaml",
        uid: null,
        id: "A10",
        hash: "0123456789abcdef",
        option: "ticket-all",
        note: "After the release.",
      },
    ]);
  });

  test("words typed without picking an option are sent alone: the recommendation the inspector starts on is not sent with them", async () => {
    workspaceNow = [
      { ...decisionFixture(), headline: "File or drop the follow-ups?", blocking: true, waiting: true, fallback: null },
    ];
    const view = await mount(surface(false));
    await until(() => view.byLabel("Ask: File or drop the follow-ups?") !== null);
    await view.press(view.byLabel("Ask: File or drop the follow-ups?"));
    await until(() => panel(view) !== undefined);
    await view.type(view.byLabel("Your words for File or drop the follow-ups?"), "Hold off until CI is green.");
    calls.length = 0;
    await view.press(bar(view, "Answer in your words"));
    await until(() => sent("ask.answer").length > 0);
    expect(sent("ask.answer")).toMatchObject([{ option: null, note: "Hold off until CI is green." }]);
  });

  test("your words alone answer an ask in your own words; an option that cannot be undone opens Decisions to confirm", async () => {
    workspaceNow = [{ ...decisionFixture(), headline: "File or drop?", blocking: true, waiting: true }];
    const view = await mount(surface(false));
    await until(() => view.byLabel("Ask: File or drop?") !== null);
    await view.press(view.byLabel("Ask: File or drop?"));
    await until(() => panel(view) !== undefined);
    // The irreversible option: its answer is never sent from here.
    await view.press(view.all('[data-testid="inspector-panel"] [aria-label="Drop all four, cannot be undone"]')[0]);
    calls.length = 0;
    await view.press(bar(view, "Answer with 2"));
    await settle(60);
    expect(sent("ask.answer")).toEqual([]);
  });

  test("stuck work is a notice: Cancel work… takes two presses, Unblock sends your prompt, and there is no next hold to walk to", async () => {
    const view = await mount(surface(false));
    await until(() => view.byLabel("Health: Work b") !== null);
    await view.press(view.byLabel("Health: Work b"));
    await until(() => panel(view) !== undefined);
    const text = panel(view)?.textContent ?? "";
    expect(text).toContain("Closes when");
    expect(text).toContain("Its session takes a turn again");
    expect(text).toContain("No Approve: a notice is a fact");
    // A notice is not a hold: J and K walk holds only.
    expect(view.all('[data-testid="inspector-bar"] [aria-label="Next hold"]')).toHaveLength(0);
    calls.length = 0;
    await view.press(bar(view, "Cancel work…"));
    expect(sent("work.cancel")).toEqual([]);
    expect(toasts.at(-1)).toContain("Press Cancel work… again");
    await view.type(view.byLabel("A prompt for the session of Work b"), "retry from the failing test");
    await view.press(bar(view, "Unblock with a prompt…"));
    await until(() => sent("work.unblock").length > 0);
    expect(sent("work.unblock")).toEqual([{ id: "b", note: "retry from the failing test" }]);
    // The second press on the same item, inside the window, cancels it.
    await view.press(bar(view, "Cancel work…"));
    await until(() => sent("work.cancel").length > 0);
    expect(sent("work.cancel")).toEqual([{ id: "b" }]);
  });
});

describe("J6 and J6b, Work as five trays (BRO-3036)", () => {
  const panel = (view: Awaited<ReturnType<typeof mount>>) => view.all('[data-testid="inspector-panel"]')[0];
  const lane = (view: Awaited<ReturnType<typeof mount>>, id: string) =>
    view.all(`[data-testid="lane-${id}"]`)[0]?.textContent ?? "";
  const until = async (ok: () => boolean) => {
    for (let tries = 0; tries < 150 && !ok(); tries += 1) await settle(20);
  };
  const quiet = {
    kind: "quiet" as const,
    reason: "Quiet for 808 minutes.",
    at: new Date(Date.now() - 808 * 60_000).toISOString(),
  };

  test("while needs.list cannot be read, the board says so and never draws an empty Needs you as the answer", async () => {
    needsFail = "socket closed";
    const view = await mount(surface(false));
    await until(() => view.text().includes("could not be read"));
    await view.goto("Board");
    await until(() => view.all('[data-testid="work-board"]').length > 0);
    expect(view.all('[data-testid="work-board"]')[0]?.textContent).toContain("What needs you could not be read");
  });

  test("five trays in order; Needs you is needs.list's rows, the number the header says; stuck work is in none", async () => {
    const view = await mount(surface(false));
    await until(() => view.byLabel("Feed, 2 need you") !== null);
    await view.goto("Board");
    const headings = view.all('[data-testid^="lane-"] [role="heading"]').map((el) => el.textContent);
    expect(headings).toEqual(["Queued", "Running", "Standing", "Needs you", "Done"]);
    expect(
      view.all('[data-testid^="work-card-"]').filter((el) => el.closest('[data-testid="lane-needs"]')),
    ).toHaveLength(needsNow().summary.total);
    expect(lane(view, "needs")).toContain("Work a");
    expect(view.text()).not.toContain("Work b");
    expect(view.text()).toContain("in scope · Done shows the last 24 h");
  });

  test("a quiet run is Standing, not Running: the Work tab's badge counts what is on a live turn", async () => {
    items = [...fixture(), work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet })];
    const view = await mount(surface(false));
    await until(() => view.byLabel("Work, 1 running") !== null);
    await view.goto("Board");
    expect(lane(view, "running")).toContain("Work c");
    expect(lane(view, "running")).not.toContain("Work z");
    expect(lane(view, "standing")).toContain("Work z");
    expect(lane(view, "standing")).toContain("→ in Health");
  });

  test("a card opens J1's inspector from the right over Needs you and Done; the board keeps its trays; Esc sends it back", async () => {
    const view = await mount(surface(false));
    await view.goto("Board");
    await until(() => view.byLabel("Needs you: Work a") !== null);
    expect(panel(view)).toBeUndefined();
    await view.press(view.byLabel("Needs you: Work a"));
    await until(() => panel(view) !== undefined);
    expect(panel(view)?.textContent).toContain("Work a");
    expect(view.byLabel("Needs you: Work a")?.getAttribute("aria-current")).toBe("true");
    // The trays to its left stay readable: nothing reflowed.
    expect(lane(view, "queued")).toContain("Work d");
    expect(lane(view, "running")).toContain("Work c");
    await step(generation, () =>
      (
        win.document.body.querySelector('[data-testid="work-board"]') as unknown as {
          dispatchEvent(e: unknown): boolean;
        }
      ).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    );
    await until(() => panel(view) === undefined);
    expect(panel(view)).toBeUndefined();
  });

  test("an approval is decided on the board as in the Feed: the same verb, the same eight seconds", async () => {
    const view = await mount(surface(false));
    await view.goto("Board");
    await until(() => view.byLabel("Needs you: Work g") !== null);
    await view.press(view.byLabel("Needs you: Work g"));
    await until(() => panel(view) !== undefined);
    calls.length = 0;
    await view.press(view.all('[data-testid="inspector-bar"] [aria-label="Allow"]')[0]);
    await until(() => calls.some((call) => call.method === "approval.decide"));
    // The one exact action and the prompt it names, as the Feed sends them: never a verdict on the work.
    expect(calls.filter((call) => call.method === "approval.decide").map((call) => call.input)).toEqual([
      { key: "work:g", allow: true, action: "Run a command: git push", requestId: "req-g" },
    ]);
    expect(calls.some((call) => call.method === "work.verdict")).toBe(false);
    expect(view.all('[data-testid="undo-toast"]')[0]?.textContent).toMatch(/Allowed.*applies in [78] s/);
  });

  test("the Initiative and Provider filters narrow the trays and the line that says how many are in scope", async () => {
    const view = await mount(surface(false));
    await view.goto("Board");
    await until(() => view.byLabel("Initiative: any") !== null);
    const all = /(\d+) work items? in scope/.exec(view.text())?.[1];
    await view.press(view.byLabel("Initiative: any"));
    await view.press(view.all('[role="menuitemradio"]').find((el) => el.getAttribute("aria-label") === "genesis"));
    expect(view.byLabel("Initiative: genesis")).not.toBeNull();
    const narrowed = /(\d+) work items? in scope/.exec(view.text())?.[1];
    expect(Number(narrowed)).toBeLessThan(Number(all));
    expect(view.text()).toContain("Work c");
    expect(view.text()).not.toContain("Work d");
  });
});

describe("J7, Health (BRO-3036)", () => {
  const panel = (view: Awaited<ReturnType<typeof mount>>) => view.all('[data-testid="inspector-panel"]')[0];
  const until = async (ok: () => boolean) => {
    for (let tries = 0; tries < 150 && !ok(); tries += 1) await settle(20);
  };
  const quiet = {
    kind: "quiet" as const,
    reason: "Quiet for 808 minutes.",
    at: new Date(Date.now() - 808 * 60_000).toISOString(),
  };
  const notices = () =>
    noticesOf(
      {
        items,
        fleet: fleetNotices,
        timeline: timelineNotices,
        loops: loopNoticesNow,
        reviews: reviewsNow,
        snoozed: new Map<string, string>(),
      },
      Date.now(),
    );

  test("the verdict's count, the Health tab's badge and the list of open notices are notices.list's one number", async () => {
    items = [...fixture(), work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet })];
    const view = await mount(surface(false));
    await until(() => view.byLabel("Health, 2 watched items") !== null);
    await view.goto("Health");
    await until(() => view.text().includes("Open notices"));
    const total = notices().summary.total;
    expect(total).toBe(2);
    expect(view.text()).toContain(`${total} things need a look`);
    const heading = view.all('[role="heading"]').find((el) => el.textContent === "Open notices");
    expect(heading?.parentElement?.textContent).toBe(`Open notices${total}· each closes when its source does`);
    expect(view.all('[aria-label^="Notice: "]')).toHaveLength(total);
    expect(
      view
        .tabs()
        .find((tab) => tab.getAttribute("aria-label")?.startsWith("Health"))
        ?.getAttribute("aria-label"),
    ).toBe(`Health, ${total} watched items`);
  });

  test("each notice says what closes it, and stuck work opens in J4's inspector with its prompt field", async () => {
    const view = await mount(surface(false));
    await view.goto("Health");
    await until(() => view.byLabel("Notice: Work b") !== null);
    expect(view.text()).toContain("closes when its session takes a turn again");
    await view.press(view.byLabel("Notice: Work b"));
    await until(() => panel(view) !== undefined);
    expect(panel(view)?.textContent).toContain("Closes when");
    expect(view.byLabel("A prompt for the session of Work b")).not.toBeNull();
  });

  test("Snooze goes through the verb adapter: one receipt, the surface counts it down, and Undo takes it back", async () => {
    items = [...fixture(), work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet })];
    const view = await mount(surface(false));
    await view.goto("Health");
    await until(() => view.byLabel("Snooze 4h: Work z") !== null);
    calls.length = 0;
    await view.press(view.byLabel("Snooze 4h: Work z"));
    await until(() => calls.some((call) => call.method === "notice.snooze"));
    expect(calls.filter((call) => call.method === "notice.snooze").map((call) => call.input)).toEqual([
      { key: "quiet:z", hours: 4 },
    ]);
    await until(() => view.all('[role="button"][aria-label^="Undo"]').length > 0);
    expect(view.all('[role="button"][aria-label^="Undo"]').length).toBeGreaterThan(0);
  });

  test("two verbs inside their 8 s each keep an Undo: the toast holds one, the ledger strip holds every one", async () => {
    items = [
      ...fixture(),
      work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet }),
      work("y", "running", { worker: worker("y", "maestro/y-1"), phase: "working", flag: quiet }),
    ];
    const view = await mount(surface(false));
    await view.goto("Health");
    await until(() => view.byLabel("Snooze 4h: Work z") !== null && view.byLabel("Snooze 4h: Work y") !== null);
    await view.press(view.byLabel("Snooze 4h: Work z"));
    await until(() => pendingVerbs.length === 1);
    await view.press(view.byLabel("Snooze 4h: Work y"));
    await until(() => pendingVerbs.length === 2);
    await until(
      () =>
        view.byLabel("Undo: Snoozed quiet:z for 4 h") !== null &&
        view.byLabel("Undo: Snoozed quiet:y for 4 h") !== null,
    );
    expect(view.byLabel("Undo: Snoozed quiet:z for 4 h")).not.toBeNull();
    expect(view.byLabel("Undo: Snoozed quiet:y for 4 h")).not.toBeNull();
  });

  test("while work.list cannot be read, Health says so and never says All clear over the missing runs", async () => {
    workFail = "disk gone";
    const view = await mount(surface(false));
    await view.goto("Health");
    await until(() => view.text().includes("The work could not be read: disk gone"));
    expect(view.text()).toContain("The work could not be read: disk gone");
    // The verdict names the gap; with no notice listed it would read "Not all clear", never "All clear".
    expect(view.text()).toContain("Could not read the work");
  });

  test("a failed schedule is a row of the same list: its verb opens the Timeline, where its runs are", async () => {
    timelineNotices = [
      {
        id: "launchd:com.broomva.kg",
        kind: "launchd",
        name: "kg-compile",
        status: "failed",
        reason: "exit 1",
        since: new Date(Date.now() - 3 * H).toISOString(),
      },
    ];
    const view = await mount(surface(false));
    await view.goto("Health");
    await until(() => view.byLabel("Open log: kg-compile failed: exit 1") !== null);
    await view.press(view.byLabel("Open log: kg-compile failed: exit 1"));
    await until(() => view.text().includes("The past 24 h and the next 24 h"));
    expect(view.text()).toContain("The past 24 h and the next 24 h");
  });

  test("the four tiles say what they count: ticks, sessions, schedules, the conductor", async () => {
    const view = await mount(surface(false));
    await view.goto("Health");
    await until(() => view.text().includes("Fleet ticks · 24 h"));
    const text = view.text();
    for (const title of ["Fleet ticks · 24 h", "Sessions", "Schedules and loops", "Conductor and lanes"])
      expect(text).toContain(title);
    expect(text).toContain("Never starts work itself (A8)");
  });
});

describe("J8, Initiatives (BRO-3036)", () => {
  const panel = (view: Awaited<ReturnType<typeof mount>>) => view.all('[data-testid="inspector-panel"]')[0];
  const until = async (ok: () => boolean) => {
    for (let tries = 0; tries < 150 && !ok(); tries += 1) await settle(20);
  };
  const due = () => {
    reviewsNow = [
      {
        ...(initiativesNow.initiatives.find((entry) => entry.id === "mod-anything") as Initiative),
        stale: { kind: "overdue", date: "2026-10-01" },
      },
    ];
  };

  test("the Review due tile, its chip and the tab's badge are needs.list's reviews: one number, late first", async () => {
    due();
    const view = await mount(surface(false));
    await view.goto("Initiatives");
    await until(() => view.byLabel("Initiative: mod-anything skill, review 4 d late") !== null);
    const reviews = needsNow().rows.filter((row) => row.key.startsWith("review:")).length;
    expect(reviews).toBe(1);
    // The tile and its chip say the same number, and it is needs.list's.
    expect(view.all(`[aria-label^="Review due, ${reviews}, due"]`)).toHaveLength(1);
    expect(view.all('[role="radio"]').some((el) => el.getAttribute("aria-label") === `Review due, ${reviews}`)).toBe(
      true,
    );
    expect(
      view
        .tabs()
        .find((tab) => tab.getAttribute("aria-label")?.startsWith("Initiatives"))
        ?.getAttribute("aria-label"),
    ).toBe(`Initiatives, ${reviews} review is due`);
    // The late one is the first row.
    expect(view.all('[data-testid^="initiative-"]')[0]?.getAttribute("data-testid")).toBe("initiative-mod-anything");
  });

  test("a due review opens in the inspector with its three answers; Answer sends it through the adapter, once, with the date it read", async () => {
    due();
    const view = await mount(surface(false));
    await view.goto("Initiatives");
    await until(() => view.byLabel("Initiative: mod-anything skill, review 4 d late") !== null);
    await view.press(view.byLabel("Initiative: mod-anything skill, review 4 d late"));
    await until(() => panel(view) !== undefined);
    const text = panel(view)?.textContent ?? "";
    expect(text).toContain("Review mod-anything skill: keep, park or close?");
    for (const answer of ["Keep", "Park", "Close"]) expect(text).toContain(answer);
    // There is no Skip on a review; the primary names the option.
    expect(view.all('[data-testid="inspector-bar"] [aria-label="Skip"]')).toHaveLength(0);
    await view.press(view.all('[data-testid="inspector-panel"] [aria-label="Park"]')[0]);
    calls.length = 0;
    await view.press(view.all('[data-testid="inspector-bar"] [aria-label="Answer with 2"]')[0]);
    await until(() => calls.some((call) => call.method === "initiatives.review"));
    expect(calls.filter((call) => call.method === "initiatives.review").map((call) => call.input)).toEqual([
      { id: "mod-anything", date: "2026-10-01", answer: "park", note: "" },
    ]);
    expect(view.all('[data-testid="undo-toast"]')[0]?.textContent).toMatch(
      /Review of mod-anything: park.*applies in [78] s/,
    );
  });

  test("a row that is not due opens its card, where its links and ideas are; the Proposed chip lists the ideas", async () => {
    const view = await mount(surface(false));
    await view.goto("Initiatives");
    await until(
      () => view.all('[data-testid="initiative-fleet-autonomy"]').length > 0 || view.text().includes("Fleet autonomy"),
    );
    await view.press(view.all('[aria-label^="Initiative: Fleet autonomy"]')[0]);
    await until(() => view.text().includes("Show the ideas for") || view.text().includes("Next action"));
    expect(panel(view)).toBeUndefined();
    await view.press(view.all('[role="radio"]').find((el) => el.getAttribute("aria-label")?.startsWith("Proposed")));
    await until(() => view.text().includes("Build idea"));
    expect(view.text()).toContain("Build idea");
  });
});

describe("Settings", () => {
  const settingsScreen = () => (
    <MaestroSettings theme={theme} host={{ id: "h", label: "h" }} layout={{ compact: false, platform: "web" }} />
  );

  test("the loop's control carries its hint, the one sentence that says what the loop does", async () => {
    const view = await mount(settingsScreen());
    // The select the host draws: its label, its hint, then one button per choice.
    const control = view.byLabel("The loop: Off")?.parentElement;
    const parts = [...(control?.children ?? [])].map((el) => el.textContent);
    expect(parts.slice(0, 2)).toEqual(["The loop", LOOP_SETTINGS_HINT]);
    expect(LOOP_SETTINGS_HINT).toBe(
      "On a schedule, the loop flags quiet runs and acts on your answers; it never starts work, which waits for you, a lane or the conductor.",
    );
    expect(view.text().split(LOOP_SETTINGS_HINT)).toHaveLength(2);
  });

  test("the loop is a choice of off or a period, and Save sends the whole config back with it", async () => {
    const view = await mount(settingsScreen());
    expect(view.text()).toContain("it never starts work");
    expect(view.pressed("The loop: Off")).toBe("true");
    for (const label of ["Every 5 minutes", "Every 15 minutes", "Every 30 minutes", "Every 60 minutes"]) {
      expect(view.byLabel(`The loop: ${label}`)).not.toBeNull();
    }
    await view.press(view.byLabel("The loop: Every 15 minutes"));
    expect(view.pressed("The loop: Every 15 minutes")).toBe("true");
    await view.press(view.byLabel("Save settings"));
    expect(calls.filter((call) => call.method === "config.set").map((call) => call.input)).toEqual([
      { ...settingsFixture(), loopMinutes: 15 },
    ]);
  });

  test("a saved period that is none of the choices shows as itself, and turning it off saves null", async () => {
    settings = { ...settingsFixture(), loopMinutes: 45 };
    const view = await mount(settingsScreen());
    expect(view.pressed("The loop: Every 45 minutes")).toBe("true");
    await view.press(view.byLabel("The loop: Off"));
    await view.press(view.byLabel("Save settings"));
    expect(calls.filter((call) => call.method === "config.set").map((call) => call.input)).toEqual([
      { ...settingsFixture(), loopMinutes: null },
    ]);
  });
});

describe("the Fleet view", () => {
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
  const starting = (view: Awaited<ReturnType<typeof mount>>, label: string) =>
    view.all("[aria-label]").find((one) => one.getAttribute("aria-label")?.startsWith(label));

  test("opens on every scope: the verdict, a strip per scope, the KPI tiles, Needs you, the latest tick, the sessions", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    for (let tries = 0; tries < 100 && !view.text().includes("Would list 4 unmanaged"); tries += 1) await settle(20);
    // All reads each scope: the base read, then sri under its own key (Health's overview, opened on the way, asks the same).
    expect([...new Set(sent("fleet.get").map((input) => JSON.stringify(input)))]).toEqual([
      JSON.stringify({ ticks: 24 }),
      JSON.stringify({ scope: "sri", ticks: 24 }),
    ]);
    const text = view.text();
    // Every scope that is not well is named, the worst first, and the session that wants a look too.
    expect(text).toContain(
      "broomva missed its tick · 1 tick wants a look · 1 session wants a look · sri not scheduled",
    );
    expect(text).toContain("No tick for 3h: the last was tick 35. It runs every hour.");
    expect(text).toContain("Dry run · report only");
    // A cell per tick with its words, and the scope's missed cell last.
    expect(starting(view, "Tick 35, passed")).toBeDefined();
    expect(starting(view, "No tick: missed for 3h")).toBeDefined();
    // The tile is health: the missed tick. The ask is counted where it lives, at your gate (BRO-2908).
    expect(starting(view, "Health: 1, 1 scope whose tick wants a look")).toBeDefined();
    expect(starting(view, "Health: 1")?.getAttribute("aria-label")).toContain("Go to Health");
    expect(text).toContain("Counted where they live");
    // The band says what it counts: the tick, not the ask counted at your gate.
    expect(text).toContain("Wants a look: 1 tick.");
    expect(starting(view, "Attention: 1, 1 failed")).toBeDefined();
    expect(starting(view, "Running: 1")).toBeDefined();
    expect(starting(view, "Failed: 1")).toBeDefined();
    expect(starting(view, "Out of scope: 1, 1 unplaced")).toBeDefined();
    expect(text).toContain("Tick missed");
    // The ask's first sentence is its title, its tag in plain words; tick numbers wait in Details.
    expect(text).toContain("13 Paseo records are not archived and have no live process");
    expect(text).toContain("Count check");
    expect(text).not.toContain("since tick 2");
    expect(text).toContain("Would list sri-sti-2761-rce in its report — nothing is done");
    expect(text).toContain("Would list 4 unmanaged sessions in its report — nothing is done");
    expect(text).toContain("Teach the fleet");
    expect(text).toContain("Your verdict teaches the fleet; it changes nothing now: the fleet runs dry.");
    expect(text).not.toContain("phase 3");
    // The latest tick: its steps, each with what it said, else what the report counts.
    expect(text).toContain("Latest tick · broomva");
    expect(text).toContain("nothing to recover");
    // The sessions in scope, each with what the fleet would do.
    expect(text).toContain("hanging-pug");
    expect(text).toContain("Sessions in scope");
    expect(text).toContain("1 session out of scope is hidden (1 unplaced).");
    expect(text).not.toContain("stoic-goat");
    // The workspace's decisions are the Decisions tab's (its badge reads them): none of them here.
    expect(text).not.toContain("Workspace decisions");
    expect(text).not.toContain("Your workspace's asks");
    // The ask is answered in the work the fleet raised: opened, not copied.
    await view.press(view.byLabel("Open the fleet's work for ask a1: Work a"));
    expect(view.text()).toContain("Approve the branch");
  });

  test("only the first card's verb is filled; Agree and Disagree are never primary", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    // The verb's painted surface is its first child (Press): filled is the theme's accent, #5480c7.
    const filled = (label: string) => {
      const target = view.byLabel(label) as unknown as { firstElementChild: { style: { backgroundColor: string } } };
      return target.firstElementChild.style.backgroundColor.includes("84, 128, 199");
    };
    // The first card is the missed tick: its Open log is the one filled verb.
    expect(filled("Open tick 35's log, broomva")).toBe(true);
    expect(filled("Agree: report, de2dd335 sri-sti-2761-rce")).toBe(false);
    expect(filled("Open the fleet's work for ask a1: Work a")).toBe(false);
  });

  test("Agree records your verdict; Disagree asks why first, and sends the note", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    // The refetch that follows is held: what the card says next comes from the host's answer alone.
    let release = () => {};
    fleetHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await view.press(view.byLabel("Agree: report, de2dd335 sri-sti-2761-rce"));
    expect(sent("fleet.review")).toEqual([
      { scope: "broomva", keys: ["session:de2dd335:4:aaaa1111"], verdict: "accept", note: "" },
    ]);
    // Said at once, from the host's answer: no button left reading Agree for a second tap, the card still in place.
    expect(view.text()).toContain("You agreed just now");
    expect(view.byLabel("Agree: report, de2dd335 sri-sti-2761-rce")?.getAttribute("aria-disabled")).toBe("true");
    fleetHeld = null;
    release();
    await settle(30);

    // A verdict older than an hour is behind Show reviewed.
    expect(view.byLabel("Disagree: report only, 5dd4ed18 worried-walrus")).toBeNull();
    await view.press(view.byLabel("Show reviewed"));
    await view.press(view.byLabel("Disagree: report only, 5dd4ed18 worried-walrus"));
    expect(sent("fleet.review")).toHaveLength(1);
    await view.type(view.byLabel("Why disagree: report only, 5dd4ed18 worried-walrus"), "Unmanaged sessions are mine");
    await view.press(view.byLabel("Confirm disagree: report only, 5dd4ed18 worried-walrus"));
    expect(sent("fleet.review").at(-1)).toEqual({
      scope: "broomva",
      keys: ["session:5dd4ed18:10:bbbb2222"],
      verdict: "reject",
      note: "Unmanaged sessions are mine",
    });
    await view.refetch();
    expect(view.text()).toContain("You disagreed just now: Unmanaged sessions are mine");
  });

  test("a scope in the scope control reads that scope", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await view.press(view.byLabel("sri, Not scheduled, 1 proposal to review"));
    expect(sent("fleet.get").at(-1)).toEqual({ scope: "sri", ticks: 24 });
    expect(view.text()).toContain("sri ticks only when run by hand.");
    expect(view.text()).not.toContain("hanging-pug");
    await view.press(view.byLabel("All scopes"));
    expect(view.text()).toContain("hanging-pug");
  });

  test("one class and one action across sessions is one card: one verdict writes every session's key", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await view.press(view.byLabel("sri, Not scheduled, 1 proposal to review"));
    expect(view.text()).toContain("Would list 4 unmanaged sessions in its report — nothing is done");
    // Every session the verdict covers, by name, before you agree.
    expect(view.text()).toContain("sri-aaaa1111 · sri-bbbb2222 · sri-cccc3333 · sri-dddd4444");
    await view.press(view.byLabel("See the sessions: report only"));
    expect(view.byLabel("Hide the sessions: report only")).not.toBeNull();
    // The refetch after is held: the card and the scope's label say it from the host's answer alone.
    let release = () => {};
    fleetHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await view.press(view.byLabel("Agree: report only, 4 sessions"));
    expect(sent("fleet.review").at(-1)).toEqual({
      scope: "sri",
      keys: [
        "session:aaaa1111:10:feedface",
        "session:bbbb2222:10:feedface",
        "session:cccc3333:10:feedface",
        "session:dddd4444:10:feedface",
      ],
      verdict: "accept",
      note: "",
    });
    expect(view.text()).toContain("You agreed just now");
    expect(view.byLabel("sri, Not scheduled")).not.toBeNull();
    fleetHeld = null;
    release();
    await settle(30);
  });

  test("Disagree's note closes on the host's answer, while the refetch after is still on its way", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    let release = () => {};
    fleetHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await view.press(view.byLabel("Disagree: report, de2dd335 sri-sti-2761-rce"));
    await view.press(view.byLabel("Confirm disagree: report, de2dd335 sri-sti-2761-rce"));
    expect(view.byLabel("Why disagree: report, de2dd335 sri-sti-2761-rce")).toBeNull();
    expect(view.text()).toContain("You disagreed just now");
    fleetHeld = null;
    release();
    await settle(30);
  });

  test("a KPI tile filters the roster, and pressed again shows every session in scope", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    await view.press(starting(view, "Running: 1"));
    expect(starting(view, "Running: 1")?.getAttribute("aria-pressed")).toBe("true");
    expect(starting(view, "hanging-pug, running")).toBeDefined();
    expect(starting(view, "sri-sti-2761-rce, failed")).toBeUndefined();
    await view.press(starting(view, "Running: 1"));
    expect(starting(view, "sri-sti-2761-rce, failed")).toBeDefined();
    // Out of scope shows the sessions no scope holds; the footer brings them back.
    await view.press(view.byLabel("Show them"));
    expect(view.text()).toContain("stoic-goat");
    expect(view.text()).toContain("Sessions out of scope");
  });

  test("a session row opens the inspector: facts, what the fleet saw, its verdict, evidence and verbs", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    await view.press(starting(view, "hanging-pug, running"));
    const text = view.text();
    expect(text).toContain("~/.paseo/worktrees/0t10/hanging-pug");
    expect(text).toContain("What the fleet saw, last 2 ticks");
    expect(starting(view, "Tick 35: class 5")).toBeDefined();
    expect(starting(view, "Tick 34: not listed")).toBeDefined();
    expect(text).toContain("Listed at 1 of the last 2 ticks: running on 1.");
    // The strip's legend tells running from not listed.
    expect(starting(view, "Legend")).toBeDefined();
    expect(text).toContain("The fleet would do nothing");
    expect(text).toContain("It was working, last active 33 s before the report.");
    // The raw evidence waits in Details.
    expect(text).not.toContain("evidence: busy; last activity 33s ago");
    await view.press(view.byLabel("Show the report's raw evidence for hanging-pug"));
    expect(view.text()).toContain("evidence: busy; last activity 33s ago");
    await view.press(view.byLabel("Adopt hanging-pug into Maestro"));
    expect(sent("work.adopt")).toEqual([{ agentId: "agent-pug", title: "hanging-pug" }]);
    await view.press(view.byLabel("Close the inspector"));
    expect(view.text()).not.toContain("What the fleet saw");
    // A session with a proposal takes your verdict in the inspector too.
    await view.press(starting(view, "sri-sti-2761-rce, failed"));
    expect(view.text()).toContain("The fleet would: list it in the report");
    expect(view.text()).toContain("Report: the fleet lists the session in its tick report; nothing is done to it.");
    await view.press(view.byLabel("Agree: sri-sti-2761-rce"));
    expect(sent("fleet.review").at(-1)).toEqual({
      scope: "broomva",
      keys: ["session:de2dd335:4:aaaa1111"],
      verdict: "accept",
      note: "",
    });
  });

  test("the row's ⋯ menu opens it in Paseo, adopts it, or copies its id", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    await view.press(view.byLabel("More for hanging-pug"));
    expect(view.all('[role="menuitem"]').map((item) => item.getAttribute("aria-label"))).toEqual([
      "Open in Paseo",
      "Adopt into Maestro",
      "Copy session id",
    ]);
    await view.press(view.byLabel("Open in Paseo"));
    expect(opened).toEqual(["agent-pug"]);
    expect(view.all('[role="menuitem"]')).toEqual([]);
    // A session that is not a Paseo agent can only be copied.
    await view.press(view.byLabel("More for worried-walrus"));
    expect(view.all('[role="menuitem"]').map((item) => item.getAttribute("aria-label"))).toEqual(["Copy session id"]);
  });

  test("a missed tick shows above the work, and opens the Fleet view at its scope", async () => {
    fleetNotices = [
      {
        scope: "broomva",
        status: "missed",
        reason: "No tick since tick 35. It runs every hour.",
        since: new Date(Date.now() - 3 * H).toISOString(),
      },
    ];
    const view = await mount(surface(false));
    // On the Feed home it is a watched row under Health (A1), never a hold.
    expect(view.text()).toContain("fleet-reconcile broomva: tick missed");
    expect(view.text()).toContain("No tick since tick 35. It runs every hour.");
    await view.press(view.byLabel("Health: fleet-reconcile broomva: tick missed"));
    expect(view.viewNow()).toBe("Fleet");
    expect(sent("fleet.get").at(-1)).toEqual({ scope: "broomva", ticks: 24 });
    // In the Fleet view the health band says it; the notice is not shown twice.
    expect(view.text()).not.toContain("Fleet broomva: missed tick.");
  });

  test("an intent from the header count opens the Fleet view", async () => {
    const view = await mount(surface(true));
    await step(generation, () => requestIntent({ kind: "fleet", scope: "sri" }));
    await settle(30);
    expect(view.viewNow()).toBe("Fleet");
    expect(sent("fleet.get").at(-1)).toEqual({ scope: "sri", ticks: 24 });
  });

  test("a dry-run Agree is never the page's filled verb, even with nothing else to do", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await view.press(view.byLabel("sri, Not scheduled, 1 proposal to review"));
    const filled = (label: string) => {
      const target = view.byLabel(label) as unknown as { firstElementChild: { style: { backgroundColor: string } } };
      return target.firstElementChild.style.backgroundColor.includes("84, 128, 199");
    };
    expect(view.text()).toContain("No scope's tick wants a look");
    expect(view.text()).toContain("A late or failing scope whose alert is at your gate is counted there.");
    expect(starting(view, "Health: 0, no scope's tick wants a look")).toBeDefined();
    expect(filled("Agree: report only, 4 sessions")).toBe(false);
    // Teach the fleet sits below the sessions.
    expect(view.text().indexOf("Teach the fleet")).toBeGreaterThan(view.text().indexOf("Sessions in scope"));
  });

  test("one number: the band says needs.list's total, the header's; the fleet's health is its own (BRO-2908, BRO-3001)", async () => {
    // The shared fixture: broomva's missed tick, its ask's raised work (Work a, at your gate), one decision
    // that waits on you and one that does not.
    decisionsNow = [
      { ...decisionFixture(), id: "W1", blocking: true, waiting: true },
      { ...decisionFixture(), id: "Q1", waiting: false },
    ];
    // Work a is the fleet's raised batch: the wire says so (#23's display), as it does for real fleet work.
    items = items.map((item) =>
      item.id === "a"
        ? { ...item, display: { title: item.title, fleet: { scope: "broomva", what: "batch 2-1", tick: "2" } } }
        : item,
    );
    // work.attention as the server builds it from the same fixture: the scope's notice and the waiting ask.
    fleetNotices = [
      {
        scope: "broomva",
        status: "missed",
        reason: "No tick since tick 35.",
        since: new Date(Date.now() - 3 * H).toISOString(),
      },
    ];
    const view = await mount(surface(false));
    await view.goto("Fleet");
    for (let tries = 0; tries < 100 && !view.text().includes("Would list 4 unmanaged"); tries += 1) await settle(20);
    // The fleet's health is watched (A1): its band counts the scope's tick, and the header never does. What
    // holds on you is needs.list's: the raised work at your gate (Work), the decision that waits (Decisions).
    const needs = needsNow();
    const header = needs.summary.total;
    const work = needs.rows.filter((row) => row.key.startsWith("work:")).length;
    const decisions = needs.rows.filter((row) => row.key.startsWith("ask:")).length;
    expect([header, work, decisions]).toEqual([3, 2, 1]);
    expect(headerFace(header).label).toBe(`${header} need you`);
    // The band says Maestro's number beside the fleet's health, the rest pressable to its view (BRO-3001).
    for (let tries = 0; tries < 100 && !view.text().includes("in Maestro"); tries += 1) await settle(20);
    expect(view.text()).toContain(`${header} need you in Maestro (${work} in Work, ${decisions} in Decisions)`);
    // The header's Feed tab says the same Maestro-wide number as the button and the band.
    expect(view.byLabel(`Feed, ${header} need you`)).not.toBeNull();
    expect(view.byLabel(`${work} in Work: open Work`)).not.toBeNull();
    expect(starting(view, "Health: 1, 1 scope whose tick wants a look")).toBeDefined();
    const section = view.byLabel("Health: 1 card") as unknown as { children: { length: number } };
    expect(section.children.length).toBe(1);
    // The raised work and the waiting decision are shown, uncounted here.
    expect(view.text()).toContain("Counted where they live");
    // The decision that does not wait on you is listed apart, uncounted.
    expect(view.text()).toContain("Also open");
    // One scope shown: the band still says Maestro's whole number, not a share of it.
    await view.press(view.byLabel("sri, Not scheduled, 1 proposal to review"));
    for (let tries = 0; tries < 100 && !view.text().includes("No scope's tick wants a look"); tries += 1)
      await settle(20);
    expect(view.text()).toContain(`${header} need you in Maestro (${work} in Work, ${decisions} in Decisions)`);
  });

  test("an ask the fleet has not raised as work yet says where it is answered, and can still be copied", async () => {
    askOverride = { item: null };
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    expect(view.byLabel("Copy the question of ask a1")).not.toBeNull();
    // Not written to Decisions yet, and it says when it will be (skills#270, BRO-2908); never the filled verb.
    expect(view.text()).toContain("Not in Decisions yet");
    // broomva's tick is 3 h late: the next tick is due now, never a time already past.
    expect(view.text()).toContain("The fleet writes these to Decisions at its next tick (now due)");
    const copy = view.byLabel("Copy the question of ask a1") as unknown as {
      firstElementChild: { style: { backgroundColor: string } };
    };
    expect(copy.firstElementChild.style.backgroundColor.includes("84, 128, 199")).toBe(false);
  });

  test("with no tick that needs you, what the fleet raised is shown but never leads with the filled verb (BRO-2908)", async () => {
    broomvaOnTime = true;
    const view = await mount(surface(false));
    await view.goto("Fleet");
    for (let tries = 0; tries < 100 && !view.text().includes("Would list 4 unmanaged"); tries += 1) await settle(20);
    expect(view.text()).toContain("No scope's tick wants a look");
    expect(view.text()).toContain("Counted where they live");
    const verb = view.all('[aria-label^="Open the fleet\'s work for ask"]')[0] as unknown as
      | { firstElementChild: { style: { backgroundColor: string } } }
      | undefined;
    expect(verb).toBeDefined();
    expect(verb?.firstElementChild.style.backgroundColor.includes("84, 128, 199")).toBe(false);
  });

  test("every scope shown: the fleet's notices, a blind clock's too, are watched; the band's Maestro number never counts them (A1)", async () => {
    const since = new Date(Date.now() - 3 * H).toISOString();
    fleetNotices = [
      { scope: "broomva", status: "missed", reason: "No tick since tick 35.", since },
      { scope: "sri", status: "blind", reason: "The awake clock can't be read.", since },
    ];
    const view = await mount(surface(false));
    await view.goto("Fleet");
    for (let tries = 0; tries < 100 && !view.text().includes("in Maestro"); tries += 1) await settle(20);
    // needs.list's total, the header's: Work a and Work g at your gate, and no notice.
    expect(view.text()).toContain("2 need you in Maestro (2 in Work)");
    expect(view.text()).not.toContain("clock check");
  });

  test("Health jumps to the queue; a filter tile filters exactly what it counts and says Filtering", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    const rows = () => view.all('[aria-label*=". The fleet would: "]').length;
    const before = rows();
    await view.press(starting(view, "Health: "));
    // Not a roster filter: the sessions are all still there, and the tile is not pressed.
    expect(rows()).toBe(before);
    expect(starting(view, "Health: ")?.getAttribute("aria-pressed")).toBe("false");
    await view.press(starting(view, "Failed: 1"));
    expect(rows()).toBe(1);
    expect(starting(view, "Failed: 1")?.getAttribute("aria-label")).toContain("Filtering the sessions");
    expect(view.text()).toContain("Filtering");
  });

  test("a scope that cannot be read is named in the verdict and its strip, never dropped", async () => {
    fleetFails = "sri";
    const view = await mount(surface(false));
    await view.goto("Fleet");
    for (let tries = 0; tries < 100 && !view.text().includes("Can't read sri"); tries += 1) await settle(20);
    expect(view.text()).toContain("Can't read sri");
    expect(view.text()).toContain("Can't read sri: fleet.get timed out");
  });

  test("tiles and tabs answer a press without scaling; buttons scale; a failed tick carries a glyph", async () => {
    reduced = false;
    try {
      const view = await mount(surface(false));
      await view.goto("Fleet");
      await settle(30);
      const transform = (target: Element | undefined | null) =>
        (target as unknown as { firstElementChild: { style: { transform: string } } } | null)?.firstElementChild.style
          .transform ?? "";
      expect(transform(starting(view, "Running: 1"))).not.toContain("scale");
      expect(transform(view.byLabel("All scopes"))).not.toContain("scale");
      expect(transform(view.byLabel("Agree: report, de2dd335 sri-sti-2761-rce"))).toContain("scale");
      expect(starting(view, "Tick 34, failed at observe")?.textContent).toBe("×");
    } finally {
      reduced = true;
    }
  });

  test("Disagree's note is capped at what the review file takes", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await view.press(view.byLabel("Disagree: report, de2dd335 sri-sti-2761-rce"));
    expect(view.byLabel("Why disagree: report, de2dd335 sri-sti-2761-rce")?.getAttribute("maxlength")).toBe("1000");
  });

  test("the inspector says what a verdict does under the dry run", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    await view.press(starting(view, "sri-sti-2761-rce, failed"));
    expect(view.text()).toContain("Your verdict teaches the fleet; it changes nothing now: the fleet runs dry.");
  });

  test("an ask's short id links its session: resumed where it ran first, its question copied second", async () => {
    const uuid = "d4b991f0-1133-4c26-9a7e-000000000001";
    rosterExtra = [
      {
        id: uuid,
        short: "d4b991f0",
        name: "sti-2139-asvs-dast-conflicts",
        kind: "background",
        state: "blocked",
        cwd: "~/work/sri",
        branch: null,
        agentId: null,
        classId: "7",
        className: "blocked on the owner",
        action: "carry the ask forward",
        evidence: "job file: blocked on a question",
        activeAt: new Date(Date.now() - 2 * H).toISOString(),
        scope: "broomva",
        placement: "cwd",
        inScope: true,
        history: [{ tick: 35, classId: "7" }],
      },
    ];
    askSessionNow = { id: "d4b991f0-1133", short: "d4b991f0", name: null, agentId: null };
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    // The session's name, linked by the key's short id.
    expect(view.text()).toContain("about sti-2139-asvs-dast-conflicts");
    const verbs = view
      .all(
        '[aria-label^="Copy the command that resumes"], [aria-label^="Open the fleet\'s work for ask a1"], [aria-label="Copy the question of ask a1"]',
      )
      .map((one) => one.getAttribute("aria-label"));
    expect(verbs).toEqual([
      "Copy the command that resumes sti-2139-asvs-dast-conflicts",
      "Open the fleet's work for ask a1: Work a",
      "Copy the question of ask a1",
    ]);
    // The inspector offers it too, filled: a blocked session Paseo does not hold.
    await view.press(starting(view, "sti-2139-asvs-dast-conflicts, blocked"));
    const resume = view
      .all('[aria-label="Copy the command that resumes sti-2139-asvs-dast-conflicts"]')
      .at(-1) as unknown as {
      firstElementChild: { style: { backgroundColor: string } };
    };
    expect(resume.firstElementChild.style.backgroundColor).toContain("84, 128, 199");
  });

  test("a session blocked on you: a structural title, and the fleet's question as the body, byte for byte", async () => {
    const source =
      "Session sti-2139-asvs-dast-conflicts (bf1ee1b8) is blocked on you: job file: blocked on a question to its user (allocate disk space to run `bun test apps/app/test/authenticated-page-inventory.test.ts` (#12). Then rerun.";
    rosterExtra = [
      {
        id: "bf1ee1b8-11be-4544-9f7e-143a990c3e10",
        short: "bf1ee1b8",
        name: "sti-2139-asvs-dast-conflicts",
        kind: "background",
        state: "blocked",
        cwd: "~/work/sri",
        branch: null,
        agentId: null,
        classId: "7",
        className: "blocked on the owner",
        action: "carry the ask forward",
        evidence: "job file: blocked on a question",
        activeAt: null,
        scope: "broomva",
        placement: "cwd",
        inScope: true,
        history: [],
      },
    ];
    askSessionNow = { id: "bf1ee1b8-11be", short: "bf1ee1b8", name: null, agentId: null };
    askOverride = { class: "7", className: "blocked on the owner", question: source, item: null, batch: "2-1" };
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    expect(view.text()).toContain("sti-2139-asvs-dast-conflicts is waiting on you");
    // The body is the fleet's question as written: no stripping, no capitalising.
    expect(view.all("div").some((node) => node.textContent === source)).toBe(true);
    // Short enough to fit: shown whole, with no disclosure that would open nothing.
    expect(view.all("*").some((node) => node.getAttribute?.("aria-label") === "Show all of ask a1")).toBe(false);
  });

  test("a long ask is clamped and has Show all, and its text is still the fleet's, byte for byte", async () => {
    const source =
      `Session sti-2139-asvs-dast-conflicts (bf1ee1b8) is blocked on you: ${"job file: blocked on a question to its user (allocate disk space; rerun). ".repeat(5)}`.trim();
    rosterExtra = [
      {
        id: "bf1ee1b8-11be-4544-9f7e-143a990c3e10",
        short: "bf1ee1b8",
        name: "sti-2139-asvs-dast-conflicts",
        kind: "background",
        state: "blocked",
        cwd: "~/work/sri",
        branch: null,
        agentId: null,
        classId: "7",
        className: "blocked on the owner",
        action: "carry the ask forward",
        evidence: "job file: blocked on a question",
        activeAt: null,
        scope: "broomva",
        placement: "cwd",
        inScope: true,
        history: [],
      },
    ];
    askSessionNow = { id: "bf1ee1b8-11be", short: "bf1ee1b8", name: null, agentId: null };
    askOverride = { class: "7", className: "blocked on the owner", question: source, item: null, batch: "2-1" };
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    expect(view.all("div").some((node) => node.textContent === source)).toBe(true);
    await view.press(view.byLabel("Show all of ask a1"));
    expect(view.all("div").some((node) => node.textContent === source)).toBe(true);
  });

  test("an ask linked to a Paseo agent by its short id opens that agent", async () => {
    askSessionNow = { id: "agent-pu", short: "agent-pu", name: null, agentId: null };
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await settle(30);
    await view.press(view.byLabel("Open the session ask a1 is about: hanging-pug"));
    expect(opened).toEqual(["agent-pug"]);
  });

  test("a refetch that fails while data stands is a quiet note, never 'can't read'", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    for (let tries = 0; tries < 100 && !view.text().includes("Would list 4 unmanaged"); tries += 1) await settle(20);
    fleetFails = "sri";
    await view.refetch();
    for (let tries = 0; tries < 100 && !view.text().includes("Couldn't refresh sri"); tries += 1) await settle(20);
    expect(view.text()).toContain("Couldn't refresh sri (fleet.get timed out); showing the last read.");
    expect(view.text()).not.toContain("Can't read sri");
    expect(view.text()).toContain("Would list 4 unmanaged");
  });

  test("on a phone: four tiles, rows stacked, a row opens the inspector as a sheet; the report waits for Report", async () => {
    const view = await mount(surface(true));
    await view.goto("Fleet");
    await settle(30);
    // Every tile is reachable on the phone, in a row that scrolls sideways.
    expect(starting(view, "Unmanaged: ")).toBeDefined();
    expect(starting(view, "Out of scope: ")).toBeDefined();
    expect(starting(view, "Failed: ")).toBeDefined();
    for (let tries = 0; tries < 100 && !view.text().includes("Would list 4 unmanaged"); tries += 1) await settle(20);
    expect(starting(view, "Health: 1")).toBeDefined();
    // The legend is on the phone too, and an Agree-all card names every session it covers and lists them.
    expect(view.text()).toContain("no exit recorded");
    expect(view.text()).toContain("sri-aaaa1111 · sri-bbbb2222 · sri-cccc3333 · sri-dddd4444");
    expect(view.byLabel("See the sessions: report only")).not.toBeNull();
    expect(view.text()).not.toContain("Report of tick 35.");
    await view.press(view.byLabel("Open tick 35's report"));
    await settle(50);
    const text = view.text();
    expect(text).toContain("Report of tick 35.");
    expect(text.indexOf("Report of tick 35.")).toBeLessThan(text.indexOf("What tick 35 logged"));
    await view.press(starting(view, "hanging-pug, running"));
    expect(view.text()).toContain("What the fleet saw, last 2 ticks");
  });
});

describe("the Timeline", () => {
  const rows = (view: Awaited<ReturnType<typeof mount>>) =>
    view
      .all('[role="button"][aria-expanded]')
      .map((row) => row.getAttribute("aria-label") ?? "")
      .filter((label) => !label.includes("the loop") && !/^(Presence|Workspace): /.test(label));

  test("every scheduled source on one axis, what needs you first, each with its last and next run", async () => {
    const view = await mount(surface(false));
    await view.goto("Timeline");
    const text = view.text();
    expect(text).toContain("The past 24 h and the next 24 h. 4 scheduled sources; 1 needs you.");
    expect(text).toContain("Its last run failed: exit 1.");
    expect(text).toContain("Next in 10 min");
    expect(text).toContain("Sundays at 02:30");
    // Failed first, then on time by next run, then off.
    expect(rows(view).map((label) => label.split(",")[0])).toEqual([
      "kg-lint",
      "moltbook-loop",
      "fleet-reconcile broomva",
      "Maestro's loop",
    ]);
  });

  test("a row opens its runs, its log's end and where it keeps it; the log is read only then", async () => {
    const view = await mount(surface(false));
    await view.goto("Timeline");
    expect(view.text()).not.toContain("Runs in the last 24 h");
    expect(calls.filter((call) => call.method === "timeline.log")).toEqual([]);
    await view.press(view.all('[aria-label^="kg-lint, launchd"]')[0]);
    await settle(50);
    expect(calls.filter((call) => call.method === "timeline.log").map((call) => call.input)).toEqual([
      { id: "launchd:com.broomva.kg-lint" },
    ]);
    const text = view.text();
    expect(text).toContain("Runs in the last 24 h");
    expect(text).toContain("failed · 5 s · exit 1");
    expect(text).toContain("lint: 3 pages fail the schema");
    expect(text).toContain("/tmp/broomva-kg-lint.log");
  });

  test("a fleet scope's row opens the Fleet view; the loop's opens the loop", async () => {
    const view = await mount(surface(false));
    await view.goto("Timeline");
    await view.press(view.all('[aria-label^="fleet-reconcile broomva, Fleet"]')[0]);
    // A source with no log of its own asks for none.
    expect(calls.filter((call) => call.method === "timeline.log")).toEqual([]);
    await view.press(view.byLabel("Open Fleet"));
    expect(view.viewNow()).toBe("Fleet");
    await view.goto("Timeline");
    await view.press(view.all('[aria-label^="Maestro\'s loop, Maestro"]')[0]);
    await view.press(view.byLabel("Open the loop"));
    expect(view.byLabel("Close the loop")).not.toBeNull();
  });

  test("on the phone: a failed run shows above the other views, opens the Timeline, and is not repeated there", async () => {
    timelineNotices = [
      {
        id: "launchd:com.broomva.kg-lint",
        kind: "launchd",
        name: "kg-lint",
        status: "failed",
        reason: "Its last run failed: exit 1.",
        since: new Date(Date.now() - 2 * H).toISOString(),
      },
    ];
    const view = await mount(surface(true));
    await settle(50);
    expect(view.text()).toContain("kg-lint: failed run");
    expect(view.text()).toContain("Its last run failed: exit 1.");
    await view.press(view.byLabel("Open Timeline, kg-lint"));
    expect(view.viewNow()).toBe("Timeline");
    expect(view.text()).not.toContain("kg-lint: failed run.");
    expect(view.text()).toContain("1 needs you.");
  });
});

describe("drilling in", () => {
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);

  test("a decision ask shows its stakes and options, and is answered in place: chosen, then Answer", async () => {
    decisionsNow = [decisionFixture()];
    const view = await mount(surface(false));
    await view.goto("Fleet");
    // Folded in Needs you to a line per ask until opened.
    expect(view.text()).toContain("Four small review follow-ups from #7 and #8: ticket them, or drop them?");
    await view.press(view.byLabel("Read and answer the fleet's decisions, broomva"));
    const text = view.text();
    expect(text).toContain("Four small review follow-ups from #7 and #8: ticket them, or drop them?");
    expect(text).toContain("What waiting costsNone blocks a lane; untracked, a test gap stays invisible.");
    expect(text).toContain("Why youScheduling is yours.");
    expect(text).toContain("File all fourRecommendedEach becomes a Linear issue.");
    expect(text).toContain("Drop all fourCannot be undoneThey stay in this ledger.");
    // The default names no option id: it is said as the ledger wrote it, with no claim.
    expect(text).toContain("If you say nothing: file all four once Linear is signed in");
    expect(text).not.toContain("same as recommended");
    // Nothing chosen and no words: Answer waits.
    expect(view.byLabel("Answer A10")?.getAttribute("aria-disabled")).toBe("true");
    await view.press(view.byLabel("File all four, recommended"));
    expect(view.byLabel("File all four, recommended")?.getAttribute("aria-checked")).toBe("true");
    await view.type(view.byLabel("Your words for A10"), "Under BRO-2800.");
    await view.press(view.byLabel("Answer A10: File all four"));
    expect(sent("ask.answer")).toEqual([
      {
        where: { kind: "fleet", scope: "broomva" },
        ledger: "maestro-paseo-gaps.yaml",
        uid: null,
        id: "A10",
        hash: "0123456789abcdef",
        option: "ticket-all",
        note: "Under BRO-2800.",
      },
    ]);
    expect(view.text()).toContain("Answered just now: “File all four”");
    expect(view.text()).toContain("File all four: Each becomes a Linear issue.\nUnder BRO-2800.");
    expect(view.byLabel("Answer A10: File all four")).toBeNull();
    await view.press(view.byLabel("Show the details of A10"));
    await view.press(view.byLabel("Open the session that asked A10"));
    expect(opened).toEqual(["agent-asker"]);
  });

  test("answered in the Fleet view, the ask stays filed under its scope in Decisions, and under its ledger here", async () => {
    decisionsNow = [decisionFixture()];
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await view.press(view.byLabel("Read and answer the fleet's decisions, broomva"));
    // Every read after this fails or is held: only the answer's reply can tell either list.
    workspaceFail = "asks.workspace timed out";
    let release = () => {};
    fleetHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await view.press(view.byLabel("File all four, recommended"));
    await view.press(view.byLabel("Answer A10: File all four"));
    expect(view.text()).toContain("Answered just now: “File all four”");
    // The Fleet view's group is its ledger's, as before: the reply is untagged there.
    expect(
      view.all("[aria-expanded]").some((one) => one.getAttribute("aria-label")?.startsWith("maestro-paseo-gaps.yaml:")),
    ).toBe(true);
    fleetHeld = null;
    release();
    await view.goto("Decisions");
    for (let tries = 0; tries < 100 && !view.text().includes("Nothing to decide"); tries += 1) await settle(20);
    // Decisions learned it from the reply, under its scope: the ask is no longer open there.
    expect(view.text()).toContain("Open0decisions");
    expect(view.text()).not.toContain("File all four, recommended");
  });

  test("a fleet scope's decisions: one that waits on you is its own card; the others fold past ten open", async () => {
    decisionsNow = [
      { ...decisionFixture(), ledger: "waits.yaml", id: "W1", blocking: true, waiting: true },
      ...Array.from({ length: 11 }, (_, at) => ({ ...decisionFixture(), ledger: `ledger-${at}.yaml`, id: `Q${at}` })),
    ];
    const view = await mount(surface(false));
    await view.goto("Fleet");
    // The one that waits on you is counted, a card of its own in Needs you.
    expect(view.byLabel("Read and answer W1, broomva")).not.toBeNull();
    await view.press(view.byLabel("Read and answer the fleet's decisions, broomva"));
    const heading = (ledger: string) =>
      view.all("[aria-expanded]").find((one) => one.getAttribute("aria-label")?.startsWith(`${ledger}:`));
    expect(heading("ledger-3.yaml")?.getAttribute("aria-expanded")).toBe("false");
    // Ten or fewer: every ledger starts open.
    decisionsNow = decisionsNow.slice(0, 11);
    const fewer = await mount(surface(false));
    await fewer.goto("Fleet");
    await fewer.press(fewer.all('[aria-label="Read and answer the fleet\'s decisions, broomva"]').at(-1));
    const fewerHeading = fewer
      .all("[aria-expanded]")
      .find((one) => one.getAttribute("aria-label")?.startsWith("ledger-3.yaml:"));
    expect(fewerHeading?.getAttribute("aria-expanded")).toBe("true");
  });

  test("an ask with an id collision says so and takes no answer", async () => {
    decisionsNow = [{ ...decisionFixture(), refusal: "Two asks in maestro-paseo-gaps.yaml are named A10." }];
    const view = await mount(surface(false));
    await view.goto("Fleet");
    // Folded in Needs you to a line per ask until opened.
    expect(view.text()).toContain("Four small review follow-ups from #7 and #8: ticket them, or drop them?");
    await view.press(view.byLabel("Read and answer the fleet's decisions, broomva"));
    expect(view.text()).toContain("Two asks in maestro-paseo-gaps.yaml are named A10.");
    expect(view.byLabel("Answer A10")).toBeNull();
  });

  test("a fleet ask opens the session it is about, and its details show the tick that raised it", async () => {
    askSessionNow = { id: "d4b991f0-1133-4c26", short: "d4b991f0", name: "broomva-88", agentId: "agent-88" };
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await view.press(view.byLabel("Open the session ask a1 is about: broomva-88"));
    expect(opened).toEqual(["agent-88"]);
    expect(sent("fleet.tick")).toEqual([]);
    await view.press(view.byLabel("Show the details of ask a1"));
    await settle(50);
    expect(sent("fleet.tick")).toEqual([{ scope: "broomva", tick: 2 }]);
    const text = view.text();
    expect(text).toContain("key records-without-process · batch 2-1 · session d4b991f0-1133-4c26");
    expect(text).toContain("Raised at tick 2");
    expect(text).toContain("tick 2 done: recover=0 observe=1");
    expect(text).toContain("Report of tick 2.");
    await view.press(view.byLabel("Hide the details of ask a1"));
    expect(view.text()).not.toContain("Raised at tick 2");
  });

  test("a proposal about one Paseo session opens it in Paseo; one about a session that is not offers no Open", async () => {
    proposalsNow = fleetProposals().map((proposal) =>
      proposal.session?.short === "5dd4ed18"
        ? { ...proposal, session: { ...proposal.session, agentId: "agent-walrus", branch: "feat/walrus" } }
        : proposal,
    );
    const view = await mount(surface(false));
    await view.goto("Fleet");
    expect(view.byLabel("Open session de2dd335 sri-sti-2761-rce in Paseo")).toBeNull();
    await view.press(view.byLabel("Show reviewed"));
    await view.press(view.byLabel("Open session 5dd4ed18 worried-walrus in Paseo"));
    expect(opened).toEqual(["agent-walrus"]);
  });

  test("a tick in All ticks opens its runner's words, its log lines and its report, read only then", async () => {
    const view = await mount(surface(false));
    await view.goto("Fleet");
    await view.press(view.byLabel("All ticks, broomva"));
    // The tick strip's cells carry the same words; the row is the one that opens.
    const row = () => view.all('[aria-expanded][aria-label^="Tick 34, failed at observe"]')[0];
    expect(row()?.getAttribute("aria-expanded")).toBe("false");
    expect(sent("fleet.tick")).toEqual([]);
    await view.press(row());
    await settle(50);
    expect(row()?.getAttribute("aria-expanded")).toBe("true");
    expect(sent("fleet.tick")).toEqual([{ scope: "broomva", tick: 34 }]);
    const text = view.text();
    expect(text).toContain("exit 1 · failed at observe · recover=0 observe=1");
    expect(text).toContain("What tick 34 logged");
    expect(text).toContain("[2026-10-03T16:15:48Z] step observe rc=1");
    expect(text).toContain("Tick 34's report");
    await view.press(row());
    expect(view.text()).not.toContain("What tick 34 logged");
  });

  test("a schedule's run opens the session it started, and shows the start of what it said", async () => {
    timelineRuns = true;
    const view = await mount(surface(false));
    await view.goto("Timeline");
    await view.press(view.all('[aria-label^="Morning sweep, "]')[0]);
    expect(view.text()).toContain("Waiting on four background jobs.");
    await view.press(view.all('[aria-label^="Open its session: "]')[0]);
    expect(opened).toEqual(["b8c26013-30f3-4ebc-bd29-bbfdf08383ee"]);
  });

  test("a fleet run opens its tick in the Fleet view, opened", async () => {
    timelineRuns = true;
    const view = await mount(surface(false));
    await view.goto("Timeline");
    await view.press(view.all('[aria-label^="fleet-reconcile broomva, Fleet"]')[0]);
    await view.press(view.all('[aria-label^="Open tick 35: "]')[0]);
    await settle(50);
    expect(view.viewNow()).toBe("Fleet");
    expect(sent("fleet.tick")).toEqual([{ scope: "broomva", tick: 35 }]);
    expect(view.text()).toContain("What tick 35 logged");
    // That tick was the visit's: the Fleet tab chosen again later opens on none.
    await view.goto("Feed");
    await view.goto("Fleet");
    expect(view.text()).not.toContain("What tick 35 logged");
  });
});

describe("the Decisions tab", () => {
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
  /** The workspace's asks load on their own query once the tab opens: waited for, never assumed, on a slow runner. */
  const until = async (view: Awaited<ReturnType<typeof mount>>, text: string) => {
    for (let tries = 0; tries < 150 && !view.text().includes(text); tries += 1) await settle(20);
  };
  const checkout = { kind: "checkout" as const, path: "/Users/me/broomva", branch: "feat/prompt-cache" };
  const main = { kind: "main" as const, path: "/Users/me/broomva", branch: null };
  /** The #863 merge ask: blocking with a default, at home in the main checkout, which has not landed it. */
  const merge = (): DecisionAsk => ({
    ...decisionFixture(),
    ledger: "2026-10-01-auth-preflight-hook-stderr.yaml",
    arc: "prompt-cache-and-preflight-caching",
    id: "A1",
    hash: "aaaaaaaaaaaaaaaa",
    headline: "Approve merge of PR #863 touching scripts/auth-preflight-hook.sh?",
    question: "Approve merge of PR #863",
    stakes: "scripts/auth-preflight-hook.sh is in require_human paths.",
    whyYou: "policy.yaml asks a human for hook scripts.",
    options: [
      {
        id: "merge",
        label: "Merge PR #863",
        consequence: "Warnings go to stderr.",
        reversible: true,
        recommended: true,
      },
      { id: "hold", label: "Hold PR #863", consequence: "It stays open.", reversible: true, recommended: false },
    ],
    fallback: "hold",
    blocking: true,
    waiting: true,
    origin: null,
    home: checkout,
  });
  const canvas = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
    ...decisionFixture(),
    ledger: "bro-2795-local-first-agentic-canvas.yaml",
    arc: "bro-2795-local-first-agentic-canvas",
    id,
    hash: "bbbbbbbbbbbbbbbb",
    headline: `Canvas ask ${id}`,
    origin: null,
    home: main,
    ...extra,
  });

  const open = async (compact = false) => {
    const view = await mount(surface(compact));
    await view.goto("Decisions");
    await until(view, "Decision ");
    return view;
  };
  /** A key pressed on the page (or in a field), as the browser sends it. */
  /** A key pressed in the tab (its root, unless a target is given), as the browser sends it; says whether it was taken. */
  const key = async (
    view: Awaited<ReturnType<typeof mount>>,
    name: string,
    target?: unknown,
    init: { repeat?: boolean } = {},
  ) => {
    let taken = false;
    await step(generation, () => {
      const at = (target ?? view.all("#maestro-decisions")[0]) as unknown as { dispatchEvent(event: unknown): boolean };
      const event = new win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
      at.dispatchEvent(event);
      taken = event.defaultPrevented;
    });
    await settle(30);
    return taken;
  };
  const days = (n: number) => new Date(Date.now() - n * 24 * H).toISOString();
  /** Waits until a text is gone (a card that leaves over 160 ms). */
  const untilGone = async (view: Awaited<ReturnType<typeof mount>>, text: string) => {
    for (let tries = 0; tries < 150 && view.text().includes(text); tries += 1) await settle(20);
  };

  test("your answers on their way: the batch waits in Needs you with its PR; each answered card says landed or acted on", async () => {
    const fate = (stage: "unlanded" | "acted", words: string) => ({
      stage,
      words,
      route: null,
      pr: stage === "unlanded" ? { number: 915, url: "https://github.com/broomva/workspace/pull/915" } : null,
      work: null,
      agentId: null,
    });
    const answered = { state: "answered" as const, answeredAt: new Date(Date.now() - H).toISOString() };
    workspaceNow = [
      canvas("product-name"),
      canvas("stranded", {
        ...answered,
        answer: "Ship it.",
        batched: true,
        fate: fate("unlanded", "Waits to land: PR #915."),
      }),
      canvas("delivered", {
        ...answered,
        answer: "Hold it.",
        fate: fate("acted", "Acted on: sent to the session that asked."),
      }),
    ];
    landingNow = {
      stage: "waiting",
      pending: 1,
      asks: [],
      pr: { number: 915, url: "https://github.com/broomva/workspace/pull/915" },
      conflict: null,
      error: null,
      landed: null,
      checkedAt: new Date().toISOString(),
    };
    const view = await open();
    await until(view, "Open the PR");
    // J5's tile: the batch's own count, the PR opened (never merged), and where each answer went on the right.
    const text = view.text();
    expect(text).toContain("Waiting to land1answer");
    expect(text).toContain("Answered, but still on maestro/answers, not on main.");
    await view.press(view.byLabel("Open the PR"));
    expect(urls).toEqual(["https://github.com/broomva/workspace/pull/915"]);
    expect(sent("work.verdict")).toEqual([]);
    await until(view, "Where your last answers went");
    for (let tries = 0; tries < 100 && !view.text().includes("Hold it."); tries += 1) await settle(20);
    // Each answer's fate, as the rail says it: never "acted" for the stranded one.
    expect(view.text()).toContain("You: Ship it.Waits to land: PR #915.");
    expect(view.text()).toContain("You: Hold it.Acted on: sent to the session that asked.");
    expect(view.text()).not.toContain("In the answers batch on maestro/answers");
  });

  test("an answer whose asker is gone waits in view for the conductor; File as work and Dismiss, each with Undo (A8)", async () => {
    workspaceNow = [
      canvas("product-name"),
      canvas("orphaned", {
        state: "answered",
        answer: "Change it.",
        answeredAt: new Date(Date.now() - H).toISOString(),
        fate: {
          stage: "conductor",
          words:
            "For the conductor: no session on its arc could take your answer, so it waits for the conductor to give it to a lane. Nothing was started.",
          route: "conductor",
          pr: null,
          work: null,
          agentId: "asker-1",
          key: "k-1",
          pending: null,
        },
      }),
    ];
    const view = await open();
    await until(view, "For the conductor · 1");
    // Shown without opening anything: its headline, your answer, and that nothing was started; listed once.
    const text = view.text();
    expect(view.byLabel("For the conductor · 1")).not.toBeNull();
    expect(text).toContain("Nothing was started: each waits for the conductor to give it to a lane");
    expect(text).toContain("Canvas ask orphaned");
    expect(text).toContain("Change it.");
    expect(view.byLabel("Recently answered · 1")).toBeNull();
    // File as work: your decision, pending in its undo window, with Undo.
    await view.press(view.byLabel("File as work, Canvas ask orphaned"));
    expect(sent("conductor.decide")).toEqual([{ key: "k-1", verb: "file" }]);
    await until(view, "Filing it as work: it is queued, never started");
    await view.press(view.byLabel("Undo, Canvas ask orphaned"));
    expect(sent("conductor.undo")).toEqual([{ receipt: "r-file" }]);
    for (let tries = 0; tries < 100 && !view.byLabel("Dismiss, Canvas ask orphaned"); tries += 1) await settle(20);
    // Undone, it waits again; Dismiss is the other verb.
    await view.press(view.byLabel("Dismiss, Canvas ask orphaned"));
    expect(sent("conductor.decide")).toEqual([
      { key: "k-1", verb: "file" },
      { key: "k-1", verb: "dismiss" },
    ]);
    await until(view, "Dismissing it: nothing follows from it");
  });

  test("one decision at a time, blocking first: its count and progress, the tiles, the card's layers, the chips, up next (J5)", async () => {
    workspaceNow = [
      canvas("product-name", { askedAt: days(5) }),
      merge(),
      canvas("old-one", {
        state: "answered",
        answer: "Keep it.",
        answerOption: "ticket-all",
        answeredAt: new Date(Date.now() - H).toISOString(),
        batched: true,
      }),
    ];
    const view = await open();
    // The tab's badge is needs.list's: the one ask that waits on you (BRO-3001); the open count is the tab's own.
    expect(view.viewNow()).toBe("Decisions");
    expect(view.byLabel("Decisions, 1 waits on you")).not.toBeNull();
    const text = view.text();
    expect(text).toContain("Decision 1 of 2 · 1 blocks work");
    // The Open tile: the queue's length, what blocks, what waits on you (needs.list's), the oldest, and where.
    expect(text).toContain("Open2decisions1 blocks work · 1 on you · oldest 5d");
    expect(text).toContain("2026-10-01-auth-preflight-hook-stderr 1 · bro-2795-local-first-agentic-canvas 1");
    // No machine paths on the main surface, and the ask's id only under Details.
    expect(text).not.toContain("/Users/me/broomva");
    // The card: J3's kicker, the question as its headline, the two tiles, the options, the default, where it goes.
    expect(text).toContain("Ask · 2026-10-01-auth-preflight-hook-stderr · A1 · reversible");
    expect(text).not.toContain("Ask: A1");
    expect(text).toContain("Waits on you: it blocks until you answer.");
    expect(text).toContain("Approve merge of PR #863 touching scripts/auth-preflight-hook.sh?");
    expect(text).toContain("What waiting costsscripts/auth-preflight-hook.sh is in require_human paths.");
    expect(text).toContain("Why youpolicy.yaml asks a human for hook scripts.");
    expect(text).toContain("Merge PR #863RecommendedWarnings go to stderr.");
    expect(text).toContain("If you say nothing: Hold PR #863");
    expect(text).toContain("Goes to the session that asked");
    // Nothing is chosen for you, the recommendation included: the verb waits.
    expect(view.byLabel("Merge PR #863, recommended")?.getAttribute("aria-checked")).toBe("false");
    expect(view.byLabel("Answer A1")?.getAttribute("aria-disabled")).toBe("true");
    // The jargon stays under Details, as one short line.
    expect(text).not.toContain("§5.5");
    await view.press(view.byLabel("Show the details of A1"));
    expect(view.text()).toContain("Written to the checkout broomva (feat/prompt-cache)");
    expect(view.text()).toContain("Ask: A1");
    expect(view.text()).toContain("Approve merge of PR #863");
    // The chips: open counts, and a warn count only where an ask waits.
    expect(view.byLabel("All ledgers: 2 open, 1 waits on you")?.getAttribute("aria-checked")).toBe("true");
    expect(view.byLabel("2026-10-01-auth-preflight-hook-stderr.yaml: 1 open, 1 waits on you")).not.toBeNull();
    expect(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 1 open")).not.toBeNull();
    // Up next, on the right.
    expect(
      view.byLabel("Go to product-name in bro-2795-local-first-agentic-canvas.yaml: Canvas ask product-name"),
    ).not.toBeNull();
    // The order: Oldest puts the five-day-old ask first.
    await view.press(view.byLabel("Oldest"));
    expect(view.byLabel("Oldest")?.getAttribute("aria-checked")).toBe("true");
    expect(view.text()).toContain("Ask · bro-2795-local-first-agentic-canvas · product-name");
    expect(view.text()).toContain("5d");
    // A ledger from the chips: only its asks.
    await view.press(view.byLabel("Blocking first"));
    await view.press(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 1 open"));
    expect(view.text()).toContain("Decision 1 of 1");
    expect(view.text()).toContain("Canvas ask product-name");
    // Up next jumps.
    await view.press(view.byLabel("All ledgers: 2 open, 1 waits on you"));
    // Up next goes to the one pressed; going there is not deciding it, so the count holds.
    await view.press(view.all('[aria-label^="Go to product-name"]')[0]);
    expect(view.text()).toContain("Ask · bro-2795-local-first-agentic-canvas · product-name");
    expect(view.text()).toContain("Decision 1 of 2");
  });

  test("answered with the mouse: sent to the ask's home as read; it says what it answered, and the next comes up", async () => {
    workspaceNow = [merge(), canvas("product-name")];
    const view = await open();
    await view.press(view.byLabel("Merge PR #863, recommended"));
    expect(view.byLabel("Merge PR #863, recommended")?.getAttribute("aria-checked")).toBe("true");
    expect(view.text()).toContain("Answer with 1");
    await view.press(view.byLabel("Answer A1: Merge PR #863"));
    expect(sent("ask.answer")).toEqual([
      {
        where: { kind: "workspace", home: "/Users/me/broomva" },
        ledger: "2026-10-01-auth-preflight-hook-stderr.yaml",
        uid: null,
        id: "A1",
        hash: "aaaaaaaaaaaaaaaa",
        option: "merge",
        note: "",
      },
    ]);
    // One of two handled: the count moves on.
    await until(view, "Decision 2 of 2");
    const text = view.text();
    // No undo is offered: the server has none for an answer.
    expect(text).toContain(
      "Answered just now: “Merge PR #863” · 2026-10-01-auth-preflight-hook-stderr · answers are not undone here",
    );
    expect(text).not.toContain("Undo");
    expect(text).not.toContain("/Users/me/broomva");
    expect(text).toContain("Canvas ask product-name");
    expect(view.byLabel("Answer A1: Merge PR #863")).toBeNull();
    // Where it went is answers.status's: read again once the answer settles (the server writes the receipt it reads).
    expect(calls.filter((call) => call.method === "answers.status").length).toBeGreaterThan(1);
  });

  test("an answer waits out its undo window (B4): the tab says what was queued, and the surface counts it down with one Undo", async () => {
    answerQueued = true;
    workspaceNow = [merge(), canvas("product-name")];
    const view = await open();
    await view.press(view.byLabel("Merge PR #863, recommended"));
    await view.press(view.byLabel("Answer A1: Merge PR #863"));
    // Queued, not written: the ask is still open (and counted), and the line says so instead of "answered".
    await until(view, "written in 8 s unless you undo it");
    expect(view.text()).toContain("Answered: “Merge PR #863” · 2026-10-01-auth-preflight-hook-stderr · written in 8 s");
    expect(view.text()).not.toContain("answers are not undone here");
    // The card has moved on to the next ask; the surface's pending strip (every verb of yours) counts down and undoes.
    expect(view.text()).toContain("Canvas ask product-name");
    expect(view.all('[role="button"][aria-label^="Undo: "]')).toHaveLength(1);
    expect(sent("ask.answer")).toHaveLength(1);
  });

  test("with motion on, the answered card leaves before the next one comes up", async () => {
    setReduced(false);
    workspaceNow = [merge(), canvas("product-name")];
    const view = await open();
    await view.press(view.byLabel("Merge PR #863, recommended"));
    await view.press(view.byLabel("Answer A1: Merge PR #863"));
    // It says what was answered at once, while the card is still on its way out.
    expect(view.text()).toContain("Answered just now: “Merge PR #863”");
    expect(view.text()).toContain("Approve merge of PR #863 touching");
    await untilGone(view, "Approve merge of PR #863 touching");
    expect(view.text()).toContain("Decision 2 of 2");
    expect(view.text()).toContain("Canvas ask product-name");
    expect(view.text()).not.toContain("Approve merge of PR #863 touching");
  });

  test("the keys: 1-4 choose, Enter answers, S skips, J/K move; none while you type in the note", async () => {
    workspaceNow = [merge(), canvas("q1"), canvas("q2")];
    const view = await open();
    // The hints sit beside what they drive.
    expect(view.text()).toContain("1–4 choose · J / K move");
    expect(view.text()).toContain("Up next2");
    await key(view, "j");
    expect(view.text()).toContain("Canvas ask q1");
    expect(view.text()).toContain("Decision 1 of 3");
    await key(view, "k");
    expect(view.text()).toContain("Approve merge of PR #863 touching");
    await key(view, "s");
    expect(view.text()).toContain(
      "Skipped “Approve merge of PR #863 touching…”: it comes back at the end of the queue",
    );
    expect(view.text()).toContain("1 skipped");
    // A skip is not done: the count holds, and the skip is counted apart.
    expect(view.text()).toContain("Decision 1 of 3");
    expect(view.text()).toContain("Canvas ask q1");
    await key(view, "2");
    expect(view.byLabel("Drop all four, cannot be undone")?.getAttribute("aria-checked")).toBe("true");
    const note = view.byLabel("Your words for q1");
    await view.type(note, "Not now.");
    // Typed in the note: 1 is a character, Enter a new line, never a verb.
    await key(view, "1", note);
    await key(view, "Enter", note);
    expect(view.byLabel("Drop all four, cannot be undone")?.getAttribute("aria-checked")).toBe("true");
    expect(sent("ask.answer")).toEqual([]);
    // "Drop all four" cannot be undone: the first Enter arms a confirm, a later one sends.
    await key(view, "Enter");
    expect(sent("ask.answer")).toEqual([]);
    expect(view.text()).toContain("Confirm — cannot be undone");
    await settle(450);
    await key(view, "Enter");
    expect(sent("ask.answer")).toEqual([
      {
        where: { kind: "workspace", home: "origin/main" },
        ledger: "bro-2795-local-first-agentic-canvas.yaml",
        uid: null,
        id: "q1",
        hash: "bbbbbbbbbbbbbbbb",
        option: "drop",
        note: "Not now.",
      },
    ]);
    await until(view, "Answered just now");
    expect(view.text()).toContain("Answered just now: “Drop all four” · bro-2795-local-first-agentic-canvas ·");
  });

  test("a fleet scope's ask is listed beside the workspace's, filed under its scope, and answered at its root", async () => {
    const root = { kind: "root" as const, path: "/state/broomva/.control/asks", branch: null };
    // The same file name as a workspace ledger: two ledgers, never one.
    decisionsNow = [canvas("redeploy", { headline: "Redeploy main's tip?", home: root, hash: "bbbbbbbbbbbbbbbb" })];
    workspaceNow = [canvas("product-name")];
    const view = await open();
    await until(view, "Decision ");
    expect(view.byLabel("All ledgers: 2 open")).not.toBeNull();
    expect(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 1 open")).not.toBeNull();
    await view.press(view.byLabel("broomva/bro-2795-local-first-agentic-canvas.yaml: 1 open"));
    expect(view.text()).toContain("Decision 1 of 1");
    expect(view.text()).toContain("Redeploy main's tip?");
    expect(view.text()).toContain("broomva · bro-2795-local-first-agentic-canvas · ");
    await view.press(view.byLabel("File all four, recommended"));
    await view.press(view.byLabel("Answer redeploy: File all four"));
    expect(sent("ask.answer")).toEqual([
      expect.objectContaining({
        where: { kind: "fleet", scope: "broomva" },
        ledger: "bro-2795-local-first-agentic-canvas.yaml",
        id: "redeploy",
        hash: "bbbbbbbbbbbbbbbb",
      }),
    ]);
    // What it answered names the scope's ledger, not the workspace's of the same name.
    await until(view, "answers are not undone here");
    expect(view.text()).toContain("· broomva · bro-2795-local-first-agentic-canvas · answers are not undone here");
  });

  test("an intent with an ask's full identity opens that ask, of two sharing a ledger and an id in two checkouts", async () => {
    const at = (path: string) => ({ kind: "checkout" as const, path, branch: path.slice(-1) });
    // Two checkouts hold one ledger with the same id (control-home's copies): only the home tells them apart.
    workspaceNow = [
      canvas("redeploy", { headline: "Redeploy, as checkout a has it", home: at("/wt/a") }),
      canvas("redeploy", {
        headline: "Redeploy, as checkout b has it",
        home: at("/wt/b"),
        blocking: true,
        waiting: true,
      }),
    ];
    const view = await open();
    await until(view, "Redeploy, as checkout b has it");
    await step(generation, () =>
      requestIntent({
        kind: "decisions",
        ledger: null,
        id: "redeploy",
        key: JSON.stringify(["/wt/a", "bro-2795-local-first-agentic-canvas.yaml", null, "redeploy"]),
      }),
    );
    // The card's own heading, not Up next, which lists both.
    const headings = () => view.all('[role="heading"]').map((el) => el.textContent);
    for (let tries = 0; tries < 150 && !headings().includes("Redeploy, as checkout a has it"); tries += 1) {
      await settle(20);
    }
    expect(headings()).toContain("Redeploy, as checkout a has it");
    expect(headings()).not.toContain("Redeploy, as checkout b has it");
  });

  test("an intent with the full identity of an ask answered since says so, and shows the first open one", async () => {
    workspaceNow = [canvas("old", { state: "answered", answeredAt: new Date().toISOString() }), canvas("product-name")];
    const view = await open();
    await until(view, "Canvas ask product-name");
    await step(generation, () =>
      requestIntent({
        kind: "decisions",
        ledger: null,
        id: "old",
        // A main-home ask's home key is origin/main (homeKey).
        key: JSON.stringify(["origin/main", "bro-2795-local-first-agentic-canvas.yaml", null, "old"]),
      }),
    );
    await until(view, "That decision is answered now");
    expect(view.text()).toContain("That decision is answered now: showing the first open one.");
  });

  test("a fleet scope's ask answered while the list cannot be read again: the list learns the answer in place", async () => {
    const root = { kind: "root" as const, path: "/state/broomva/.control/asks", branch: null };
    decisionsNow = [canvas("redeploy", { headline: "Redeploy main's tip?", home: root })];
    const view = await open();
    await until(view, "Redeploy main's tip?");
    // Every read after this fails: only the answer's own reply can tell the list.
    workspaceFail = "asks.workspace timed out";
    await view.press(view.byLabel("File all four, recommended"));
    await view.press(view.byLabel("Answer redeploy: File all four"));
    await until(view, "Nothing to decide");
    expect(view.text()).toContain("Open0decisions");
    expect(view.text()).toContain("Answered just now: “File all four”");
  });

  test("an ask with no decision layer: its first sentence leads, the rest behind Full question; answered in words", async () => {
    workspaceNow = [
      canvas("A1", {
        headline: null,
        question: "Rename this session to stoic-bedbug so peers can address it? The name is set only by --name.",
        stakes: null,
        whyYou: null,
        options: [],
        fallback: "continue as stoic-bedbug-9e",
        audit: { class: "external", gates: ["lane-rename"] },
      }),
    ];
    const view = await open(true);
    const text = view.text();
    expect(text).toContain("Rename this session to stoic-bedbug so peers can address it?");
    expect(text).not.toContain("The name is set only by --name.");
    expect(text).toContain("No options were written for this ask: answer it in your own words.");
    expect(text).toContain("If you say nothing: continue as stoic-bedbug-9e");
    await view.press(view.byLabel("Show the full question of A1"));
    expect(view.text()).toContain("The name is set only by --name.");
    await view.press(view.byLabel("Show the details of A1"));
    expect(view.text()).toContain("Class: external");
    expect(view.text()).toContain("Gates: lane-rename");
    expect(view.text()).not.toContain("Tried before asking");
    expect(view.byLabel("Answer A1")?.getAttribute("aria-disabled")).toBe("true");
    await view.type(view.byLabel("Your words for A1"), "Keep the name.");
    await view.press(view.byLabel("Answer A1"));
    expect(sent("ask.answer")).toEqual([expect.objectContaining({ id: "A1", option: null, note: "Keep the name." })]);
    await until(view, "Nothing to decide");
  });

  test("on a phone: the rail is a ledger picker, and the verbs are 44 pt", async () => {
    workspaceNow = [merge(), canvas("product-name")];
    const view = await open(true);
    expect(view.byLabel("All ledgers: 2 open, 1 waits on you")).toBeNull();
    await view.press(view.byLabel("Ledger: All. Change ledger"));
    await view.press(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 1 open"));
    expect(view.text()).toContain("Decision 1 of 1");
    expect(view.text()).toContain("Canvas ask product-name");
    const verb = view.byLabel("Answer product-name") as unknown as { style: { minHeight: string } } | null;
    expect(verb?.style.minHeight).toBe("44px");
    // No keyboard hints on a phone.
    expect(view.text()).not.toContain("UP NEXTJK");
  });

  test("an ask that waits on you shows above the work, and opens Decisions at it", async () => {
    // needs.list holds A1 (blocking); A2 is open but waits on no one (non-blocking, reversible).
    workspaceNow = [
      merge(),
      {
        ...merge(),
        ledger: "other.yaml",
        id: "A2",
        hash: "cccccccccccccccc",
        headline: "Other blocking?",
        askedAt: days(9),
        blocking: false,
        waiting: false,
      },
    ];
    const view = await mount(surface(false));
    // Every view but the Feed (Decide, inline), Decisions and J6's board (a hold in its Needs you tray) shows the notice.
    await view.goto("List");
    await until(view, "A decision waits on you");
    expect(view.text()).toContain("A decision waits on you: Approve merge of PR #863");
    await view.press(view.byLabel("Open Decisions, 1 waiting"));
    await until(view, "Decision ");
    expect(view.viewNow()).toBe("Decisions");
    // At the ask it named; the one that does not wait is up next, not on the card.
    expect(view.text()).toContain("Ask · 2026-10-01-auth-preflight-hook-stderr · A1 · reversible");
    expect(view.byLabel("Go to A2 in other.yaml: Other blocking?")).not.toBeNull();
    expect(view.text()).toContain("Waits on you: it blocks until you answer.");
    // In Decisions the notice is not shown twice.
    expect(view.text()).not.toContain("A decision waits on you");
  });

  test("with a non-blocking ask listed first, the notice names and opens the blocking one (BRO-2852)", async () => {
    // A2 waits without blocking (it recommends what cannot be undone) and waits longest; A1 blocks.
    workspaceNow = [
      merge(),
      {
        ...merge(),
        ledger: "other.yaml",
        id: "A2",
        hash: "cccccccccccccccc",
        headline: "Other ask?",
        askedAt: days(9),
        blocking: false,
        options: [{ id: "go", label: "Go", consequence: "Ships it.", reversible: false, recommended: true }],
      },
    ];

    const view = await mount(surface(false));
    await view.goto("List");
    await until(view, "2 decisions wait on you");
    expect(view.text()).toContain("2 decisions wait on you, 1 blocking: Approve merge of PR #863");
    await view.press(view.byLabel("Open Decisions, 2 waiting"));
    await until(view, "Decision ");
    // It opens the ask it named, not the first one listed.
    expect(view.text()).toContain("Ask · 2026-10-01-auth-preflight-hook-stderr · A1 · reversible");
  });

  test("an intent opens Decisions at a ledger; with nothing open it says so", async () => {
    workspaceNow = [merge(), canvas("product-name")];
    const view = await mount(surface(false));
    await step(generation, () =>
      requestIntent({ kind: "decisions", ledger: "bro-2795-local-first-agentic-canvas.yaml" }),
    );
    await until(view, "Decision ");
    expect(view.viewNow()).toBe("Decisions");
    expect(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 1 open")?.getAttribute("aria-checked")).toBe("true");
    expect(view.text()).toContain("Decision 1 of 1");
    // Gone from under you: the card stays, says so, and waits for you to go on.
    workspaceNow = [];
    await view.refetch();
    await until(view, "This ask is no longer open here");
    await view.press(view.byLabel("Next decision"));
    await until(view, "Nothing to decide");
    expect(view.text()).toContain("No open asks in your workspace's ledgers or the fleet's.");
  });

  test("the card is pinned to its ask: a refetch never swaps it; answered elsewhere, it stays and says so", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    expect(view.text()).toContain("Approve merge of PR #863 touching");
    // A newer blocking ask arrives and sorts first: the card on screen stays.
    workspaceNow = [
      {
        ...merge(),
        ledger: "zz.yaml",
        id: "Z1",
        hash: "zzzzzzzzzzzzzzzz",
        headline: "Newer blocking?",
        askedAt: days(9),
      },
      merge(),
      canvas("q1"),
    ];
    await view.refetch();
    expect(view.text()).toContain("Approve merge of PR #863 touching");
    expect(view.text()).toContain("Ask · 2026-10-01-auth-preflight-hook-stderr · A1 · reversible");
    // Answered from another client: the card stays, read-only, and says so; nothing moves on by itself.
    workspaceNow = workspaceNow.map((ask) =>
      ask.id === "A1"
        ? // Its home moves with the answer (the checkout's copy, now read on origin/main): still the same ask.
          {
            ...ask,
            state: "answered" as const,
            answer: "Merged.",
            answeredAt: new Date().toISOString(),
            home: { kind: "main" as const, path: "/Users/me/broomva", branch: null },
          }
        : ask,
    );
    await view.refetch();
    expect(view.text()).toContain("This was answered elsewhere");
    expect(view.text()).toContain("Approve merge of PR #863 touching");
    expect(view.byLabel("Answer A1")).toBeNull();
    await view.press(view.byLabel("Next decision"));
    expect(view.text()).not.toContain("This was answered elsewhere");
    expect(view.text()).toContain("Canvas ask q1");
    expect(sent("ask.answer")).toEqual([]);
  });

  test("your choice and words are kept per ask while you move between asks", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    await view.press(view.byLabel("Hold PR #863"));
    await view.type(view.byLabel("Your words for A1"), "After the release.");
    await key(view, "j");
    expect(view.text()).toContain("Canvas ask q1");
    await key(view, "k");
    expect(view.byLabel("Hold PR #863")?.getAttribute("aria-checked")).toBe("true");
    expect((view.byLabel("Your words for A1") as unknown as { value: string }).value).toBe("After the release.");
    expect(view.text()).toContain("Answer with 2");
  });

  test("keys act only inside the tab, never take a key outside it, and leave with it", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const doc = win.document as unknown as {
      addEventListener: (...args: unknown[]) => void;
      removeEventListener: (...args: unknown[]) => void;
    };
    const realAdd = doc.addEventListener.bind(doc);
    const realRemove = doc.removeEventListener.bind(doc);
    doc.addEventListener = (...args: unknown[]) => {
      if (args[0] === "keydown" && (args[1] as { name?: string }).name === "onKey") added.push("onKey");
      realAdd(...args);
    };
    doc.removeEventListener = (...args: unknown[]) => {
      if (args[0] === "keydown" && (args[1] as { name?: string }).name === "onKey") removed.push("onKey");
      realRemove(...args);
    };
    try {
      workspaceNow = [merge(), canvas("q1")];
      const view = await open();
      // Outside the tab (the page's body): not taken, nothing moves.
      expect(await key(view, "j", win.document.body)).toBe(false);
      expect(view.text()).toContain("Approve merge of PR #863 touching");
      // Inside it: taken.
      expect(await key(view, "j")).toBe(true);
      expect(view.text()).toContain("Canvas ask q1");
      expect(added).toEqual(["onKey"]);
      await view.goto("Feed");
      expect(removed).toEqual(["onKey"]);
    } finally {
      doc.addEventListener = realAdd;
      doc.removeEventListener = realRemove;
    }
  });

  test("S does nothing where Skip is not offered: the only open ask", async () => {
    workspaceNow = [merge()];
    const view = await open();
    expect(view.byLabel("Skip A1 for now")).toBeNull();
    expect(await key(view, "s")).toBe(false);
    expect(view.text()).not.toContain("Skipped");
  });

  test("two Enters in one frame send one answer", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    await key(view, "1");
    await step(generation, () => {
      const root = view.all("#maestro-decisions")[0] as unknown as { dispatchEvent(event: unknown): boolean };
      root.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      root.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await until(view, "Answered just now");
    expect(sent("ask.answer")).toHaveLength(1);
  });

  test("with motion on, a refetch landing mid-exit neither freezes nor changes the leaving card", async () => {
    setReduced(false);
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    await view.press(view.byLabel("Merge PR #863, recommended"));
    await view.press(view.byLabel("Answer A1: Merge PR #863"));
    await view.refetch();
    // Still the card you answered, as it read, on its way out: not "answered elsewhere", not its answered layout.
    expect(view.text()).not.toContain("This was answered elsewhere");
    expect(view.text()).not.toContain("Your answer");
    await untilGone(view, "Approve merge of PR #863 touching");
    expect(view.text()).toContain("Decision 2 of 2");
    expect(view.text()).toContain("Canvas ask q1");
  });

  test("a focus ring shows for focus from the keyboard, never from a click", async () => {
    const press = async (type: string) =>
      step(generation, () => {
        win.document.dispatchEvent(
          type === "keydown"
            ? new win.KeyboardEvent(type, { key: "Tab" })
            : new win.MouseEvent(type, { bubbles: true }),
        );
      });
    focusRing(theme as never, true);
    await press("keydown");
    expect(focusRing(theme as never, true)).toEqual({
      outlineColor: theme.colors.accent,
      outlineStyle: "solid",
      outlineWidth: 2,
      outlineOffset: 2,
    });
    expect(focusRing(theme as never, false)).toEqual({});
    await press("mousedown");
    expect(focusRing(theme as never, true)).toEqual({});
  });

  test("hit areas on a wide window: the stage's verbs are 36 pt, the order and the ledger chips 28 and 30, Details 40", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    const style = (label: string) =>
      (view.byLabel(label) as unknown as { style: { height: string; minHeight: string } }).style;
    expect(style("Oldest").height).toBe("28px");
    expect(style("All ledgers: 2 open, 1 waits on you").height).toBe("30px");
    expect(style("Answer A1").height).toBe("36px");
    expect(style("Skip A1 for now").height).toBe("36px");
    expect(style("Show the details of A1").minHeight).toBe("40px");
  });
  test("Enter or Space on a focused option selects that option, never answers; a fifth option is reachable", async () => {
    const five = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      label: `Option ${id}`,
      consequence: null,
      reversible: true,
      recommended: false,
    }));
    workspaceNow = [canvas("q1", { options: five, fallback: null })];
    const view = await open();
    await key(view, "1");
    expect(view.byLabel("Option a")?.getAttribute("aria-checked")).toBe("true");
    // Tabbed to option b, Enter: b is chosen, nothing is sent.
    expect(await key(view, "Enter", view.byLabel("Option b"))).toBe(true);
    expect(view.byLabel("Option b")?.getAttribute("aria-checked")).toBe("true");
    expect(sent("ask.answer")).toEqual([]);
    // Space does the same; the fifth option, past the number keys, is reachable so.
    await key(view, " ", view.byLabel("Option e"));
    expect(view.byLabel("Option e")?.getAttribute("aria-checked")).toBe("true");
    expect(sent("ask.answer")).toEqual([]);
    expect(view.text()).toContain("Answer with 5");
  });

  test("while an answer is in flight the tab holds still; a failure lands on the card, which stays answerable", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    let release = () => {};
    answerHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerFail = "the ledger moved under you";
    await key(view, "1");
    await key(view, "Enter");
    expect(sent("ask.answer")).toHaveLength(1);
    // J, Skip and the rail before the reply: nothing moves off the card.
    await key(view, "j");
    await key(view, "s");
    await view.press(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 1 open"));
    expect(view.text()).toContain("Approve merge of PR #863 touching");
    release();
    await until(view, "Not answered");
    expect(view.text()).toContain("Not answered: the ledger moved under you");
    expect(view.byLabel("Answer A1: Merge PR #863")?.getAttribute("aria-disabled")).not.toBe("true");
    // Answerable again: the second try lands, and says so.
    answerHeld = null;
    answerFail = null;
    await view.press(view.byLabel("Answer A1: Merge PR #863"));
    await until(view, "Answered just now");
    expect(sent("ask.answer")).toHaveLength(2);
  });

  test("a skip stands across ledgers: skipped in one, another chosen, back to all", async () => {
    workspaceNow = [merge(), canvas("q1"), canvas("q2")];
    const view = await open();
    await key(view, "s");
    expect(view.text()).toContain("1 skipped");
    await view.press(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 2 open"));
    await view.press(view.byLabel("All ledgers: 3 open, 1 waits on you"));
    expect(view.text()).toContain("1 skipped");
    expect(view.text()).toContain("Canvas ask q1");
  });

  test("an option that cannot be undone asks for a deliberate second press; Esc or another option calls it off", async () => {
    workspaceNow = [canvas("q1")];
    const view = await open();
    await view.press(view.byLabel("Drop all four, cannot be undone"));
    await view.press(view.byLabel("Answer q1: Drop all four"));
    expect(view.text()).toContain("Confirm — cannot be undone");
    expect(sent("ask.answer")).toEqual([]);
    await key(view, "Escape");
    expect(view.text()).not.toContain("Confirm — cannot be undone");
    await view.press(view.byLabel("Answer q1: Drop all four"));
    await view.press(view.byLabel("File all four, recommended"));
    expect(view.text()).not.toContain("Confirm — cannot be undone");
    await view.press(view.byLabel("Drop all four, cannot be undone"));
    await view.press(view.byLabel("Answer q1: Drop all four"));
    // A second press in the same breath is not deliberate.
    await view.press(view.byLabel("Confirm q1: Drop all four, cannot be undone"));
    expect(sent("ask.answer")).toEqual([]);
    await settle(450);
    await view.press(view.byLabel("Confirm q1: Drop all four, cannot be undone"));
    expect(sent("ask.answer")).toEqual([expect.objectContaining({ id: "q1", option: "drop" })]);
  });

  test("an open ask that moves home stays on screen at its new identity, with your choice and words (by its uid)", async () => {
    workspaceNow = [{ ...merge(), uid: "u-merge" }, canvas("q1")];
    const view = await open();
    await view.press(view.byLabel("Hold PR #863"));
    await view.type(view.byLabel("Your words for A1"), "After the release.");
    workspaceNow = [
      { ...merge(), uid: "u-merge", home: { kind: "main", path: "/Users/me/broomva", branch: null } },
      canvas("q1"),
    ];
    await view.refetch();
    expect(view.text()).not.toContain("no longer open");
    expect(view.byLabel("Hold PR #863")?.getAttribute("aria-checked")).toBe("true");
    expect((view.byLabel("Your words for A1") as unknown as { value: string }).value).toBe("After the release.");
    await view.press(view.byLabel("Answer A1: Hold PR #863"));
    expect(sent("ask.answer")).toEqual([
      expect.objectContaining({ where: { kind: "workspace", home: "origin/main" }, id: "A1", option: "hold" }),
    ]);
  });

  test("an answered copy wins over a moved one; without a uid nothing is re-pinned, it says answered or moved", async () => {
    workspaceNow = [{ ...merge(), uid: "u-merge" }, canvas("q1")];
    const view = await open();
    // Answered at one home, still open at another: answered elsewhere, never "moved".
    workspaceNow = [
      {
        ...merge(),
        uid: "u-merge",
        state: "answered",
        answerOption: "hold",
        home: { kind: "main", path: "/m", branch: null },
      },
      { ...merge(), uid: "u-merge", home: { kind: "checkout", path: "/other", branch: "feat/y" } },
      canvas("q1"),
    ];
    await view.refetch();
    expect(view.text()).toContain("This was answered elsewhere: “Hold PR #863”");
    // With no uid, ledger and id alone never re-pin: it says so and waits for Next.
    workspaceNow = [merge(), canvas("q1")];
    const other = await open();
    workspaceNow = [{ ...merge(), home: { kind: "main", path: "/Users/me/broomva", branch: null } }, canvas("q1")];
    await other.refetch();
    expect(other.text()).toContain("This was answered or moved: it is no longer open here.");
    expect(other.byLabel("Answer A1")).toBeNull();
    await other.press(other.byLabel("Next decision"));
    expect(sent("ask.answer")).toEqual([]);
  });

  test("an answer in flight outlives the tab: leave and come back, it is still in flight, a focus waits, the result lands", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    let release = () => {};
    answerHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerFail = "the ledger moved under you";
    await key(view, "1");
    await key(view, "Enter");
    await view.goto("Feed");
    await view.goto("Decisions");
    await until(view, "Decision ");
    // Still in flight: the verb is busy (a spinner, and disabled), and nothing can answer again.
    const verb = view.all('[aria-label^="Answer A1"]')[0];
    expect(verb?.getAttribute("aria-disabled")).toBe("true");
    expect(verb?.querySelector('[role="progressbar"]')).not.toBeNull();
    // The options hold still too: the in-flight answer is read from the mutation cache, not this new card.
    expect(view.byLabel("Hold PR #863")?.getAttribute("aria-disabled")).toBe("true");
    await key(view, "Enter");
    expect(sent("ask.answer")).toHaveLength(1);
    release();
    // The failure lands on the card that came back, which unlocks and stays answerable.
    await until(view, "Not answered");
    expect(view.text()).toContain("Not answered: the ledger moved under you");
    expect(view.all('[aria-label^="Answer A1"]')[0]?.getAttribute("aria-disabled")).not.toBe("true");
    // In flight again, a focus fired meanwhile waits for the reply, then is taken.
    answerHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerFail = null;
    await key(view, "Enter");
    expect(sent("ask.answer")).toHaveLength(2);
    await step(generation, () => requestIntent({ kind: "decisions", ledger: null, id: "q1" }));
    await settle(50);
    expect(view.text()).toContain("Approve merge of PR #863 touching");
    release();
    await untilGone(view, "Approve merge of PR #863 touching");
    expect(view.text()).toContain("Canvas ask q1");
  });

  test("back on the tab with an answer in flight, that ask is the card, wherever the order puts it", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    let release = () => {};
    answerHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await key(view, "j");
    await key(view, "1");
    await key(view, "Enter");
    await view.goto("Feed");
    await view.goto("Decisions");
    await until(view, "Decision ");
    expect(view.text()).toContain("Canvas ask q1");
    expect(view.all('[aria-label^="Answer q1"]')[0]?.querySelector('[role="progressbar"]')).not.toBeNull();
    release();
    await until(view, "You answered this");
    expect(view.text()).toContain("You answered this: “File all four”. Answers are not undone here.");
    expect(view.text()).not.toContain("answered elsewhere");
  });

  test("an answer that lands after you left is in the list when you come back, never 'answered elsewhere'", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    let release = () => {};
    answerHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await key(view, "1");
    await key(view, "Enter");
    await view.goto("Feed");
    release();
    await settle(60);
    await view.goto("Decisions");
    await until(view, "Canvas ask q1");
    // The reply landed with no card on screen: the list learned it (one open), and the card is the next ask.
    expect(view.text()).toContain("Open1decision");
    expect(view.text()).not.toContain("answered elsewhere");
    expect(view.text()).not.toContain("Approve merge of PR #863");
    expect(sent("ask.answer")).toHaveLength(1);
  });

  test("a held Enter never sends a confirm; Escape is taken only while a confirm is armed", async () => {
    workspaceNow = [canvas("q1")];
    const view = await open();
    // Nothing armed: Escape is left to the host.
    expect(await key(view, "Escape")).toBe(false);
    await key(view, "2");
    await key(view, "Enter");
    expect(view.text()).toContain("Confirm — cannot be undone");
    await settle(450);
    // The same key, held down: repeats, never a second deliberate press.
    await key(view, "Enter", undefined, { repeat: true });
    await key(view, "Enter", undefined, { repeat: true });
    expect(sent("ask.answer")).toEqual([]);
    expect(await key(view, "Escape")).toBe(true);
    expect(view.text()).not.toContain("Confirm — cannot be undone");
    expect(await key(view, "Escape")).toBe(false);
  });

  test("a focus on an ask newer than the list waits for one more read; one never found says so", async () => {
    workspaceNow = [merge()];
    const view = await open();
    workspaceNow = [merge(), canvas("late")];
    await step(generation, () =>
      requestIntent({ kind: "decisions", ledger: "bro-2795-local-first-agentic-canvas.yaml", id: "late" }),
    );
    await until(view, "Canvas ask late");
    expect(view.text()).toContain("Ask · bro-2795-local-first-agentic-canvas");
    expect(view.text()).not.toContain("isn't in the list yet");
    await step(generation, () => requestIntent({ kind: "decisions", ledger: null, id: "nowhere" }));
    await until(view, "isn't in the list yet");
    expect(view.text()).toContain("That decision isn't in the list yet: showing the first one.");
  });

  test("a failed refresh keeps the tab with a quiet note, not the error page", async () => {
    workspaceNow = [merge()];
    const view = await open();
    workspaceFail = "git fetch timed out";
    await view.refetch();
    await until(view, "Could not refresh");
    expect(view.text()).toContain("Could not refresh (git fetch timed out): showing what was read before.");
    expect(view.text()).toContain("Approve merge of PR #863 touching");
    expect(view.text()).not.toContain("could not be read");
  });

  test("answered elsewhere, the card says with what", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    workspaceNow = [{ ...merge(), state: "answered", answerOption: "hold", answer: "Hold it." }, canvas("q1")];
    await view.refetch();
    expect(view.text()).toContain("This was answered elsewhere: “Hold PR #863”. Nothing was sent from here.");
  });

  test("a chosen ledger whose last ask is answered says so, with a way back to all", async () => {
    workspaceNow = [merge(), canvas("q1")];
    const view = await open();
    await view.press(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 1 open"));
    expect(view.byLabel("bro-2795-local-first-agentic-canvas.yaml: 1 open")?.getAttribute("aria-checked")).toBe("true");
    await view.press(view.byLabel("File all four, recommended"));
    await view.press(view.byLabel("Answer q1: File all four"));
    await until(view, "Nothing open in");
    expect(view.text()).toContain("Nothing open in bro-2795-local-first-agentic-canvas");
    await view.press(view.byLabel("All ledgers · 1 open"));
    expect(view.text()).toContain("Approve merge of PR #863 touching");
  });
});

describe("Initiatives", () => {
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
  /** The tab loads on its own query once it opens: waited for, never assumed, on a slow runner. */
  const until = async (view: Awaited<ReturnType<typeof mount>>, text: string) => {
    for (let tries = 0; tries < 150 && !view.text().includes(text); tries += 1) await settle(20);
  };
  // The card and the ideas are the phone's list as well as J8's expanded row: their rules are tested on the list.
  const open = async (compact = true) => {
    const view = await mount(surface(compact));
    await view.goto("Initiatives");
    await until(view, "mod-anything skill");
    return view;
  };

  test("a card shows every field: title, intent, status, review date with its badge, next action, driver, waits, links, local edit, ideas", async () => {
    const view = await open();
    const text = view.text();
    for (const part of [
      "3 initiatives · 1 needs you · 1 cannot be read · 2 open ideas",
      "mod-anything skill",
      "Waits on you",
      "Intent not stated: the owner's words were not written down",
      "Review by 2026-10-01",
      "Overdue",
      "Next: Next for mod-anything",
      "Driven by the coordinator f5307ce7",
      "Your answer to maestro-paseo-gaps.yaml A10",
      "Your step: pick a path on the P20 stop",
      "The PR broomva/skills#267",
      "broomva/skills#267 · open",
      "BRO-2808",
      "deadbeef (not a session on this Paseo)",
      "Edited in /Users/me/wt/park-mods (feat/park), not on origin/main yet: status, wake. There it is parked.",
      "3 ideas: 2 open, 1 triaged",
      "Done when: Done.",
      // A quote is the owner's words with their source; the sentinel is never dressed as one.
      "“the work we start get forgotten” — owner, 2026-10-03",
      // A file that cannot be read is a row with the reason, never hidden.
      "This initiative cannot be read, so it is shown as it is: broken.yaml: it has a YAML error",
    ]) {
      expect(text).toContain(part);
    }
    expect(view.byLabel("mod-anything skill: Overdue")).not.toBeNull();
    expect(view.byLabel("Fleet autonomy: Overdue")).toBeNull();
  });

  test("links open where they point: Linear, the PR, the session; a waiting PR opens too", async () => {
    const view = await open();
    await view.press(view.byLabel("Open BRO-2808 in Linear"));
    await view.press(view.byLabel("Open the PR broomva/skills#267, open"));
    await view.press(view.byLabel("Open the PR broomva/skills#267"));
    expect(urls).toEqual([
      "https://linear.app/broomva/issue/BRO-2808",
      "https://github.com/broomva/skills/pull/267",
      "https://github.com/broomva/skills/pull/267",
    ]);
    await view.press(view.byLabel("Open the session 445aac2a"));
    expect(opened).toEqual(["445aac2a-full-agent-id"]);
    // A session no agent here answers to has no button that would open nothing.
    expect(view.byLabel("Open the session deadbeef")).toBeNull();
  });

  test("an ask it waits on opens in Decisions, at its ledger and at that ask", async () => {
    // Eleven open asks elsewhere, which would come first; the tab opens at the ledger the initiative names.
    workspaceNow = [
      ...Array.from({ length: 11 }, (_, at) => ({
        ...decisionFixture(),
        ledger: "other.yaml",
        arc: "other",
        id: `O${at}`,
        blocking: true,
        home: { kind: "main" as const, path: "/Users/me/broomva", branch: null },
        origin: null,
      })),
      { ...decisionFixture(), home: { kind: "main" as const, path: "/Users/me/broomva", branch: null }, origin: null },
    ];
    // On the desktop (J8): the row opens its card, whose link goes to Decisions.
    const view = await open(false);
    await view.press(view.all('[aria-label^="Initiative: mod-anything skill"]')[0]);
    await view.press(view.byLabel("Open maestro-paseo-gaps.yaml#A10 in Decisions"));
    await until(view, "Decision ");
    expect(view.viewNow()).toBe("Decisions");
    expect(view.byLabel("maestro-paseo-gaps.yaml: 1 open")?.getAttribute("aria-checked")).toBe("true");
    expect(view.text()).toContain("Decision 1 of 1");
    expect(view.text()).toContain("Four small review follow-ups");
  });

  test("an idea answered develop is sent through ask.answer at its home, and its held work opens", async () => {
    const view = await open();
    await view.press(view.byLabel("Show the ideas for mod-anything"));
    expect(view.text()).toContain("Build idea I1, or park it?");
    expect(view.text()).toContain("mod-anything · from report docs/reports/beyond-games.html · evidence BRO-2810");
    // The triaged one waits behind its own button.
    expect(view.text()).not.toContain("Build idea I3");
    await view.press(view.byLabel("Show 1 triaged"));
    // Answered develop outside Maestro: no work item is filed for it, and the card says so and offers to file it.
    expect(view.text()).toContain("Developed on 2026-10-05. No work item is filed for it in Maestro yet.");
    expect(view.byLabel("Open the work filed for I3")).toBeNull();
    await view.press(view.byLabel("File the work for I3"));
    expect(sent("initiatives.file")).toEqual([{ ledger: "ideas-mod-anything.yaml", id: "I3", home: "origin/main" }]);
    expect(view.text()).toContain("Developed on 2026-10-05: a work item was filed for it, held for you to start.");
    expect(view.byLabel("File the work for I3")).toBeNull();
    await view.press(view.byLabel("Open the work filed for I3"));
    await view.press(view.byLabel("Open the evidence for I1, BRO-2810"));
    expect(urls).toEqual(["https://linear.app/broomva/issue/BRO-2810"]);
    expect(view.byLabel("Answer I1")?.getAttribute("aria-disabled")).toBe("true");
    await view.press(view.byLabel("Develop for I1"));
    await view.type(view.byLabel("Your words for I1"), "start with the recon scan");
    await view.press(view.byLabel("Answer I1: Develop"));
    expect(sent("ask.answer")).toEqual([
      {
        where: { kind: "workspace", home: "origin/main" },
        ledger: "ideas-mod-anything.yaml",
        uid: null,
        id: "I1",
        hash: "hash-I1",
        option: "develop",
        note: "start with the recon scan",
      },
    ]);
    expect(view.text()).toContain("Developed on");
    await view.press(view.byLabel("Open the work filed for I1"));
    expect(view.text()).toContain("Work d");
  });

  test("only a develop shows its work: a parked idea whose ref has an item does not", async () => {
    const parked = ideaFixture("I3", {
      state: "answered",
      answerOption: "park",
      answer: "Park until 2099-01-10",
      answeredAt: "2026-10-05T13:34:21Z",
    });
    initiativesNow = {
      ...initiativesNow,
      ideas: initiativesNow.ideas.map((entry) => (entry.id === "I3" ? parked : entry)),
      developed: [{ ref: "ideas-mod-anything.yaml#I3", id: "w3", title: "Work w3", path: "mod-anything/w3" }],
    };
    const view = await open();
    await view.press(view.byLabel("Show the ideas for mod-anything"));
    await view.press(view.byLabel("Show 1 triaged"));
    expect(view.text()).toContain("Parked on 2026-10-05 until 2099-01-10.");
    expect(view.byLabel("Open the work filed for I3")).toBeNull();
    expect(view.byLabel("File the work for I3")).toBeNull();
  });

  test("park takes a wake date: the idea's own by default, a bad or past one refused before it is sent", async () => {
    const view = await open();
    await view.press(view.byLabel("All ideas (2 open)"));
    await view.press(view.byLabel("Park until 2099-01-10, recommended for I2"));
    const wake = view.byLabel("The wake date for I2");
    expect(wake?.getAttribute("value")).toBe("2099-01-10");
    await view.type(wake, "2026-10-01");
    expect(view.text()).toContain("Choose today or a later day.");
    expect(view.byLabel("Answer I2: Park until 2099-01-10")?.getAttribute("aria-disabled")).toBe("true");
    await view.type(wake, "soon");
    expect(view.text()).toContain("Write the date as YYYY-MM-DD.");
    await view.type(wake, "2099-03-04");
    await view.press(view.byLabel("Answer I2: Park until 2099-01-10"));
    expect(sent("ask.answer")).toEqual([
      {
        where: { kind: "workspace", home: "origin/main" },
        ledger: "ideas-mod-anything.yaml",
        uid: null,
        id: "I2",
        hash: "hash-I2",
        option: "park",
        note: "",
        wake: "2099-03-04",
      },
    ]);
    expect(view.text()).toContain("until 2099-03-04.");
    // Kill and switching back: every option is a press, and the tab's own switch returns to the cards.
    await view.press(view.byLabel("Kill for I1"));
    await view.press(view.byLabel("Answer I1: Kill"));
    expect((sent("ask.answer")[1] as { option: string }).option).toBe("kill");
    await view.press(view.byLabel("By initiative"));
    expect(view.text()).toContain("Fleet autonomy");
  });

  test("an initiative past its date shows where Maestro says what needs you, and opens the tab; ideas stay out of Decisions", async () => {
    // Due for review (B2): needs.list raises it as an ask, which the band says and the header counts.
    reviewsNow = [
      {
        ...(initiativesNow.initiatives.find((entry) => entry.id === "mod-anything") as Initiative),
        stale: { kind: "overdue", date: "2026-10-01" },
      },
    ];
    workspaceNow = [ideaFixture("I9", { home: { kind: "main", path: "/Users/me/broomva", branch: null } })];
    const view = await mount(surface(true));
    for (let tries = 0; tries < 150 && !view.text().includes("has passed"); tries += 1) await settle(20);
    expect(view.text()).toContain(
      "Review mod-anything skill: keep, park or close? Its review date, 2026-10-01, has passed.",
    );
    await view.press(view.byLabel("Open Initiatives, 1 need a look"));
    await until(view, "mod-anything skill");
    expect(view.viewNow()).toBe("Initiatives");
    expect(view.text()).not.toContain("Its review date, 2026-10-01, has passed.");
    // The idea is answered here, never twice: Decisions does not list it.
    await view.goto("Decisions");
    await until(view, "Nothing to decide");
    expect(view.text()).not.toContain("Build idea I9");
  });

  test("what folds, folds back; a read that fails says why and tries again", async () => {
    const view = await open();
    await view.press(view.byLabel("Show the ideas for mod-anything"));
    await view.press(view.byLabel("Show 1 triaged"));
    expect(view.text()).toContain("Build idea I3");
    await view.press(view.byLabel("Hide the triaged"));
    expect(view.text()).not.toContain("Build idea I3");
    await view.press(view.byLabel("Hide the ideas for mod-anything"));
    expect(view.text()).not.toContain("Build idea I1");

    initiativesFail = "the control repo is gone";
    const broken = await mount(surface(false));
    await broken.goto("Initiatives");
    await until(broken, "could not be read");
    expect(broken.text()).toContain("Your initiatives could not be read: the control repo is gone");
    initiativesFail = null;
    await broken.press(broken.byLabel("Try again"));
    await until(broken, "mod-anything skill");
    expect(broken.text()).toContain("mod-anything skill");
  });
});

describe("the Feed home (BRO-2906)", () => {
  const until = async (view: Awaited<ReturnType<typeof mount>>, text: string) => {
    for (let tries = 0; tries < 150 && !view.text().includes(text); tries += 1) await settle(20);
  };
  const handledAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const withHandled = () => [
    ...fixture(),
    work("h", "done", {
      title: "SRI: STI-3569 typography cap",
      closed: { by: "maestro", at: handledAt },
      adoptedBy: { by: "SRI Orchestrator" },
    }),
  ];

  test("its sections, in order, under a header that says what was handled for you", async () => {
    items = withHandled();
    const view = await mount(surface(true));
    const headings = view.all('[role="heading"]').map((el) => el.textContent);
    const order = ["Needs you", "Stuck", "Running", "Queued", "Handled for you", "Done"].map((name) =>
      headings.indexOf(name),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // needs.list's total and handled.list's rows for you (BRO-3001).
    expect(view.text()).toContain("2 need you · 1 running · 1 handled for you");
    expect(view.text()).toContain("From their orchestrators: 1 arc closed");
    expect(view.byLabel("Done: SRI: STI-3569 typography cap. SRI Orchestrator: Done")).not.toBeNull();
    // Maestro's own closes (an auto gate, a finished arc) are handled for you too: not "by their orchestrator".
    expect(view.text()).toContain("closed without you this week");
    expect(view.text()).toContain("STI-3569 typography cap");
    expect(view.text()).toContain("today 1 · this week 1");
    // The Done list opens on demand.
    expect(view.text()).not.toContain("Work f");
    expect(view.byLabel("Show the 1 done item")?.getAttribute("aria-expanded")).toBe("false");
    // An icon-only toggle is a 32 px target: react-native-web ignores hitSlop.
    expect(view.byLabel("Show the 1 done item")?.getAttribute("style")).toContain("min-width: 32px");
    await view.press(view.byLabel("Show the 1 done item"));
    expect(view.text()).toContain("Work f");
    expect(view.byLabel("Hide the 1 done item")?.getAttribute("aria-expanded")).toBe("true");
  });

  test("a card at your gate: its branch, its ask, Needs you and its verb, with no button inside the card", async () => {
    const view = await mount(surface(true));
    const card = view.byLabel("Work a, Needs you, hawthorne · core, updated 12 minutes ago");
    expect(card?.textContent).toContain("maestro/a-1");
    expect(card?.textContent).toContain("Approve the branch");
    expect(card?.textContent).toContain("Needs you");
    expect(card?.textContent).toContain("Answer");
    // The one button says what it opens to, and the ask, to a screen reader too.
    const described = (card?.getAttribute("aria-describedby") ?? "").split(" ").map((id) => view.byId(id)?.textContent);
    expect(described).toEqual(["Answer", "Approve the branch"]);
    expect(card?.querySelectorAll('[role="button"]').length).toBe(0);
    await view.press(card);
    // On a phone it opens the work over the list, with a way back.
    expect(view.byLabel("Back to all work")).not.toBeNull();
  });

  test("an ask that waits on you is a hold under Needs you; Decide lists the open ones that do not; each opens Decisions", async () => {
    workspaceNow = [
      { ...decisionFixture(), ledger: "plain.yaml", id: "B1", hash: "bbbbbbbbbbbbbbbb", headline: "A plain ask?" },
      {
        ...decisionFixture(),
        ledger: "gate.yaml",
        id: "A1",
        hash: "aaaaaaaaaaaaaaaa",
        headline: "Merge the gate fix?",
        blocking: true,
        waiting: true,
        fallback: "hold",
        options: [
          { id: "merge", label: "Merge it", consequence: "", reversible: true, recommended: true },
          { id: "hold", label: "Hold it", consequence: "", reversible: true, recommended: false },
        ],
      },
    ];
    const view = await mount(surface(true));
    await until(view, "Merge the gate fix?");
    const rows = view.all('[aria-label^="Decide: "]').map((el) => el.getAttribute("aria-label"));
    expect(rows).toEqual(["Decide: Merge the gate fix?", "Decide: A plain ask?"]);
    // The waiting one is needs.list's row, in Needs you; the plain one is Decide's, said to wait on no one.
    const needsYou = view.all('[role="heading"]').find((el) => el.textContent === "Needs you")
      ?.parentElement?.parentElement;
    expect(needsYou?.textContent).toContain("Merge the gate fix?");
    expect(needsYou?.textContent).not.toContain("A plain ask?");
    expect(view.text()).toContain("open, not waiting on you");
    expect(view.text()).toContain("blocks work");
    expect(view.text()).toContain("silent → Hold it");
    // Decide replaces the notice on the Feed: said once.
    expect(view.text()).not.toContain("A decision waits on you");
    await view.press(view.byLabel("Decide: Merge the gate fix?"));
    await until(view, "Decision ");
    expect(view.viewNow()).toBe("Decisions");
  });

  test("the search keeps what matches its title, place or branch, and says when nothing does", async () => {
    const view = await mount(surface(true));
    const field = view.byLabel("Find work, ticket or branch");
    await view.type(field, "genesis");
    expect(view.text()).toContain("Work c");
    expect(view.text()).not.toContain("Work a");
    await view.type(field, "maestro/a-1");
    expect(view.text()).toContain("Work a");
    expect(view.text()).not.toContain("Work c");
    await view.type(field, "nothing like it");
    expect(view.text()).toContain("No work matches “nothing like it”.");
    expect(view.byLabel("Clear the search")?.getAttribute("style")).toContain("min-height: 32px");
    await view.press(view.byLabel("Clear the search"));
    expect(view.text()).toContain("Work c");
  });

  test("the scope menu lists the initiatives and narrows the feed to one", async () => {
    const view = await mount(surface(true));
    await view.press(view.byLabel("Scope: all scopes"));
    const items = () => view.all('[role="menuitemradio"]');
    expect(items().map((el) => el.textContent?.split(/\d/)[0])).toEqual(["All scopes", "genesis", "hawthorne"]);
    expect(items().map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await view.press(items().find((el) => el.textContent?.startsWith("genesis")));
    expect(view.byLabel("Scope: genesis")).not.toBeNull();
    expect(view.text()).toContain("Work c");
    expect(view.text()).not.toContain("Work a");
  });
});

describe("Loops", () => {
  const until = async (view: Awaited<ReturnType<typeof mount>>, text: string) => {
    for (let tries = 0; tries < 150 && !view.text().includes(text); tries += 1) await settle(20);
  };

  test("one row per loop: intent beside observed, a drift badge, owner and purpose; a row opens its pinned fix", async () => {
    const view = await mount(surface(false));
    await view.goto("Loops");
    await until(view, "kg-lint");
    const text = view.text();
    for (const part of [
      "origin/main:.broomva/loops @ 4c744b7",
      "2 loops; 1 needs you, 1 drifting.",
      ".broomva/loops/bad.yaml: unknown key colour",
      "kg-lint",
      "Paused but running",
      "Paused · owner",
      "On · ok",
      "Lint every entity page.",
      "maestro-wake",
      "Session & watchers",
      "p9 PR #11 broomva/skene",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("launchctl bootout");
    await view.press(view.byLabel("Knowledge-graph weekly lint. Paused · owner. On · ok. Drift: PAUSED_BUT_RUNNING."));
    expect(view.text()).toContain(
      "launchctl bootout gui/$UID/com.broomva.kg-lint && launchctl disable gui/$UID/com.broomva.kg-lint",
    );
  });

  test("loop drift that needs you sits above the other views and opens the tab", async () => {
    loopNoticesNow = [
      {
        id: "loop:kg-lint#paused_but_running",
        subject: "loop:kg-lint",
        loop: "kg-lint",
        kind: "paused_but_running",
        detail: "It is paused in the ledger, and launchd will run it.",
        fix: "launchctl bootout gui/$UID/com.broomva.kg-lint",
      },
    ];
    const view = await mount(surface(false));
    // On the Feed home it is a watched row under Health, with the loop's words.
    await until(view, "kg-lint: Paused but running");
    await view.press(view.byLabel("Health: kg-lint: Paused but running"));
    await until(view, "Session & watchers");
    expect(view.text()).toContain("Session & watchers");
  });
});

describe("Allow and Deny, and Change course: approval.decide and its undo (BRO-2999)", () => {
  const permission = { requestId: "r1", title: "Run a command", detail: "git push origin main" };
  const ACTION = "Run a command: git push origin main";
  const asking = (id: string) =>
    work(id, "review", {
      worker: worker(id, `maestro/${id}-1`),
      phase: "asking",
      landing: 3,
      permission,
      look: { ran: "4m unsupervised · 1 turn · paused on a question", decided: [], ask: ACTION },
    });
  const detail = (id: string) => (
    <WorkDetail id={id} theme={theme} compact={false} navigation={undefined} open={requestIntent} />
  );
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
  const card = async (id: string) => {
    const Card = createGateCard(() => undefined);
    const props = {
      item: { data: { workId: id, landing: 3, agentId: `ag-${id}` } },
      theme,
      layout: { compact: false },
    } as unknown as ComponentProps<typeof Card>;
    const view = await mount(<Card {...props} />);
    for (let tries = 0; tries < 100 && !view.byLabel("Allow"); tries += 1) await settle(20);
    return view;
  };

  for (const [where, open] of [
    ["the work's detail", async () => mount(detail("k"))],
    ["the card in the session", async () => card("k")],
  ] as const) {
    test(`Allow in ${where} is approval.decide on the exact action, with a countdown and an Undo`, async () => {
      items = [...fixture(), asking("k")];
      const view = await open();
      for (let tries = 0; tries < 100 && !view.byLabel("Allow"); tries += 1) await settle(20);
      await view.press(view.byLabel("Allow"));
      expect(sent("approval.decide")).toEqual([{ key: "work:k", allow: true, action: ACTION, requestId: "r1" }]);
      for (let tries = 0; tries < 100 && !view.text().includes("takes effect in"); tries += 1) await settle(20);
      expect(view.text()).toContain(`Allowed ${ACTION} · takes effect in`);
      // One decision at a time: both verbs wait while it does, so a second press sends nothing.
      await view.press(view.byLabel("Deny"));
      await view.press(view.byLabel("Allow"));
      expect(sent("approval.decide")).toHaveLength(1);
      await view.press(view.byLabel(`Undo: Allowed ${ACTION}`));
      expect(sent("verb.undo")).toEqual([{ receipt: "r-1" }]);
      for (let tries = 0; tries < 100 && view.text().includes("takes effect in"); tries += 1) await settle(20);
      expect(view.text()).not.toContain("takes effect in");
    });

    test(`Deny in ${where} is approval.decide with allow false`, async () => {
      items = [...fixture(), asking("k")];
      const view = await open();
      for (let tries = 0; tries < 100 && !view.byLabel("Deny"); tries += 1) await settle(20);
      await view.press(view.byLabel("Deny"));
      expect(sent("approval.decide")).toEqual([{ key: "work:k", allow: false, action: ACTION, requestId: "r1" }]);
    });
  }

  test("finished work offers Change course and Cancel work, and never Approve", async () => {
    items = [...fixture(), work("fin", "review", { permission: null, worker: worker("fin", "maestro/fin-1"), look })];
    const view = await mount(detail("fin"));
    for (let tries = 0; tries < 100 && !view.byLabel("Change course"); tries += 1) await settle(20);
    expect(view.text()).toContain("Finished");
    expect(view.byLabel("Change course")).not.toBeNull();
    expect(view.byLabel("Cancel work")).not.toBeNull();
    expect(view.byLabel("Approve")).toBeNull();
    expect(view.byLabel("Allow")).toBeNull();
    await view.press(view.byLabel("Change course"));
    await view.type(view.byLabel("What should change"), "Use the cache.");
    await view.press(view.byLabel("Change course"));
    expect(sent("work.verdict")).toEqual([{ id: "fin", verdict: "revise", note: "Use the cache." }]);
  });

  test("the session card for finished work says Finished, offers Change course, and no Approve", async () => {
    items = [
      ...fixture(),
      work("fin", "review", { permission: null, worker: worker("fin", "maestro/fin-1"), look, landing: 3 }),
    ];
    const Card = createGateCard(() => undefined);
    const props = {
      item: { data: { workId: "fin", landing: 3, agentId: "ag-fin" } },
      theme,
      layout: { compact: false },
    } as unknown as ComponentProps<typeof Card>;
    const view = await mount(<Card {...props} />);
    for (let tries = 0; tries < 100 && !view.byLabel("Change course"); tries += 1) await settle(20);
    expect(view.text()).toContain("Finished");
    expect(view.byLabel("Approve")).toBeNull();
  });
});
