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
import type { ReactNode } from "react";
import type { MaestroConfig, Scoreboard, WakeEntry, WorkItem } from "../shared/contracts";
import {
  type AskNotice,
  type AskSession,
  type DecisionAsk,
  type FleetNotice,
  type FleetProposal,
  type FleetView,
  groupProposals,
} from "../shared/fleet";
import type { Initiative, InitiativeNotice, InitiativesView } from "../shared/initiatives";
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
    useToast: () => ({ show() {}, error() {} }),
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
const { requestIntent, resetIntents, takeIntent } = await import("./intent");
const { MaestroSettings } = await import("./settings");
const { attentionOf } = await import("../server/attention");
const { headerFace, needsYou } = await import("./header-count");
const { linkSettings } = await import("./settings-link");
const { LOOP_HINT: LOOP_SETTINGS_HINT } = await import("./loop-model");

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
    permission: null,
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
let items = fixture();

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
/** While set, fleet.get answers only once it resolves: a refetch still on its way. */
let fleetHeld: Promise<void> | null = null;
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
/** The asks work.attention says wait on you: none unless a test says. */
let askNoticesNow: AskNotice[] = [];
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
let initiativeNoticesNow: InitiativeNotice[] = [];
/** While set, initiatives.list fails with it. */
let initiativesFail: string | null = null;
/** URLs the surface asked the host to open. */
const urls: string[] = [];
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
      health: missed,
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
              },
            ]
          : [],
      decisions: id === "broomva" ? decisionsNow : [],
      askRoot: `/state/${id}/.control/asks`,
      alerts: [],
      warnings: [],
    },
  };
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
const calls: { method: string; input: unknown }[] = [];
const invoke = async (method: string, input: unknown) => {
  calls.push({ method, input });
  if (method === "work.stop" && stopHeld) await stopHeld;
  if (method === "work.stop" && stopRefusal && !(input as { discard?: boolean }).discard) {
    throw new Error(stopRefusal);
  }
  if (method === "loop.get") return loopState;
  if (method === "loop.wake") return nextWake();
  if (method === "config.get") return settings;
  if (method === "config.set") return input;
  if (method === "work.list") return { root: "/work", items, warnings: [], scoreboard: board() };
  if (method === "work.history") return { events: history(), capped: false };
  if (method === "work.attention") {
    return {
      waiting: [],
      sessions: [],
      fleet: fleetNotices,
      timeline: timelineNotices,
      asks: askNoticesNow,
      initiatives: initiativeNoticesNow,
    };
  }
  if (method === "asks.workspace") {
    return {
      controlRepo: "/Users/me/broomva",
      main: { sha: "1c7740c5", fetchedAt: null },
      decisions: workspaceNow,
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
  if (method === "ask.answer") {
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
  if (method === "work.files") return { files };
  if (method === "work.file") {
    const { name } = input as { name: string };
    if (name === "image.png") throw new Error(`Request failed: ${name} is a binary file, so it is not shown.`);
    if (name === "run.log") return { name, text: "step 1\nstep 2\n", truncated: true };
    return { name, text: "# Work a\n\nStore it on the Run record.\n", truncated: false };
  }
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
const surface = (compact: boolean) => (
  <MaestroSurface
    theme={theme}
    host={{ id: "h", label: "h" }}
    layout={{ compact, platform: "web" }}
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
  return {
    text: () => container.textContent ?? "",
    byLabel,
    tabs: () => [...container.querySelectorAll('[role="tab"]')],
    pressed: (label: string) => byLabel(label)?.getAttribute("aria-pressed"),
    all: (selector: string) => [...container.querySelectorAll(selector)],
    press: async (target: Element | null | undefined) => {
      if (!target) throw new Error("nothing to press");
      await step(owner, () => (target as unknown as { click(): void }).click());
      await step(owner, () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    },
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
    rings: () => [...container.querySelectorAll("div")].filter((el) => el.style.transform.includes("scale")),
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
  loopState = loopOff();
  nextWake = () => wakeEntry("w-now", 0, { cause: "manual" });
  settings = settingsFixture();
  stopRefusal = null;
  stopHeld = null;
  fleetNotices = [];
  fleetHeld = null;
  timelineNotices = [];
  proposalsNow = fleetProposals();
  sriProposals = sriFixture();
  decisionsNow = [];
  workspaceNow = [];
  askNoticesNow = [];
  askSessionNow = null;
  opened = [];
  initiativesNow = initiativesFixture();
  initiativeNoticesNow = [];
  initiativesFail = null;
  urls.length = 0;
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
    const view = await mount(surface(false));
    expect(view.text()).toContain("3 need you · 1 running");
    expect(view.text()).toContain("hawthorne › core");
    expect(view.text()).toContain("maestro/a-1");
    expect(view.text()).not.toMatch(/\+\d+ −\d+/);
    expect(probeLogs()).toBe(1);
    await view.press(view.byLabel("Work a, Needs you, hawthorne › core, updated 12 minutes ago"));
    expect(view.text()).toContain("Changed");
    await view.press(view.byLabel("Work g, Needs you, updated 12 minutes ago"));
    expect(view.text()).toContain("Approve the branch");
    expect(view.text()).not.toContain("Changed");
    expect(probeLogs()).toBe(1);
  });

  test("with client state, the card and the detail show +a −d", async () => {
    const view = await mount(surface(false), { state: diffState as unknown as PluginClientStateSource });
    expect(view.text()).toContain("+12 −3");
    expect(view.byLabel("12 lines added, 3 removed")).not.toBeNull();
    const card = view.byLabel("Work a, Needs you, hawthorne › core, updated 12 minutes ago");
    expect(card?.getAttribute("aria-current")).toBe("false");
    await view.press(card);
    expect(card?.getAttribute("aria-current")).toBe("true");
    expect(view.text().match(/\+12 −3/g)).toHaveLength(2);
    expect(probeLogs()).toBe(0);
  });

  test("the server's changed line shows on the card and the detail with no client state", async () => {
    items = fixture().map((item) => (item.id === "a" ? { ...item, changed: { additions: 5, deletions: 1 } } : item));
    const view = await mount(surface(false));
    expect(view.byLabel("5 lines added, 1 removed")).not.toBeNull();
    await view.press(view.byLabel("Work a, Needs you, hawthorne › core, updated 12 minutes ago"));
    expect(view.text().match(/\+5 −1/g)).toHaveLength(2);
  });

  test("the detail alone, as the agent panel mounts it, survives a host without state", async () => {
    const view = await mount(<WorkDetail id="a" theme={theme} compact={false} navigation={undefined} />);
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
    const view = await mount(<WorkDetail id="q" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).toContain("Runs with claude (from Settings): mode bypassPermissions (from Settings).");
    expect(view.text()).toContain("This run skips permission prompts");
    expect(view.byLabel("Dispatch")).not.toBeNull();
  });

  test("a stuck item says Unblock may start a new run with the Settings mode, and warns", async () => {
    items = [
      ...fixture(),
      work("s", "blocked", { worker: worker("s", null), reason: "The session was archived", nextRun: fromSettings() }),
    ];
    const view = await mount(<WorkDetail id="s" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).toContain(
      "If the session is gone, Unblock starts a new run in a fresh worktree on its own run branch (from Settings), with claude (from Settings): mode bypassPermissions (from Settings).",
    );
    expect(view.text()).toContain("That new run would skip permission prompts");
    expect(view.byLabel("Unblock")).not.toBeNull();
  });

  test("a run that asks before it acts carries no warning", async () => {
    items = [...fixture(), work("p", "proposed", { nextRun: fromSettings({ modeId: "acceptEdits" }) })];
    const view = await mount(<WorkDetail id="p" theme={theme} compact={false} navigation={undefined} />);
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

  test("is in Needs you: the summary, its chip, and the board's column, with the reason on its card", async () => {
    items = flagged();
    const view = await mount(surface(false));
    expect(view.text()).toContain("4 need you · 1 running");
    const card = view.byLabel(`Work y, Queued, ${yours.reason}, updated 12 minutes ago`);
    expect(card?.textContent).toContain(yours.reason);
    await view.press(view.byLabel("Needs you, 4"));
    expect(view.text()).toContain("Work y");
    expect(view.text()).not.toContain("Work d");
    await view.press(view.tabs()[1]);
    const text = view.text();
    const needsYou = text.indexOf("At your gate, stuck or flagged");
    const done = text.indexOf("The branch is the receipt");
    expect(needsYou).toBeGreaterThan(-1);
    expect(text.indexOf("Work y")).toBeGreaterThan(needsYou);
    expect(text.indexOf("Work y")).toBeLessThan(done);
    // It left the Queued column: only once on the board.
    expect(text.match(/Work y/g)).toHaveLength(1);
    expect(text.indexOf("Work d")).toBeLessThan(needsYou);
  });

  test("the feed's Needs you lists stuck and flagged work with its reasons, as many as the header counts", async () => {
    const quiet = { kind: "quiet" as const, reason: "Quiet for 41 minutes, worth a look.", at: yours.at };
    items = [
      ...fixture(),
      work("y", "proposed", { flag: yours }),
      work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet }),
    ];
    const view = await mount(surface(false));
    // The header count, as Paseo's header shows it: work.attention's waiting, counted by the header.
    const count = needsYou(attentionOf(items, Date.now()).waiting).length;
    expect(headerFace(count).label).toBe("5 need you");
    const heading = view.all('[role="heading"]').find((el) => el.textContent === "Needs you");
    const header = heading?.parentElement;
    const section = header?.parentElement;
    expect(header?.textContent).toBe(`Needs you${count}At your gate, stuck or flagged`);
    const cards = [...(section?.querySelectorAll('[role="button"]') ?? [])].map((el) => el.getAttribute("aria-label"));
    expect(cards).toHaveLength(count);
    expect(cards.map((label) => label?.split(",")[0])).toEqual(["Work a", "Work g", "Work b", "Work y", "Work z"]);
    for (const reason of ["Needs a Linear scope", yours.reason, quiet.reason]) {
      expect(section?.textContent).toContain(reason);
    }
    // Listed once: not again under Queued, Running or Stuck.
    for (const title of ["Work y", "Work z", "Work b"])
      expect(view.text().match(new RegExp(title, "g"))).toHaveLength(1);
    expect(view.all('[role="heading"]').map((el) => el.textContent)).not.toContain("Stuck");
    expect(view.text()).toContain("5 need you · 1 running");
    // The chip the header opens holds the same work.
    expect(view.byLabel(`Needs you, ${count}`)).not.toBeNull();
  });

  test("a quiet run's notice offers Leave it running, which asks the host; other flags offer nothing of their own", async () => {
    const quiet = { kind: "quiet" as const, reason: "Quiet for 41 minutes, worth a look.", at: yours.at };
    items = [...flagged(), work("z", "running", { worker: worker("z", "maestro/z-1"), phase: "working", flag: quiet })];
    const view = await mount(<WorkDetail id="z" theme={theme} compact={false} navigation={undefined} />);
    const [alert] = view.all('[role="alert"]');
    expect(alert?.textContent).toContain(quiet.reason);
    const leave = alert?.querySelector('[aria-label="Leave it running"]');
    expect(leave).not.toBeNull();
    await view.press(leave);
    expect(calls.filter((call) => call.method === "work.leave-running").map((call) => call.input)).toEqual([
      { id: "z" },
    ]);
    // A start left to you clears when you dispatch or cancel: its notice has no verb of its own.
    await view.rerender(<WorkDetail id="y" theme={theme} compact={false} navigation={undefined} />);
    expect(view.byLabel("Leave it running")).toBeNull();
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toContain(yours.reason);
  });

  test("the detail says why, as a warning Notice; unflagged work has none", async () => {
    items = flagged();
    const view = await mount(<WorkDetail id="y" theme={theme} compact={false} navigation={undefined} />);
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toContain(yours.reason);
    expect(view.byLabel("Dispatch")).not.toBeNull();
    await view.rerender(<WorkDetail id="d" theme={theme} compact={false} navigation={undefined} />);
    expect(view.text()).not.toContain(yours.reason);
    expect(view.all('[role="alert"]')).toHaveLength(0);
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
  const detail = (id: string) => <WorkDetail id={id} theme={theme} compact={false} navigation={undefined} />;
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
    move("k", work("k", "review", { worker: worker("k", "maestro/k-1"), look }));
    await view.refetch();
    expect(view.byLabel("Discard and stop")).toBeNull();
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toContain(
      "The run moved on before you confirmed: it is now in Needs you.Dismiss",
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
    expect([...all]).toEqual([
      ["All", 9],
      ["Needs you", 5],
      ["Stuck", 1],
      ["Running", 1],
      ["Queued", 2],
      ["Done", 1],
    ]);
    // In the All view, each section chip counts its section; Stuck has no section of its own.
    const listed = sections();
    expect([...listed]).toEqual([
      ["Needs you", 5],
      ["Running", 1],
      ["Queued", 2],
      ["Done", 1],
    ]);
    for (const title of ["Needs you", "Running", "Queued", "Done"])
      expect([title, all.get(title)]).toEqual([title, listed.get(title)]);
    expect(["Needs you", "Running", "Queued", "Done"].reduce((sum, title) => sum + (all.get(title) ?? 0), 0)).toBe(
      all.get("All") ?? -1,
    );
    // Every chip, Stuck and All included, shows as many cards as it counts.
    for (const [title, count] of all) {
      await view.press(view.byLabel(`${title}, ${count}`));
      expect(view.pressed(`${title}, ${count}`)).toBe("true");
      expect([title, view.all('[role="button"]').filter(isCard).length]).toEqual([title, count]);
    }
  });

  test("a filter intent checks its chip, opens the feed and drops the scope", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    await view.press(view.tabs()[1]);
    expect(view.tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    await act(async () => requestIntent({ kind: "filter", group: "review" }));
    await settle();
    expect(view.tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(view.pressed("Needs you, 3")).toBe("true");
    expect(view.pressed("All work")).toBe("true");
    expect(view.text()).toContain("Work a");
    expect(view.text()).not.toContain("Work c");
  });

  test("the board bypasses the state filter, and choosing it clears the filter", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("Running, 1"));
    expect(view.text()).not.toContain("Work a");
    await view.press(view.tabs()[1]);
    await view.press(view.tabs()[0]);
    expect(view.pressed("All, 6")).toBe("true");
    // A filter set in the compact feed while the board is the chosen view.
    await view.press(view.tabs()[1]);
    await view.rerender(surface(true));
    await view.press(view.byLabel("Running, 1"));
    await view.rerender(surface(false));
    expect(view.tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    for (const title of ["Work a", "Work b", "Work c", "Work d", "Work f"]) expect(view.text()).toContain(title);
  });

  test("a scope whose initiative leaves the list does not come back", async () => {
    const view = await mount(surface(false));
    await view.press(view.byLabel("genesis, 1 of 2 open"));
    items = fixture().filter((item) => item.initiative !== "genesis");
    await view.press(view.byLabel("Refresh work"));
    items = fixture();
    await view.press(view.byLabel("Refresh work"));
    expect(view.pressed("All work")).toBe("true");
    expect(view.text()).toContain("Work a");
  });

  test("list rows pair the dot with words", async () => {
    items = [...fixture(), work("x", "canceled")];
    const view = await mount(surface(false));
    await view.press(view.tabs()[2]);
    expect(view.text()).toContain("Canceled");
    expect(view.byLabel("Work x, Canceled, updated 12 minutes ago")).not.toBeNull();
    expect(view.byLabel("Work f, Done, genesis, updated 12 minutes ago")).not.toBeNull();
  });

  test("compact switches only between the feed, History, the Fleet, the Timeline and Initiatives", async () => {
    const view = await mount(surface(true));
    expect(view.tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Feed",
      "History",
      "Fleet",
      "Timeline",
      "Initiatives",
    ]);
    expect(view.text()).toContain("claude · own worktree");
    await view.press(view.tabs()[1]);
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
    const view = await mount(surface(false));
    expect(view.rings()).toHaveLength(1);
    const [before, after] = await opacities(view);
    expect(after).not.toEqual(before);
    await act(async () => setReduced(true));
    await settle();
    const [still, later] = await opacities(view);
    expect(later).toEqual(still);
  });

  test("a surface opened under reduced motion starts still", async () => {
    const view = await mount(surface(false));
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
      const view = await mount(surface(false));
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
    await view.press(view.tabs()[3]);
    await settle(50);
    expect(view.tabs()[3]?.getAttribute("aria-selected")).toBe("true");
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

    const row = view.all('[aria-label^="You approved, Work a, hawthorne › core, You, Today at "]')[0];
    await view.press(row);
    expect(row?.getAttribute("aria-current")).toBe("true");
    expect(view.text()).toContain("Approve the branch");
  });
});

describe("the work folder's files", () => {
  test("lists them; a file opens as text, a long one says it was cut, a binary one says why", async () => {
    const view = await mount(<WorkDetail id="a" theme={theme} compact={false} navigation={undefined} />);
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
    const view = await mount(surface(false));
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
    expect(view.tabs()[3]?.getAttribute("aria-selected")).toBe("true");
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
    const view = await mount(surface(false));
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
    const view = await mount(surface(false));
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
    const view = await mount(surface(false));
    await view.press(view.byLabel("Waking…. Show the loop"));
    await view.press(view.byLabel("Wake now"));
    expect(view.all('[role="alert"]').map((el) => el.textContent)).toEqual([
      "Not woken: another check was already running.",
    ]);
  });

  test("off and never woken: it says so, and says where its period is set", async () => {
    const view = await mount(surface(false));
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
      const view = await mount(surface(false));
      await view.press(view.byLabel("Loop off. Show the loop"));
      await view.press(view.byLabel("Open Settings"));
      expect(opened).toBe(1);
    } finally {
      unlink();
    }
  });
});

describe("the Queued hint", () => {
  const LOOP_HINT = "The loop starts these on its next wake, under the run cap";
  const YOURS_HINT = "Ready when you dispatch it";

  for (const [on, shown, hidden] of [
    [false, YOURS_HINT, LOOP_HINT],
    [true, LOOP_HINT, YOURS_HINT],
  ] as const) {
    test(`with the loop ${on ? "on" : "off"}, the feed, the list and the board say "${shown}"`, async () => {
      if (on) loopState = { ...loopOff(), minutes: 15, nextAt: new Date(Date.now() + 9 * 60_000).toISOString() };
      const view = await mount(surface(false));
      for (const tab of [0, 2, 1]) {
        await view.press(view.tabs()[tab]);
        expect(view.text()).toContain(shown);
        expect(view.text()).not.toContain(hidden);
      }
    });
  }
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
      "On a schedule, the loop starts Queued work under the run cap, and leaves work that skips permission prompts, or runs in a mode you chose, to you.",
    );
    expect(view.text().split(LOOP_SETTINGS_HINT)).toHaveLength(2);
  });

  test("the loop is a choice of off or a period, and Save sends the whole config back with it", async () => {
    const view = await mount(settingsScreen());
    expect(view.text()).toContain("the loop starts Queued work under the run cap");
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
  const fleetTab = (view: Awaited<ReturnType<typeof mount>>) =>
    view.tabs().find((tab) => tab.getAttribute("aria-label") === "Fleet");

  test("shows the scope's health, its asks as the work raised for them, its proposals, ticks and report", async () => {
    const view = await mount(surface(false));
    await view.press(fleetTab(view));
    expect(sent("fleet.get")).toEqual([{ ticks: 24 }]);
    const text = view.text();
    expect(text).toContain("Missed");
    expect(text).toContain("No tick for 3h: the last was tick 35. It runs every hour.");
    expect(text).toContain("report mode, dry run");
    expect(text).toContain("13 Paseo records are not archived and have no live process.");
    expect(text).toContain("count · since tick 2");
    expect(text).toContain("Would report");
    expect(text).toContain("2 · 1 to review");
    expect(text).toContain("You accepted this 1h ago");
    expect(text).toContain("53 out of scope · 1 error");
    expect(text).toContain("Failed at observe");
    // Wide windows open the report.
    expect(text).toContain("fleet-reconcile · broomva · tick 35");
    expect(text).toContain("out of scope");
    // The ask is answered in the work the fleet raised: opened, not copied.
    await view.press(view.byLabel("Open the fleet's work for ask a1: Work a"));
    expect(view.text()).toContain("Approve the branch");
  });

  test("Accept records your verdict; Reject asks why first, and sends the note", async () => {
    const view = await mount(surface(false));
    await view.press(fleetTab(view));
    // The refetch that follows is held: what the card says next comes from the host's answer alone.
    let release = () => {};
    fleetHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await view.press(view.byLabel("Accept: report, de2dd335 sri-sti-2761-rce"));
    expect(sent("fleet.review")).toEqual([
      { scope: "broomva", keys: ["session:de2dd335:4:aaaa1111"], verdict: "accept", note: "" },
    ]);
    // Said at once, from the host's answer: no button left reading Accept for a second tap, nothing reordered.
    expect(view.text()).toContain("You accepted this just now");
    expect(view.text()).toContain("2 · all reviewed");
    expect(view.text().indexOf("Would report only")).toBeGreaterThan(view.text().indexOf("Would report"));
    fleetHeld = null;
    release();
    await settle(30);

    await view.press(view.byLabel("Reject: report only, 5dd4ed18 worried-walrus"));
    expect(sent("fleet.review")).toHaveLength(1);
    await view.type(view.byLabel("Why reject: report only, 5dd4ed18 worried-walrus"), "Unmanaged sessions are mine");
    await view.press(view.byLabel("Confirm reject: report only, 5dd4ed18 worried-walrus"));
    expect(sent("fleet.review").at(-1)).toEqual({
      scope: "broomva",
      keys: ["session:5dd4ed18:10:bbbb2222"],
      verdict: "reject",
      note: "Unmanaged sessions are mine",
    });
    await view.refetch();
    expect(view.text()).toContain("You rejected this just now: Unmanaged sessions are mine");
  });

  test("a scope chip reads that scope", async () => {
    const view = await mount(surface(false));
    await view.press(fleetTab(view));
    await view.press(view.byLabel("sri, Not scheduled, 1 proposal to review"));
    expect(sent("fleet.get").at(-1)).toEqual({ scope: "sri", ticks: 24 });
    expect(view.text()).toContain("Not scheduled: no LaunchAgent runs it.");
  });

  test("one class and one action across sessions is one card: one verdict writes every session's key", async () => {
    const view = await mount(surface(false));
    await view.press(fleetTab(view));
    await view.press(view.byLabel("sri, Not scheduled, 1 proposal to review"));
    expect(view.text()).toContain("Would report only");
    expect(view.text()).toContain("4 sessions · Class 10, unmanaged");
    expect(view.text()).toContain("aaaa1111 sri-aaaa1111");
    expect(view.text()).not.toContain("dddd4444 sri-dddd4444");
    await view.press(view.byLabel("Show all sessions: report only"));
    expect(view.text()).toContain("dddd4444 sri-dddd4444");
    expect(view.byLabel("sri, Not scheduled, 1 proposal to review")).not.toBeNull();
    // The refetch after is held: the card and the chip's badge say it from the host's answer alone.
    let release = () => {};
    fleetHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await view.press(view.byLabel("Accept: report only, 4 sessions"));
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
    expect(view.text()).toContain("You accepted this just now");
    expect(view.byLabel("sri, Not scheduled")).not.toBeNull();
    fleetHeld = null;
    release();
    await settle(30);
  });

  test("on a phone, a group's verdict sits above its sessions, each with its evidence", async () => {
    const view = await mount(surface(true));
    await view.press(fleetTab(view));
    await view.press(view.byLabel("sri, Not scheduled, 1 proposal to review"));
    const text = view.text();
    expect(text.indexOf("Accept all 4")).toBeGreaterThan(-1);
    expect(text.indexOf("Accept all 4")).toBeLessThan(text.indexOf("aaaa1111 sri-aaaa1111"));
    expect(text).toContain("aaaa1111 sri-aaaa1111done · ~Not a Paseo sessionno fleet key, not adopted");
  });

  test("Reject's note closes on the host's answer, while the refetch after is still on its way", async () => {
    const view = await mount(surface(false));
    await view.press(fleetTab(view));
    let release = () => {};
    fleetHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await view.press(view.byLabel("Reject: report, de2dd335 sri-sti-2761-rce"));
    await view.press(view.byLabel("Confirm reject: report, de2dd335 sri-sti-2761-rce"));
    expect(view.byLabel("Why reject: report, de2dd335 sri-sti-2761-rce")).toBeNull();
    expect(view.text()).toContain("You rejected this just now");
    fleetHeld = null;
    release();
    await settle(30);
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
    expect(view.text()).toContain("Fleet broomva: missed tick for 3h. No tick since tick 35.");
    await view.press(view.byLabel("Open Fleet, broomva"));
    expect(fleetTab(view)?.getAttribute("aria-selected")).toBe("true");
    expect(sent("fleet.get").at(-1)).toEqual({ scope: "broomva", ticks: 24 });
    // In the Fleet view the health card says it; the notice is not shown twice.
    expect(view.text()).not.toContain("Fleet broomva: missed tick.");
  });

  test("an intent from the header count opens the Fleet view", async () => {
    const view = await mount(surface(true));
    await step(generation, () => requestIntent({ kind: "fleet", scope: "sri" }));
    await settle(30);
    expect(fleetTab(view)?.getAttribute("aria-selected")).toBe("true");
    expect(sent("fleet.get").at(-1)).toEqual({ scope: "sri", ticks: 24 });
  });

  test("on a phone the report waits behind a button, and its table rows are cards", async () => {
    const view = await mount(surface(true));
    await view.press(fleetTab(view));
    expect(view.text()).not.toContain("Report only (phase 1).");
    await view.press(view.byLabel("Show the report"));
    expect(view.text()).toContain("Report only (phase 1).");
    // Each row stands alone: a bare number leads with the cell after it, the rest under their column names.
    expect(view.text()).toContain("1 · out of scopesessions53");
    expect(view.text()).not.toContain("classout of scope");
  });
});

describe("the Timeline", () => {
  const tab = (view: Awaited<ReturnType<typeof mount>>, label = "Timeline") =>
    view.tabs().find((one) => one.getAttribute("aria-label") === label);
  const rows = (view: Awaited<ReturnType<typeof mount>>) =>
    view
      .all('[role="button"][aria-expanded]')
      .map((row) => row.getAttribute("aria-label") ?? "")
      .filter((label) => !label.includes("the loop"));

  test("every scheduled source on one axis, what needs you first, each with its last and next run", async () => {
    const view = await mount(surface(false));
    await view.press(tab(view));
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
    await view.press(tab(view));
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
    await view.press(tab(view));
    await view.press(view.all('[aria-label^="fleet-reconcile broomva, Fleet"]')[0]);
    // A source with no log of its own asks for none.
    expect(calls.filter((call) => call.method === "timeline.log")).toEqual([]);
    await view.press(view.byLabel("Open Fleet"));
    expect(tab(view, "Fleet")?.getAttribute("aria-selected")).toBe("true");
    await view.press(tab(view));
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
    expect(tab(view)?.getAttribute("aria-selected")).toBe("true");
    expect(view.text()).not.toContain("kg-lint: failed run.");
    expect(view.text()).toContain("1 needs you.");
  });
});

describe("drilling in", () => {
  const tab = (view: Awaited<ReturnType<typeof mount>>, label: string) =>
    view.tabs().find((one) => one.getAttribute("aria-label") === label);
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);

  test("a decision ask shows its stakes and options, and is answered in place: chosen, then Answer", async () => {
    decisionsNow = [decisionFixture()];
    const view = await mount(surface(false));
    await view.press(tab(view, "Fleet"));
    const text = view.text();
    expect(text).toContain("Four small review follow-ups from #7 and #8: ticket them, or drop them?");
    expect(text).toContain("What waiting costs: None blocks a lane; untracked, a test gap stays invisible.");
    expect(text).toContain("Why you: Scheduling is yours.");
    expect(text).toContain("File all fourRecommendedEach becomes a Linear issue.");
    expect(text).toContain("Drop all fourCannot be undoneThey stay in this ledger.");
    expect(text).toContain("If you say nothing: file all four once Linear is signed in");
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
    await view.press(view.byLabel("Open the session that asked A10"));
    expect(opened).toEqual(["agent-asker"]);
  });

  test("an ask with an id collision says so and takes no answer", async () => {
    decisionsNow = [{ ...decisionFixture(), refusal: "Two asks in maestro-paseo-gaps.yaml are named A10." }];
    const view = await mount(surface(false));
    await view.press(tab(view, "Fleet"));
    expect(view.text()).toContain("Two asks in maestro-paseo-gaps.yaml are named A10.");
    expect(view.byLabel("Answer A10")).toBeNull();
  });

  test("a fleet ask opens the session it is about, and its details show the tick that raised it", async () => {
    askSessionNow = { id: "d4b991f0-1133-4c26", short: "d4b991f0", name: "broomva-88", agentId: "agent-88" };
    const view = await mount(surface(false));
    await view.press(tab(view, "Fleet"));
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

  test("a proposal's session shows its status, folder and branch, and opens in Paseo when it is a Paseo agent", async () => {
    proposalsNow = fleetProposals().map((proposal) =>
      proposal.session?.short === "5dd4ed18"
        ? { ...proposal, session: { ...proposal.session, agentId: "agent-walrus", branch: "feat/walrus" } }
        : proposal,
    );
    const view = await mount(surface(false));
    await view.press(tab(view, "Fleet"));
    const text = view.text();
    expect(text).toContain("5dd4ed18 worried-walrusidle · ~ · on feat/walrus");
    expect(text).toContain("de2dd335 sri-sti-2761-rcefailed · ~Not a Paseo session");
    expect(view.byLabel("Open session de2dd335 sri-sti-2761-rce in Paseo")).toBeNull();
    await view.press(view.byLabel("Open session 5dd4ed18 worried-walrus in Paseo"));
    expect(opened).toEqual(["agent-walrus"]);
  });

  test("a tick row opens its runner's words, its log lines and its report, read only then", async () => {
    const view = await mount(surface(false));
    await view.press(tab(view, "Fleet"));
    const row = () => view.all('[aria-label^="Tick 34, failed at observe"]')[0];
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
    await view.press(tab(view, "Timeline"));
    await view.press(view.all('[aria-label^="Morning sweep, "]')[0]);
    expect(view.text()).toContain("Waiting on four background jobs.");
    await view.press(view.all('[aria-label^="Open its session: "]')[0]);
    expect(opened).toEqual(["b8c26013-30f3-4ebc-bd29-bbfdf08383ee"]);
  });

  test("a fleet run opens its tick in the Fleet view, opened", async () => {
    timelineRuns = true;
    const view = await mount(surface(false));
    await view.press(tab(view, "Timeline"));
    await view.press(view.all('[aria-label^="fleet-reconcile broomva, Fleet"]')[0]);
    await view.press(view.all('[aria-label^="Open tick 35: "]')[0]);
    await settle(50);
    expect(tab(view, "Fleet")?.getAttribute("aria-selected")).toBe("true");
    expect(sent("fleet.tick")).toEqual([{ scope: "broomva", tick: 35 }]);
    expect(view.text()).toContain("What tick 35 logged");
    // That tick was the visit's: the Fleet tab chosen again later opens on none.
    await view.press(tab(view, "Feed"));
    await view.press(tab(view, "Fleet"));
    expect(view.text()).not.toContain("What tick 35 logged");
  });
});

describe("the workspace's decisions", () => {
  const fleetTab = (view: Awaited<ReturnType<typeof mount>>) =>
    view.tabs().find((one) => one.getAttribute("aria-label") === "Fleet");
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
  /** The workspace's asks load on their own query once the Fleet view opens: waited for, never assumed, on a slow runner. */
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

  test("each ledger's asks together, with their full context, the answered folded; a blocking ask with a default waits", async () => {
    workspaceNow = [
      canvas("product-name"),
      merge(),
      canvas("old-one", {
        state: "answered",
        answer: "Keep it.",
        answerOption: "ticket-all",
        answeredAt: new Date(Date.now() - H).toISOString(),
        batched: true,
      }),
    ];
    const view = await mount(surface(false));
    await view.press(fleetTab(view));
    await until(view, "Your workspace's asks");
    const text = view.text();
    expect(text).toContain("Decisions2 open · 1 waits on you");
    // The ledger that waits on you comes first.
    expect(text.indexOf("prompt-cache-and-preflight-caching")).toBeLessThan(text.indexOf("bro-2795-local-first"));
    expect(text).toContain("Waits on you: it blocks until you answer.");
    expect(text).toContain("What waiting costs: scripts/auth-preflight-hook.sh is in require_human paths.");
    expect(text).toContain("Merge PR #863RecommendedWarnings go to stderr.");
    expect(text).toContain("If you say nothing: hold");
    expect(text).toContain("Its home is the checkout /Users/me/broomva, on feat/prompt-cache");
    expect(text).toContain("Its home is origin/main: your answer goes to Maestro's answers worktree");
    // The answered ask is folded under its ledger until asked for.
    expect(text).not.toContain("Canvas ask old-one");
    await view.press(view.byLabel("Show the answered asks in bro-2795-local-first-agentic-canvas.yaml"));
    expect(view.text()).toContain("Canvas ask old-one");
    expect(view.text()).toContain("In the answers batch on maestro/answers");
    await view.press(view.byLabel("Hide the answered asks in bro-2795-local-first-agentic-canvas.yaml"));
    expect(view.text()).not.toContain("Canvas ask old-one");
    // A ledger folds and opens from its heading.
    const heading = "2026-10-01-auth-preflight-hook-stderr.yaml: 1 open · 1 waits on you";
    expect(view.byLabel(heading)?.getAttribute("aria-expanded")).toBe("true");
    await view.press(view.byLabel(heading));
    expect(view.byLabel(heading)?.getAttribute("aria-expanded")).toBe("false");
    expect(view.text()).not.toContain("Merge PR #863Recommended");
    await view.press(view.byLabel(heading));
    expect(view.text()).toContain("Merge PR #863Recommended");
  });

  test("an answer goes to the ask's home as read, and the card says so at once", async () => {
    workspaceNow = [merge()];
    const view = await mount(surface(true));
    await view.press(fleetTab(view));
    await until(view, "Your workspace's asks");
    await view.press(view.byLabel("Merge PR #863, recommended"));
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
    expect(view.text()).toContain("Answered just now: “Merge PR #863”");
    expect(view.byLabel("Answer A1: Merge PR #863")).toBeNull();
  });

  test("past ten open asks, only the ledgers with one that waits on you start open", async () => {
    workspaceNow = [
      merge(),
      // Eleven open in all: past ten, so the ledgers start folded; answering one brings it to ten.
      ...Array.from({ length: 10 }, (_, at) => canvas(`q${at}`, { ledger: `ledger-${at}.yaml`, arc: `arc-${at}` })),
    ];
    const view = await mount(surface(false));
    await view.press(fleetTab(view));
    await until(view, "Your workspace's asks");
    expect(view.text()).toContain("Approve merge of PR #863");
    expect(view.text()).not.toContain("Canvas ask q3");
    await view.press(view.byLabel("ledger-3.yaml: 1 open"));
    expect(view.text()).toContain("Canvas ask q3");
    // Answering its only open ask leaves the ledger open, saying so; the rest stay folded though the count is now ten.
    await view.press(view.byLabel("File all four, recommended"));
    await view.press(view.byLabel("Answer q3: File all four"));
    expect(view.text()).toContain("Answered just now: “File all four”");
    expect(view.text()).not.toContain("Canvas ask q4");
  });

  test("an ask that waits on you shows above the work, and opens the Fleet view's Decisions", async () => {
    workspaceNow = [merge()];
    askNoticesNow = [
      {
        scope: null,
        ledger: "2026-10-01-auth-preflight-hook-stderr.yaml",
        uid: null,
        id: "A1",
        headline: "Approve merge of PR #863 touching scripts/auth-preflight-hook.sh?",
        blocking: true,
        askedAt: null,
      },
    ];
    const view = await mount(surface(false));
    await until(view, "A decision waits on you");
    expect(view.text()).toContain("A decision waits on you: Approve merge of PR #863");
    await view.press(view.byLabel("Open Decisions, 1 waiting"));
    await until(view, "Waits on you: it blocks until you answer.");
    expect(fleetTab(view)?.getAttribute("aria-selected")).toBe("true");
    expect(view.text()).toContain("Waits on you: it blocks until you answer.");
    // In the Fleet view, Decisions holds it; the notice is not shown twice.
    expect(view.text()).not.toContain("A decision waits on you");
  });
});

describe("Initiatives", () => {
  const tab = (view: Awaited<ReturnType<typeof mount>>, label: string) =>
    view.tabs().find((one) => one.getAttribute("aria-label") === label);
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.input);
  /** The tab loads on its own query once it opens: waited for, never assumed, on a slow runner. */
  const until = async (view: Awaited<ReturnType<typeof mount>>, text: string) => {
    for (let tries = 0; tries < 150 && !view.text().includes(text); tries += 1) await settle(20);
  };
  const open = async (compact = false) => {
    const view = await mount(surface(compact));
    await view.press(tab(view, "Initiatives"));
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

  test("an ask it waits on opens in Decisions, its ledger open even where the rest fold", async () => {
    // Eleven open asks elsewhere fold every ledger that does not wait on you; the one the initiative names opens.
    workspaceNow = [
      ...Array.from({ length: 11 }, (_, at) => ({
        ...decisionFixture(),
        ledger: "other.yaml",
        arc: "other",
        id: `O${at}`,
        home: { kind: "main" as const, path: "/Users/me/broomva", branch: null },
        origin: null,
      })),
      { ...decisionFixture(), home: { kind: "main" as const, path: "/Users/me/broomva", branch: null }, origin: null },
    ];
    const view = await open();
    await view.press(view.byLabel("Open maestro-paseo-gaps.yaml#A10 in Decisions"));
    for (let tries = 0; tries < 150 && !view.text().includes("Your workspace's asks"); tries += 1) await settle(20);
    expect(tab(view, "Fleet")?.getAttribute("aria-selected")).toBe("true");
    const heading = (ledger: string) =>
      view.all("[aria-expanded]").find((one) => one.getAttribute("aria-label")?.startsWith(`${ledger}:`));
    expect(heading("maestro-paseo-gaps.yaml")?.getAttribute("aria-expanded")).toBe("true");
    expect(heading("other.yaml")?.getAttribute("aria-expanded")).toBe("false");
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
    expect(sent("initiatives.file")).toEqual([{ ledger: "ideas-mod-anything.yaml", id: "I3" }]);
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
    initiativeNoticesNow = [{ id: "mod-anything", title: "mod-anything skill", kind: "overdue", date: "2026-10-01" }];
    workspaceNow = [ideaFixture("I9", { home: { kind: "main", path: "/Users/me/broomva", branch: null } })];
    const view = await mount(surface(true));
    for (let tries = 0; tries < 150 && !view.text().includes("was due for review"); tries += 1) await settle(20);
    expect(view.text()).toContain("The initiative mod-anything skill was due for review on 2026-10-01.");
    await view.press(view.byLabel("Open Initiatives, 1 need a look"));
    await until(view, "mod-anything skill");
    expect(tab(view, "Initiatives")?.getAttribute("aria-selected")).toBe("true");
    expect(view.text()).not.toContain("was due for review on");
    // The idea is answered here, never twice: Decisions does not list it.
    await view.press(tab(view, "Fleet"));
    await settle(100);
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
    await broken.press(tab(broken, "Initiatives"));
    await until(broken, "could not be read");
    expect(broken.text()).toContain("Your initiatives could not be read: the control repo is gone");
    initiativesFail = null;
    await broken.press(broken.byLabel("Try again"));
    await until(broken, "mod-anything skill");
    expect(broken.text()).toContain("mod-anything skill");
  });
});
