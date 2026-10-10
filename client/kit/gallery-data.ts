// The component gallery's samples: the frames' own illustrative data (J1, J6b,
// M1, M2–M4), so a screenshot of the gallery reads against the PNGs. Not real
// work: nothing here is fetched or sent.

import type { PluginTheme } from "@getpaseo/plugin";
import { BROOMVA_DARK, BROOMVA_LIGHT } from "../../shared/theme";
import type { InspectorItem } from "./inspector";

/** A Paseo theme contribution as the host hands it to a plugin, with broomva's status colors. */
function pluginTheme(
  contribution: typeof BROOMVA_LIGHT,
  status: { ok: string; warn: string; danger: string },
): PluginTheme {
  const c = contribution.colors;
  return {
    colors: {
      surface0: c.background,
      surface1: c.raised,
      surface2: c.control,
      border: c.border,
      foreground: c.foreground,
      foregroundMuted: c.mutedForeground,
      accent: c.accent ?? c.foreground,
      accentForeground: c.background,
      statusSuccess: status.ok,
      statusWarning: status.warn,
      statusDanger: status.danger,
    },
  };
}

/** Broomva light and dark as plugin themes (status colors: maestro-next.pen's ok, warn, danger). */
export const GALLERY_LIGHT = pluginTheme(BROOMVA_LIGHT, { ok: "#008039", warn: "#A66D00", danger: "#B7191C" });
export const GALLERY_DARK = pluginTheme(BROOMVA_DARK, { ok: "#00A24F", warn: "#DCA81C", danger: "#E5484D" });

export const APPROVAL: InspectorItem = {
  kind: "approval",
  key: "approval:workspace#933",
  kicker: ["workspace#933", "auto_merge"],
  age: "35 min",
  title: "Allow merging workspace#933?",
  summary:
    "The merge gate held it only because the diff touches .control/policy.yaml (require_human). Every other gate passed.",
  primaryLabel: "Allow merge",
  action: "gh pr merge 933 --squash @ ce73104",
  evidence: [
    { label: "Checks", value: "7 of 7", note: "at ce73104", tone: "ok" },
    { label: "P20", value: "8 · 9 · 8", note: "three strata", tone: "ok" },
    { label: "Diff", value: "2 files", note: "one is policy", tone: "warn" },
    { label: "Reversible", value: "by revert", note: "no deploy", tone: "ok" },
  ],
  after: [
    "Maestro records your decision and shows Undo for 8 s",
    "The merge gate squashes at ce73104; if the head moved, it stops and asks again",
    "Session bro-2917-ledger is told and continues its turn",
  ],
  session: { name: "bro-2917-ledger", status: "waiting on you · 35 min", state: "review", waiting: true },
  history: [
    { age: "35m", verb: "held", detail: "require_human: policy file", tone: "needs" },
    { age: "38m", verb: "checks", detail: "7 of 7 green at ce73104", tone: "ok" },
    { age: "52m", verb: "review", detail: "P20 passed 8 · 9 · 8", tone: "ok" },
    { age: "1h", verb: "opened", detail: "bro-2917-ledger opened workspace#933", tone: "muted" },
  ],
};

export const ASK: InspectorItem = {
  kind: "ask",
  key: "ask:claude-code-mods",
  kicker: ["claude-code-mods", "reversible"],
  age: "2h",
  title: "Install the three headless Claude Code mods fleet-wide?",
  why: "Why you: a mod that answers tool.call runs before the P2 gate and the deny rules.",
  options: [
    { id: "off", label: "Keep them off", note: "nothing changes; revisit later", recommended: true },
    { id: "trial", label: "Install in one worktree first", note: "a trial on one session" },
    { id: "fleet", label: "Install fleet-wide", note: "every session, next start" },
  ],
  chosen: "off",
  fallback: { line: "Keeps them off in 24 min if you say nothing", elapsed: 0.3 },
};

export const OWNER_STEP: InspectorItem = {
  kind: "owner_step",
  key: "owner_step:P20-credits",
  kicker: ["sri", "P20"],
  age: "1 day",
  title: "Add Codex credits so P20 reviews are cross-vendor again",
  summary: "Only you can do this: it needs your OpenAI billing login. Two sessions are waiting on it.",
  where: "platform.openai.com → Billing → workspace credits",
  check:
    "Done is checked: codex exec -m gpt-5.5 must answer. Until then P20 runs same-vendor, as you answered on 10-07.",
  session: { name: "sri-p20-gate", status: "2 sessions are waiting · 1 day", state: "review", waiting: true },
};

export const NOTICE: InspectorItem = {
  kind: "notice",
  key: "notice:STI-3593",
  kicker: ["sri", "STI-3593"],
  age: "9 h",
  title: "Credits ledger: its session ended mid-turn",
  summary:
    "The run stopped at 04:10Z during a tool call. Nothing was merged; the branch has 3 local commits. Owner: SRI Orchestrator.",
  log: [
    { at: "04:09:51", text: "bun test …/credits.test.ts" },
    { at: "04:10:02", text: "✗ ledger balances after refund", tone: "danger" },
    { at: "04:10:02", text: "1 fail · 212 pass" },
    { at: "04:10:03", text: "session ended (no turn end)", tone: "warn" },
  ],
  closesWhen: [
    { when: "its session takes a turn", becomes: "Running" },
    { when: "its orchestrator closes it", becomes: "Handled" },
    { when: "you cancel it", becomes: "Canceled" },
  ],
  note: "No Approve: a notice is a fact. Unblock sends your prompt into the session.",
};

export const WORK: InspectorItem = {
  kind: "work",
  key: "work:STI-3684",
  kicker: ["sri", "STI-3684"],
  age: "40s",
  title: "Provable Outlook + fetch-by-id reads",
  summary: "Turn 4 · bun test. The broomva lane started it; it lands through the merge gate.",
  state: "running",
  lifecycle: [
    { label: "Queued", at: "1h", done: true },
    { label: "Started by the lane", at: "52m", done: true },
    { label: "Running", at: "turn 4", done: true },
    { label: "Gate", done: false },
    { label: "Done", done: false },
  ],
  session: { name: "sti-3684-outlook", status: "turn 4 · bun test · 40s", state: "running" },
  history: [
    { age: "40s", verb: "turn", detail: "4 started: bun test", tone: "ok" },
    { age: "52m", verb: "started", detail: "by the broomva lane", tone: "muted" },
  ],
};

export const REVIEW: InspectorItem = {
  kind: "review",
  key: "review:skene",
  kicker: ["skene", "initiative review"],
  age: "due today",
  title: "Review skene: keep, park or close?",
  summary: "Due on its review date (B2). Two open tickets, the driver session last turned 6 days ago.",
  late: "3 days past its milestone",
  options: [
    { id: "keep", label: "Keep", note: "next review in 14 days", recommended: true },
    { id: "park", label: "Park", note: "no reviews until you resume it" },
    { id: "close", label: "Close", note: "archive its tickets" },
  ],
  chosen: "keep",
};

export const INSPECTOR_SAMPLES = [APPROVAL, ASK, OWNER_STEP, NOTICE, WORK, REVIEW] as const;

export interface RowSample {
  key: string;
  kind: string;
  state: string;
  title: string;
  meta: string;
  age: string;
}

/** The sheet's rows (M1 frame 2): running, health and finished, plus a hold that never swipes. */
export const SHEET_ROWS: readonly { title: string; rows: readonly RowSample[] }[] = [
  {
    title: "Running",
    rows: [
      {
        key: "r1",
        kind: "work",
        state: "running",
        title: "Provable Outlook + fetch-by-id reads",
        meta: "sri · STI-3684 · turn 4",
        age: "40s",
      },
      {
        key: "r2",
        kind: "work",
        state: "running",
        title: "Composer drops sends (P1)",
        meta: "sri · STI-3680 · turn 2",
        age: "2m",
      },
    ],
  },
  {
    title: "Health",
    rows: [
      {
        key: "h1",
        kind: "notice",
        state: "standing",
        title: "Quiet for 808 minutes",
        meta: "sri · STI-3617",
        age: "13h",
      },
      {
        key: "h2",
        kind: "notice",
        state: "stuck",
        title: "Credits ledger: ended mid-turn",
        meta: "sri · STI-3593",
        age: "9h",
      },
    ],
  },
  {
    title: "Finished",
    rows: [
      {
        key: "f1",
        kind: "finished",
        state: "done",
        title: "GitHub identity: PR #12 merged",
        meta: "holon · waits for Continue",
        age: "18m",
      },
    ],
  },
  {
    title: "A hold (never swipes)",
    rows: [
      {
        key: "a1",
        kind: "ask",
        state: "review",
        title: "Install the three headless mods?",
        meta: "claude-code-mods · ask",
        age: "2h",
      },
    ],
  },
];
