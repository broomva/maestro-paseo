// Invariant 1 (docs/design/next/view-models.md, BRO-3001): the header total ==
// Σ kinds == the length of the Feed's Needs you section == the Feed tab's
// badge == the push count. One fixture of work in every state, asks that wait
// and asks that do not, a due review and the answers batch, read by each
// surface the way it reads it in production: needs.list's projection on the
// server, the header button through startIntegrations, the Feed's section and
// tab through their models, and the push through a real Inbox.

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginButton } from "@getpaseo/plugin/client";
import { fakeWork } from "../client/fake-work";
import { needsByInitiative, needsSection } from "../client/feed-model";
import { headerFace, tabBadges } from "../client/header-count";
import { type IntegrationClient, startIntegrations } from "../client/integrations";
import { initiatives } from "../client/plane-model";
import type { AnswersLanding } from "../shared/answers";
import type { WorkItem } from "../shared/contracts";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import { NEED_KINDS, type Needs } from "../shared/needs";
import type { WorkEvent } from "./events";
import { decodeNotice, Inbox, noticeText } from "./inbox";
import { needsOf } from "./needs";
import type { Paseo } from "./runs";
import type { StoredWork } from "./store";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-10T15:00:00.000Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const live = (id: string) => ({ agentId: `agent-${id}`, workspaceId: "ws1" });
const flag = (kind: "yours" | "failed" | "quiet") => ({ kind, reason: `Flagged ${kind}.`, at: at(30) });

const ask = (id: string, extra: Partial<DecisionAsk> = {}): DecisionAsk => ({
  ledger: "bro-3001.yaml",
  uid: null,
  id,
  hash: "0123456789abcdef",
  arc: null,
  headline: `Ask ${id}?`,
  question: null,
  stakes: null,
  whyYou: null,
  options: [],
  fallback: null,
  blocking: false,
  askedAt: at(120),
  answeredAt: null,
  answer: null,
  answerOption: null,
  state: "open",
  origin: null,
  refusal: null,
  home: { kind: "main", path: "/ctl", branch: null },
  batched: false,
  waiting: false,
  ...extra,
});

/** Work in every state, every flag, a permission prompt; asks of every kind; a due review; the batch. */
function everything(): { items: WorkItem[]; asks: DecisionAsk[]; reviews: Initiative[]; landing: AnswersLanding } {
  const items = [
    fakeWork("gate", "review", live("gate"), { updatedAt: at(50), initiative: "hawthorne" }),
    fakeWork("perm", "review", live("perm"), {
      updatedAt: at(40),
      initiative: "hawthorne",
      permission: { requestId: "r", title: "Run bash", detail: "git push" },
    }),
    fakeWork("stuck", "blocked", live("stuck"), { reason: "Stopped before finishing" }),
    fakeWork("quiet", "running", live("quiet"), { flag: flag("quiet") }),
    fakeWork("run", "running", live("run")),
    fakeWork("queued", "proposed"),
    fakeWork("yours", "proposed", null, { flag: flag("yours"), initiative: "genesis" }),
    fakeWork("failed", "triggered", null, { flag: flag("failed") }),
    fakeWork("done", "done", null, { closed: { by: "you", at: at(10) } }),
    fakeWork("canceled", "canceled", null, { closed: { by: "maestro", at: at(10) } }),
  ];
  const asks = [
    ask("blocks", { blocking: true, initiative: "genesis" }),
    // fleet-reconcile's ask for the same permission prompt the "perm" work holds: one prompt, one hold.
    ask("prompt", {
      blocking: true,
      scope: "broomva",
      ledger: "fleet-broomva.yaml",
      home: { kind: "root", path: "/state/broomva/.control/asks", branch: null },
      options: [{ id: "ack", label: "Acknowledge", consequence: null, reversible: true, recommended: true }],
      // The Claude session behind agent-perm: fleet-reconcile keys by it (prompt:<session_id>:…).
      promptSession: "51ba8cdf-claude-session-of-agent-perm",
    }),
    ask("one-way", {
      options: [{ id: "go", label: "Go", consequence: null, reversible: false, recommended: true }],
    }),
    // Open, but waits on no one: watched in Decisions.
    ask("calm", { options: [{ id: "ok", label: "OK", consequence: null, reversible: true, recommended: true }] }),
    ask("answered", { state: "answered", answeredAt: at(5) }),
    // An answer waiting for the conductor: not a need (BRO-2990).
    ask("conductor", {
      state: "answered",
      answeredAt: at(5),
      fate: {
        stage: "conductor",
        words: "For the conductor.",
        route: "conductor",
        pr: null,
        work: null,
        agentId: null,
      },
    }),
    // A fleet root's ask that waits.
    ask("fleet", {
      blocking: true,
      scope: "sri",
      ledger: "fleet-sri.yaml",
      home: { kind: "root", path: "/state/sri/.control/asks", branch: null },
    }),
  ];
  const reviews = [
    {
      id: "skene",
      file: "skene.yaml",
      title: "skene",
      quote: null,
      summary: null,
      nextAction: null,
      driver: null,
      waitingOn: [],
      stale: { kind: "overdue", date: "2026-10-08" },
    } as unknown as Initiative,
  ];
  const landing: AnswersLanding = {
    stage: "waiting",
    pending: 2,
    asks: [],
    pr: { number: 915, url: "https://github.com/broomva/workspace/pull/915" },
    conflict: null,
    error: null,
    landed: null,
    checkedAt: at(15),
  };
  return { items, asks, reviews, landing };
}

/** The header button as startIntegrations registers it, its daemon answering needs.list with `needs`. */
async function headerButton(needs: Needs): Promise<PluginButton> {
  const buttons: PluginButton[] = [];
  const client = {
    paseo: {
      workspaces: {
        list: async () => ({ entries: [{ id: "ws1" }], pageInfo: { hasMore: false, nextCursor: null } }),
        subscribe: () => () => undefined,
      },
      agents: { subscribe: () => () => undefined },
    },
    rpc: async (contract: { name: string }) => (contract.name === "needs.list" ? needs : { waiting: [], sessions: [] }),
    openScreen: () => undefined,
    addHeaderButton: ({ button }: { button: PluginButton }) => {
      buttons.push(button);
      return { update: (patch: Partial<PluginButton>) => Object.assign(button, patch), remove: () => undefined };
    },
    addComposerPill: () => ({ update: () => undefined, remove: () => undefined }),
  } as unknown as IntegrationClient;
  const integrations = startIntegrations(
    client,
    { pillIcon: () => "dot", PillContent: () => null },
    { later: () => () => undefined, log: () => undefined },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  integrations.stop();
  const [button] = buttons;
  if (!button) throw new Error("no header button was registered");
  return button;
}

/** What the push says for a landing, through a real Inbox whose count is needs.list's total. */
async function pushText(count: () => Promise<number>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maestro-invariant-"));
  roots.push(root);
  const sent: string[] = [];
  const paseo = {
    agents: {
      create: async () => ({ id: "inbox-1" }),
      ref: () => ({
        refresh: async () => ({
          agent: { archivedAt: null, requiresAttention: false, attentionReason: null, attentionTimestamp: null },
        }),
        send: async (_prompt: string, options?: { attachments?: Array<{ text: string }> }) => {
          sent.push(options?.attachments?.[0]?.text ?? "");
        },
      }),
    },
  } as unknown as Paseo;
  const inbox = new Inbox(
    () => paseo,
    async () => root,
    () => undefined,
    join(root, "inbox.json"),
    () => NOW,
    undefined,
    undefined,
    undefined,
    count,
  );
  // A run you handed Maestro lands at your gate: it pushes at once.
  const adopted: WorkEvent = {
    ts: at(60),
    type: "adopted",
    actor: "human",
    by: "",
    agentId: "agent-gate",
    workspaceId: "ws1",
    provider: "claude",
    branch: null,
    cwd: "/wt/gate",
  } as WorkEvent;
  const ended: WorkEvent = {
    ts: at(50),
    type: "turn.ended",
    actor: "agent",
    agentId: "agent-gate",
    outcome: "completed",
    error: null,
    summary: "## Ask\n- Merge it?",
    turnId: "t1",
  } as WorkEvent;
  const toReview: WorkEvent = {
    ts: at(50),
    type: "state",
    actor: "agent",
    from: "running",
    to: "review",
    reason: null,
  };
  const work = (events: WorkEvent[]) =>
    ({ title: "Work gate", contract: { id: "gate" }, events }) as unknown as StoredWork;
  await inbox.landed(work([adopted]), work([adopted, ended, toReview]));
  const [text] = sent;
  const notice = text ? decodeNotice(text) : null;
  if (!notice) throw new Error("the landing pushed nothing");
  return noticeText(notice);
}

test("invariant 1: header total == Σ kinds == the Needs you section == the Feed tab == the push count", async () => {
  const { items, asks, reviews, landing } = everything();
  // The fleet's report says which Paseo agent that Claude session is.
  const sessionAgents = new Map([["51ba8cdf-claude-session-of-agent-perm", "agent-perm"]]);
  const needs = needsOf({ items, asks, reviews, landing, sessionAgents, workspace: "broomva" }, NOW);
  const total = needs.summary.total;
  // What the fixture holds on you: two approvals, three asks (two decisions and the review), three owner steps.
  expect(needs.summary.byKind).toEqual({ ask: 4, approval: 2, owner_step: 3 });
  expect(total).toBe(9);

  const sumOfKinds = NEED_KINDS.reduce((sum, kind) => sum + needs.summary.byKind[kind], 0);
  const header = await headerButton(needs);
  const headerCount = Number(/^(\d+) needs? you$/.exec(header.label ?? "")?.[1]);
  const section = needsSection(needs.rows, items, asks).length;
  // The List's Needs you chip counts what its filter lists: needs.list's holds in scope, here every one.
  const chip = needsSection(needs.rows, items, asks, null).length;
  const feedTab = tabBadges(needs).feed?.count;
  const push = await pushText(async () => needs.summary.total);
  const pushCount = Number(/^\*\*(\d+) needs? you\*\*/.exec(push)?.[1]);

  expect({ rows: needs.rows.length, sumOfKinds, headerCount, section, chip, feedTab, pushCount }).toEqual({
    rows: total,
    sumOfKinds: total,
    headerCount: total,
    section: total,
    chip: total,
    feedTab: total,
    pushCount: total,
  });
  // Each initiative's "N need you" is the section its scope lists, from the same rows.
  const byInitiative = needsByInitiative(needsSection(needs.rows, items, asks));
  expect([...byInitiative].sort()).toEqual([
    ["genesis", 2],
    ["hawthorne", 2],
    ["skene", 1],
  ]);
  for (const scope of initiatives(items, byInitiative)) {
    expect([scope.name, scope.needsYou]).toEqual([
      scope.name,
      needsSection(needs.rows, items, asks, scope.name).length,
    ]);
  }
  expect(header).toMatchObject(headerFace(total));
  expect(push).toBe("**9 need you** · Work gate\n\nMerge it?");
});

test("invariant 1 holds for every subset of the fixture, and with nothing at all (no badge, no number)", async () => {
  const { items, asks, reviews, landing } = everything();
  for (let mask = 0; mask < 16; mask += 1) {
    const needs = needsOf(
      {
        items: mask & 1 ? items : [],
        asks: mask & 2 ? asks : [],
        reviews: mask & 4 ? reviews : [],
        landing: mask & 8 ? landing : null,
        workspace: "broomva",
      },
      NOW,
    );
    const total = needs.summary.total;
    expect(NEED_KINDS.reduce((sum, kind) => sum + needs.summary.byKind[kind], 0)).toBe(total);
    expect(needs.rows).toHaveLength(total);
    expect(needsSection(needs.rows, mask & 1 ? items : [], mask & 2 ? asks : [])).toHaveLength(total);
    expect(tabBadges(needs).feed?.count ?? 0).toBe(total);
    expect(headerFace(total).visible).toBe(total > 0);
  }
});
