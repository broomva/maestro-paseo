// Routing your answers (BRO-2827): an answer turned into action once it is
// where it belongs, on origin/main for an ask whose home is main (once the
// batch lands, server/answers-landing.ts), at once for one whose home is a
// checkout. The asks' receipt log (`asks.jsonl`, the spec's §5.5 receipts) is
// the ask's event log: each `ask.answered` line Maestro wrote is routed at
// most once, and the routing is recorded there as an `ask.routed` line.
//   - The session that asked (the receipt's origin, else the ask's stamp),
//     alive and idle: the answer is sent to it, quoted verbatim. Alive and at
//     work, or asking for a permission: the delivery waits for it to go idle
//     (a turn's end, or the loop's next wake). A turn is never interrupted.
//   - Gone, or none named, in this order (BRO-2990, owner answer A8):
//     1. an answer that takes an option the ledger marks `status_quo: true`
//        closes as a no-op; so does an idea's, whose develop answer files its
//        own held work (index.server.ts). Read from the ask's own keys, never
//        from the words of an option;
//     2. an owner-only ask (ownerOnly) is held work for you, never relayed and
//        never started by anyone but you (BRO-2910);
//     3. relayed (BRO-2918) to the session that asked another ask in the same
//        ledger, newest first, then to the initiative's driver when it names a
//        session; one at work holds it for RELAY_WAIT_MS from when it first
//        waited on that session (an `ask.waiting` line), then the next is asked;
//     4. with no one to relay to: queued for the conductor, as a `lane.assign`
//        candidate carrying the ask, your answer and pointers
//        (shared/answers.ts ConductorCandidate), written once on the answer's
//        `ask.routed` line, which is the queue. It is never queued work: in
//        13b97ad9 six answers filed that way became six sessions nobody
//        watched. Decisions shows it waiting "for the conductor".
// Answers given before routing first ran (`routing.began`, by time, so the
// order its line and an answer's are appended in does not matter) are never
// routed: they were acted on by hand, or not, before Maestro could. An answer
// whose ask now records another outcome where it lives (main's wins, §5.2) is
// superseded: recorded, never acted on, its words kept in its receipt. A
// fleet scope's own asks are the fleet's to act on, and are never routed here.
// Routing never decides and never starts work: the delivery is your answer
// verbatim, held work waits for you, and a candidate waits for the conductor.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AnswerFate,
  type AnswersLanding,
  answersWord,
  type ConductorCandidate,
  ConductorCandidateSchema,
  type ConductorPending,
  type ConductorVerb,
  type Route,
} from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { UNDO_MS } from "../shared/undo";
import { isRow, text } from "./control-asks";
import { homeWords, type WorkspaceRead } from "./control-home";
import { type Engine, realTimer, type Timer, UserError, within } from "./engine";
import { BY_HUMAN, LOOP } from "./events";
import { inspectFolder } from "./folders";
import type { Paseo } from "./runs";

/** The longest a route waits for a session to say how it is. */
export const SESSION_MS = 10_000;

/** How long an answer waits on a relay at work before the next one is asked; after the last, it waits for the conductor. */
export const RELAY_WAIT_MS = 2 * 60 * 60_000;

/** A work item's title, at most this long. */
const TITLE_MAX = 90;

/** An `ask.answered` receipt, as control-asks.ts writes it. */
export interface AnsweredReceipt {
  kind: "ask.answered";
  at: string | null;
  home: string;
  homeKind: "main" | "checkout" | "root";
  ledger: string;
  uid: string | null;
  id: string;
  originAgentId: string | null;
  answerOption: string | null;
  answer: string | null;
}

export interface RoutedReceipt {
  kind: "ask.routed";
  actor: "maestro";
  at: string;
  /** The answer it routed (answerKey). */
  key: string;
  ledger: string;
  uid: string | null;
  id: string;
  route: Route;
  agentId: string | null;
  work: { id: string; title: string } | null;
  /** Why, in words. */
  reason: string;
  /** Route `conductor` only: what the conductor needs to give the answer to a lane (BRO-2990). */
  candidate?: ConductorCandidate;
}

/** One answer by its receipt: the ask's handle and the moment it was answered. */
export function answerKey(receipt: Pick<AnsweredReceipt, "ledger" | "uid" | "id" | "at">): string {
  return `${receipt.ledger}#${receipt.uid ?? receipt.id}@${receipt.at ?? ""}`;
}

/** The receipt log, read: the workspace's answers in order, those routed, and when routing began. */
export interface Log {
  answered: AnsweredReceipt[];
  routed: Map<string, RoutedReceipt>;
  /** When routing first ran (its first `routing.began`); null: it has not begun. */
  began: string | null;
  /**
   * By answer key: the sessions a relayed answer waited on, each with when it
   * first did (`ask.waiting` lines), and the latest one. Written to the log so
   * a restart keeps both the patience clock and who the answer waits on.
   */
  waiting: Map<string, { since: Map<string, string>; on: string }>;
  /** Your decisions on answers that wait for the conductor, by receipt (`conductor.*` lines, BRO-2990). */
  decisions: Map<string, ConductorDecision>;
}

/**
 * One decision of yours on an answer that waits for the conductor: decided
 * (`conductor.decided`), taken back in its undo window (`conductor.undone`),
 * or applied once it closed (`conductor.closed`, with the work it filed).
 */
export interface ConductorDecision {
  key: string;
  verb: ConductorVerb;
  receipt: string;
  at: string;
  appliesAt: string;
  undone: boolean;
  closed: { at: string; work: { id: string; title: string } | null } | null;
}

/** The decision on this answer that waits to take effect: decided, not undone, not applied. Pure. */
export function pendingDecision(log: Log, key: string): ConductorDecision | null {
  for (const decision of log.decisions.values()) {
    if (decision.key === key && !decision.undone && !decision.closed) return decision;
  }
  return null;
}

/** The decision that closed this answer for the conductor (filed or dismissed), or null. Pure. */
export function closedDecision(log: Log, key: string): ConductorDecision | null {
  for (const decision of log.decisions.values()) if (decision.key === key && decision.closed) return decision;
  return null;
}

/**
 * Whether an answer was given once routing ran: by its time, to the second
 * (an answer's `answered_at` has no finer part), never by where its line
 * fell in the log. One with no time is not routed. Pure.
 */
export function afterBegan(receipt: Pick<AnsweredReceipt, "at">, began: string | null): boolean {
  if (began === null || receipt.at === null) return false;
  const at = Date.parse(receipt.at);
  const from = Date.parse(began);
  if (!Number.isFinite(at) || !Number.isFinite(from)) return false;
  return at >= Math.floor(from / 1000) * 1000;
}

/**
 * Whether the ask as it reads now records this answer: the option it took, or
 * for an answer in words alone, those words. Another outcome there means the
 * ask was closed another way, and that outcome wins. Pure.
 */
export function records(
  ask: Pick<DecisionAsk, "state" | "answerOption" | "answer">,
  receipt: AnsweredReceipt,
): boolean {
  // Archived since it was answered still records the answer it holds; open records none.
  if (ask.state === "open") return false;
  return receipt.answerOption ? ask.answerOption === receipt.answerOption : ask.answer === receipt.answer;
}

/** The receipt log's lines, read. A line that is not a receipt is skipped. Pure. */
export function readLog(source: string): Log {
  const log: Log = { answered: [], routed: new Map(), began: null, waiting: new Map(), decisions: new Map() };
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRow(row)) continue;
    if (row.kind === "routing.began") {
      log.began ??= text(row.at);
    } else if (row.kind === "ask.waiting" && typeof row.key === "string") {
      const on = text(row.on);
      const at = text(row.at);
      // A time that does not parse would make patience never run out: skip it, and the next pass writes a good one.
      if (!on || !at || !Number.isFinite(Date.parse(at))) continue;
      const entry = log.waiting.get(row.key) ?? { since: new Map<string, string>(), on };
      if (!entry.since.has(on)) entry.since.set(on, at);
      entry.on = on;
      log.waiting.set(row.key, entry);
    } else if (row.kind === "ask.routed" && typeof row.key === "string") {
      if (!log.routed.has(row.key)) log.routed.set(row.key, row as unknown as RoutedReceipt);
    } else if (row.kind === "conductor.decided") {
      const key = text(row.key);
      const receipt = text(row.receipt);
      const at = text(row.at);
      const appliesAt = text(row.appliesAt);
      const verb = row.verb === "file" || row.verb === "dismiss" ? row.verb : null;
      if (!key || !receipt || !at || !appliesAt || !verb || log.decisions.has(receipt)) continue;
      log.decisions.set(receipt, { key, verb, receipt, at, appliesAt, undone: false, closed: null });
    } else if (row.kind === "conductor.undone" || row.kind === "conductor.closed") {
      const decision = log.decisions.get(text(row.receipt) ?? "");
      if (!decision || decision.closed || decision.undone) continue;
      if (row.kind === "conductor.undone") decision.undone = true;
      else {
        const work =
          isRow(row.work) && text(row.work.id)
            ? { id: text(row.work.id) ?? "", title: text(row.work.title) ?? "" }
            : null;
        decision.closed = { at: text(row.at) ?? "", work };
      }
    } else if (row.kind === "ask.answered" && (row.homeKind === "main" || row.homeKind === "checkout")) {
      const id = text(row.id);
      const ledger = text(row.ledger);
      if (!id || !ledger) continue;
      log.answered.push({
        kind: "ask.answered",
        at: text(row.at),
        home: text(row.home) ?? "",
        homeKind: row.homeKind,
        ledger,
        uid: text(row.uid),
        id,
        originAgentId: text(row.originAgentId),
        answerOption: text(row.answerOption),
        answer: text(row.answer),
      });
    }
  }
  return log;
}

/** An ask's handle across receipts: its ledger and its uid, else its id. */
const handleKey = (ref: { ledger: string; uid: string | null; id: string }) => `${ref.ledger}#${ref.uid ?? ref.id}`;

/**
 * The ask a receipt answered, as it reads now: of the asks by its handle, the
 * one at the receipt's own kind of home (its checkout, by path, for a
 * checkout's), else main's, else the first. Pure.
 */
export function askFor(all: readonly DecisionAsk[], receipt: AnsweredReceipt): DecisionAsk | null {
  const named = all.filter((ask) => !ask.scope && sameAsk(ask, receipt));
  const inCheckout = (ask: DecisionAsk) =>
    ask.home.kind === "checkout" && receipt.home.startsWith(`${ask.home.path.replace(/[\\/]+$/, "")}/`);
  const own = receipt.homeKind === "checkout" ? named.find(inCheckout) : named.find((ask) => ask.home.kind === "main");
  return own ?? named.find((ask) => ask.home.kind === "main") ?? named[0] ?? null;
}

/** A receipt's ask: by its uid when it has one; one answered without a uid by ledger and id (a uid main stamped since is the same ask). */
const sameAsk = (
  ask: Pick<DecisionAsk, "ledger" | "uid" | "id">,
  ref: { ledger: string; uid: string | null; id: string },
) => ask.ledger === ref.ledger && (ref.uid ? ask.uid === ref.uid : ask.id === ref.id);

/**
 * An ask whose answer decides an act only you perform: `class: authority`,
 * `credential` or `external` (any case), or a `why_you` that says owner-only. Its answer authorizes the
 * decision, never an agent doing the act (BRO-2910). Pure.
 */
export function ownerOnly(ask: DecisionAsk | null): boolean {
  const kind = (ask?.audit?.class ?? "").toLowerCase();
  return OWNER_CLASSES.has(kind) || /owner[- ]only/i.test(ask?.whyYou ?? "");
}

/**
 * The classes whose act is the owner's (DECISION-LAYER.md): authority and
 * credential, and external, an act on the outside world (a post, a purge, a
 * message to a person); the rotation asks were classed external or authority.
 */
const OWNER_CLASSES = new Set(["authority", "credential", "external"]);

const UNREAD_LINE =
  "Maestro could not read the ask itself, so whether it is owner-only is unknown: if it is, hand over the exact command; do not run it.";

const OWNER_ONLY_LINE =
  "The ask is owner-only: the answer decides it, and the owner-only act itself stays the owner's. Hand over the exact command; do not run it.";

/** The message an asking session gets: your answer, verbatim, quoted, and where it is written. */
export function deliveryText(receipt: AnsweredReceipt, ask: DecisionAsk | null): string {
  const what = ask?.headline ?? ask?.question ?? receipt.id;
  const quoted = (receipt.answer ?? ask?.answer ?? "(no words)").split("\n").map((line) => `> ${line}`);
  const where =
    receipt.homeKind === "main" ? `It is in ${receipt.ledger} on origin/main.` : `It is written in ${receipt.home}.`;
  return [
    `Your ask was answered in Maestro: "${what}" (${receipt.ledger} ${receipt.id}).`,
    "",
    "The answer, verbatim:",
    "",
    ...quoted,
    "",
    `${where} Act on it, and carry on.`,
    ...(ownerOnly(ask) ? ["", OWNER_ONLY_LINE] : []),
    ...(ask ? [] : ["", UNREAD_LINE]),
  ].join("\n");
}

/** A session that may take an answer its asker cannot: who it is to the ask, in words. */
export interface Relay {
  agentId: string;
  as: string;
}

/**
 * The other sessions that asked in the same ledger, at the same home, newest
 * first: a ledger is one arc's, so they are that arc's own sessions, and the
 * link is written in the file, never guessed (BRO-2918). Pure.
 */
export function arcAskers(all: readonly DecisionAsk[], ask: DecisionAsk): Relay[] {
  if (ask.scope) return [];
  const own = ask.origin?.agentId ?? null;
  const askers = all
    .filter(
      (other) =>
        !other.scope &&
        other.ledger === ask.ledger &&
        other.home.kind === ask.home.kind &&
        other.home.path === ask.home.path &&
        other.origin &&
        other.origin.agentId !== own,
    )
    .sort((a, b) => (b.askedAt ?? "").localeCompare(a.askedAt ?? ""));
  const seen = new Set<string>();
  const out: Relay[] = [];
  for (const other of askers) {
    const agentId = other.origin?.agentId;
    if (!agentId || seen.has(agentId)) continue;
    seen.add(agentId);
    out.push({ agentId, as: `the session that asked ${other.id} in ${ask.ledger}` });
  }
  return out;
}

/** The message a relayed session gets: the answer, why it came to this session, and what it may do. */
/** Never for an owner-only ask: those are held for you, never relayed. */
export function relayText(receipt: AnsweredReceipt, ask: DecisionAsk, why: string, as: string): string {
  const what = ask?.headline ?? ask?.question ?? receipt.id;
  const quoted = (receipt.answer ?? ask?.answer ?? "(no words)").split("\n").map((line) => `> ${line}`);
  return [
    `An ask was answered in Maestro: "${what}" (${receipt.ledger} ${receipt.id}). ${why} It comes to you as ${as}.`,
    "",
    "The answer, verbatim:",
    "",
    ...quoted,
    "",
    "Decide what follows: carry it out if it is this arc's to do, append it to the arc's ticket, or file work with `maestro new`. Nothing has been filed for it.",
  ].join("\n");
}

/** A work item's title and brief, from the ask and your answer. */
export function routedWork(
  receipt: AnsweredReceipt,
  ask: DecisionAsk | null,
  why: string,
): { title: string; brief: string } {
  const theirs = ownerOnly(ask);
  const what = ask?.headline ?? ask?.question ?? receipt.id;
  const title = clip(`Act on your answer: ${what}`, TITLE_MAX);
  const lines = [
    `You answered an ask in Maestro (${receipt.ledger} ${receipt.id}). ${why} ${theirs ? "The act it decides is yours." : "Do what the answer decided."}`,
    "",
    "## The ask",
    "",
    ask?.question ?? ask?.headline ?? receipt.id,
  ];
  if (ask?.stakes) lines.push("", `What waiting costs: ${ask.stakes}`);
  if (ask && ask.options.length > 0) {
    lines.push("", "Its options:");
    for (const option of ask.options) {
      const chosen = option.id === receipt.answerOption ? " (your answer)" : "";
      lines.push(`- ${option.label}${option.consequence ? `: ${option.consequence}` : ""}${chosen}`);
    }
  }
  lines.push(
    "",
    "## Your answer, verbatim",
    "",
    ...(receipt.answer ?? "(no words)").split("\n").map((line) => `> ${line}`),
    "",
    "## How",
    "",
    `The answer is recorded in ${receipt.ledger} (${receipt.homeKind === "main" ? "origin/main" : receipt.home}); do not edit the ask.`,
    theirs
      ? "The ask is owner-only. If this is started, do not perform the act: write out the exact command or steps for the owner, and stop."
      : "Do the smallest complete thing the answer asks for. If it turns out to need nothing done, say so and stop.",
  );
  return { title, brief: lines.join("\n") };
}

/**
 * An answer no session could take, as the conductor gets it (shared/answers.ts
 * ConductorCandidate): the ask, your answer verbatim, and where to look. Pure.
 */
export function conductorCandidate(
  receipt: AnsweredReceipt,
  ask: DecisionAsk,
  askedBy: string | null,
  repo: string,
): ConductorCandidate {
  return {
    for: "lane.assign",
    ask: {
      ledger: receipt.ledger,
      uid: receipt.uid,
      id: receipt.id,
      headline: ask.headline ?? ask.question ?? receipt.id,
      question: ask.question,
      stakes: ask.stakes,
      options: ask.options.map((option) => ({ id: option.id, label: option.label, consequence: option.consequence })),
    },
    answer: { option: receipt.answerOption, words: receipt.answer ?? ask.answer, at: receipt.at },
    pointers: {
      key: answerKey(receipt),
      home: receipt.home,
      homeKind: receipt.homeKind,
      askedBy,
      repo,
      initiative: ask.initiative ?? null,
    },
  };
}

/** A work item's title and brief, from an answer that waited for the conductor and you filed (BRO-2990). Pure. */
export function candidateWork(candidate: ConductorCandidate): { title: string; brief: string } {
  const { ask, answer, pointers } = candidate;
  const title = clip(`Act on your answer: ${ask.headline}`, TITLE_MAX);
  const lines = [
    `You answered an ask in Maestro (${ask.ledger} ${ask.id}). No session on its arc could take your answer, so it waited for the conductor, and you filed it as work. Do what the answer decided.`,
    "",
    "## The ask",
    "",
    ask.question ?? ask.headline,
  ];
  if (ask.stakes) lines.push("", `What waiting costs: ${ask.stakes}`);
  if (ask.options.length > 0) {
    lines.push("", "Its options:");
    for (const option of ask.options) {
      const chosen = option.id === answer.option ? " (your answer)" : "";
      lines.push(`- ${option.label}${option.consequence ? `: ${option.consequence}` : ""}${chosen}`);
    }
  }
  lines.push(
    "",
    "## Your answer, verbatim",
    "",
    ...(answer.words ?? "(no words)").split("\n").map((line) => `> ${line}`),
    "",
    "## Where to look",
    "",
    `- The ledger: ${ask.ledger}, at ${pointers.homeKind === "main" ? "origin/main" : pointers.home}`,
    `- The session that asked: ${pointers.askedBy ?? "none named"} (gone)`,
    ...(pointers.initiative ? [`- The initiative: ${pointers.initiative}`] : []),
    "",
    "## How",
    "",
    `The answer is recorded in ${ask.ledger}; do not edit the ask. Do the smallest complete thing the answer asks for. If it turns out to need nothing done, say so and stop.`,
  );
  return { title, brief: lines.join("\n") };
}

function clip(words: string, max: number): string {
  if (words.length <= max) return words;
  const cut = words.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/** How a session is now: idle (it can be told), at work (it waits), or gone. */
type Session = "idle" | "busy" | "gone";

export interface RouterOptions {
  receipts: string;
  asks: { read(fresh?: boolean): Promise<WorkspaceRead> };
  engine: Pick<Engine, "create" | "answered">;
  client: () => Paseo | null;
  /** Where routed work runs when the asking session's folder is gone: the control repo. */
  controlRepo: string;
  /** The initiative's driver as a session, when its record names one (coordinator:<hex>, session:<id>). */
  driver?: (initiative: string, paseo: Paseo) => Promise<Relay | null>;
  now?: () => number;
  log?: (message: string) => void;
  sessionMs?: number;
  /** Arms a decision's undo window (conductor.decide); tests pass their own, driven by the same clock as `now`. */
  timer?: Timer;
}

/** What one answer's route came to on this pass. */
export interface RouteOutcome {
  key: string;
  ledger: string;
  id: string;
  /** `routed` wrote its receipt; the rest wait for a later pass, with why. */
  status: "routed" | "unlanded" | "queued" | "failed";
  route: Route | null;
  words: string;
}

export class AnswerRouter {
  private readonly options: RouterOptions;
  private readonly now: () => number;
  private running: Promise<unknown> = Promise.resolve();
  private cached: { stamp: string; log: Log } | null = null;
  /** Why an answer still waits, as the last pass found it: Decisions says it. */
  private readonly waits = new Map<string, { status: "unlanded" | "queued" | "failed"; words: string }>();
  /** Your decisions whose undo window is armed, by receipt, to the timer's cancel. */
  private readonly armed = new Map<string, () => void>();

  constructor(options: RouterOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Marks where routing begins, once: every answer before it is never routed. */
  async begin(): Promise<void> {
    const log = await this.log();
    if (log.began !== null) return;
    await this.append({ kind: "routing.began", actor: "maestro", at: new Date(this.now()).toISOString() });
  }

  /** Runs `work` after every pass and decision before it: one writer to the receipt log at a time. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.running.catch(() => undefined).then(work);
    this.running = next;
    return next;
  }

  /**
   * Your decision on an answer that waits for the conductor (shared/answers.ts
   * decideConductor): written now as a `conductor.decided` receipt, applied
   * UNDO_MS later unless undone. Refused when the answer does not wait for the
   * conductor, was already filed or dismissed, or already has a decision in
   * its undo window.
   */
  decide(key: string, verb: ConductorVerb): Promise<ConductorPending> {
    return this.serial(async () => {
      const log = await this.log();
      if (log.routed.get(key)?.route !== "conductor")
        throw new UserError("That answer does not wait for the conductor.");
      if (closedDecision(log, key)) throw new UserError("That answer was already filed as work or dismissed.");
      if (pendingDecision(log, key)) {
        throw new UserError("A decision on that answer already waits to take effect. Undo it first to change it.");
      }
      const now = this.now();
      const receipt = randomUUID();
      const appliesAt = new Date(now + UNDO_MS).toISOString();
      await this.append({
        kind: "conductor.decided",
        actor: "human",
        at: new Date(now).toISOString(),
        key,
        verb,
        receipt,
        appliesAt,
      });
      this.arm(receipt, appliesAt);
      return { verb, receipt, appliesAt };
    });
  }

  /** Take back a decision while its undo window runs (shared/answers.ts undoConductor). */
  undo(receipt: string): Promise<{ undone: boolean }> {
    return this.serial(async () => {
      const decision = (await this.log()).decisions.get(receipt);
      if (!decision) throw new UserError("No such decision.");
      if (decision.undone) return { undone: true };
      if (decision.closed || this.now() >= Date.parse(decision.appliesAt)) {
        throw new UserError("Its undo window has closed: it took effect.");
      }
      this.armed.get(receipt)?.();
      this.armed.delete(receipt);
      await this.append({
        kind: "conductor.undone",
        actor: "human",
        at: new Date(this.now()).toISOString(),
        key: decision.key,
        receipt,
      });
      return { undone: true };
    });
  }

  /**
   * Apply every decision whose undo window has closed, and arm the rest: at
   * start (a restart keeps your decisions) and on each pass. Never throws: one
   * that cannot be applied yet is tried again at the next pass.
   */
  async resume(): Promise<void> {
    await this.serial(async () => {
      const log = await this.log();
      for (const decision of log.decisions.values()) {
        if (decision.undone || decision.closed) continue;
        if (this.now() >= Date.parse(decision.appliesAt)) await this.applyDue(decision.receipt);
        else if (!this.armed.has(decision.receipt)) this.arm(decision.receipt, decision.appliesAt);
      }
    });
  }

  private arm(receipt: string, appliesAt: string): void {
    const timer = this.options.timer ?? realTimer;
    const cancel = timer(
      () => {
        this.armed.delete(receipt);
        return this.serial(() => this.applyDue(receipt));
      },
      Math.max(0, Date.parse(appliesAt) - this.now()),
    );
    this.armed.set(receipt, cancel);
  }

  /** Apply one decision if it is still due (not undone, not applied, its window closed); never throws. */
  private async applyDue(receipt: string): Promise<void> {
    try {
      const log = await this.log();
      const decision = log.decisions.get(receipt);
      if (!decision || decision.undone || decision.closed) return;
      if (this.now() < Date.parse(decision.appliesAt)) return this.arm(receipt, decision.appliesAt);
      const work = decision.verb === "file" ? await this.file(log, decision.key) : null;
      await this.append({
        kind: "conductor.closed",
        actor: "human",
        at: new Date(this.now()).toISOString(),
        key: decision.key,
        receipt,
        verb: decision.verb,
        work,
      });
    } catch (error) {
      this.options.log?.(`answers: applying your decision ${receipt}: ${(error as Error).message}`);
    }
  }

  /**
   * File an answer that waited for the conductor as queued work: gate human,
   * never dispatched (you or a lane start it), briefed from its candidate, in
   * the folder it points at when that is still a repository, else the control
   * repo. Filed once (Contract.answer): one filed before stands.
   */
  private async file(log: Log, key: string): Promise<{ id: string; title: string }> {
    const existing = (await this.options.engine.answered()).get(key);
    if (existing) return { id: existing.id, title: existing.title };
    const parsed = ConductorCandidateSchema.safeParse(log.routed.get(key)?.candidate);
    if (!parsed.success) throw new Error("its candidate does not read");
    const candidate = parsed.data;
    const folder = await inspectFolder(candidate.pointers.repo).catch(() => null);
    const repo = folder?.directory && folder.git ? folder.path : this.options.controlRepo;
    const { title, brief } = candidateWork(candidate);
    const item = await this.options.engine.create(
      this.options.client(),
      {
        title,
        brief,
        repo,
        gate: "human",
        check: "",
        initiative: candidate.pointers.initiative ?? "",
        dispatch: false,
        answer: key,
      },
      BY_HUMAN,
    );
    return { id: item.id, title: item.title };
  }

  /**
   * Routes every answer that is due (the header above), one pass at a time;
   * `agentId` limits it to the answers that session asked, as when its turn
   * ends. Never throws: an answer that could not be routed waits for a later
   * pass, and says why.
   */
  route(only: { agentId?: string } = {}): Promise<RouteOutcome[]> {
    const outcomes = this.serial(() => this.pass(only));
    // A decision whose undo window closed while nothing was armed (a restart) is applied after the pass.
    void outcomes.then(() => this.resume()).catch(() => undefined);
    return outcomes;
  }

  private async pass(only: { agentId?: string }): Promise<RouteOutcome[]> {
    let log: Log;
    try {
      await this.begin();
      log = await this.log();
    } catch (error) {
      this.options.log?.(`answers: reading the receipts: ${(error as Error).message}`);
      return [];
    }
    const due = log.answered
      .filter((receipt) => afterBegan(receipt, log.began))
      .filter((receipt) => !log.routed.has(answerKey(receipt)))
      // A turn's end asks for its own session's answers (the receipt names the session that asked, as the ask did),
      // and for those relayed answers that wait on it.
      .filter(
        (receipt) =>
          !only.agentId ||
          receipt.originAgentId === only.agentId ||
          // Any session it has waited on: its asker at work first, then the next once that one's patience ran out.
          log.waiting.get(answerKey(receipt))?.since.has(only.agentId) === true,
      );
    if (due.length === 0) return [];
    let read: WorkspaceRead;
    try {
      read = await this.options.asks.read(true);
    } catch (error) {
      this.options.log?.(`answers: reading the asks to route ${answersWord(due.length)}: ${(error as Error).message}`);
      return [];
    }
    const outcomes: RouteOutcome[] = [];
    // Only the latest answer to an ask is acted on: an earlier one a later replaced is recorded as superseded.
    const latest = new Map<string, AnsweredReceipt>();
    for (const receipt of log.answered) latest.set(handleKey(receipt), receipt);
    for (const receipt of due) {
      const ask = askFor(read.all, receipt);
      const agentId = receipt.originAgentId ?? ask?.origin?.agentId ?? null;
      const outcome =
        latest.get(handleKey(receipt)) !== receipt
          ? await this.routed(receipt, {
              route: "superseded",
              agentId,
              work: null,
              reason: "A later answer to this ask replaced it.",
            })
          : await this.one(receipt, ask, agentId, read, log).catch((error) =>
              this.wait(receipt, "failed", `${(error as Error).message}`),
            );
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async one(
    receipt: AnsweredReceipt,
    ask: DecisionAsk | null,
    agentId: string | null,
    read: WorkspaceRead,
    log: Log,
  ): Promise<RouteOutcome> {
    const key = answerKey(receipt);
    if (receipt.homeKind === "main" && !ask) {
      // A read that failed (no main read, or this ledger unreadable) is no evidence: look again.
      if (read.main === null || read.warnings.some((warning) => warning.includes(receipt.ledger))) {
        return this.wait(
          receipt,
          "unlanded",
          `${receipt.ledger} could not be read; Maestro looks again at its next check.`,
        );
      }
      // No ledger holds the ask by its name now (moved, renamed, removed: Maestro does not guess which): a stop for
      // you, as held work in Needs you, never a discard.
      return this.stop(receipt, agentId);
    }
    if (receipt.homeKind === "main" && ask?.batched) {
      return this.wait(receipt, "unlanded", "It waits to land on origin/main.");
    }
    // Open where it lives now (a checkout's local copy, a batch reset by hand): your answer is not there yet.
    if (ask?.state === "open") {
      return this.wait(
        receipt,
        "unlanded",
        `It reads open in ${homeWords(ask.home)} now; Maestro acts on your answer once it is there.`,
      );
    }
    // Where the ask lives now it records another outcome, or was archived: that stands, and yours is never acted on.
    if (ask && !records(ask, receipt)) {
      const theirs =
        ask.state === "archived"
          ? " (archived)"
          : ask.answer
            ? `: "${clip(ask.answer.split("\n")[0] ?? "", 120)}"`
            : "";
      return this.routed(receipt, {
        route: "superseded",
        agentId,
        work: null,
        reason: `The ask records another outcome in ${homeWords(ask.home)}${theirs}, and that one stands; yours is kept in its receipt.`,
      });
    }
    const paseo = this.options.client();
    if (agentId) {
      if (!paseo)
        return this.wait(
          receipt,
          "queued",
          "Paseo has not connected to Maestro yet, so the session that asked could not be asked.",
        );
      const session = await this.session(paseo, agentId);
      if (session === "busy") {
        return this.wait(
          receipt,
          "queued",
          "The session that asked is at work; your answer goes to it when it is idle.",
        );
      }
      if (session === "idle") {
        await paseo.agents.ref(agentId).send(deliveryText(receipt, ask));
        return this.routed(receipt, {
          route: "delivered",
          agentId,
          work: null,
          reason: "Sent to the session that asked, verbatim.",
        });
      }
    }
    const why = agentId ? "The session that asked is gone." : "No session is named as the one that asked.";
    // An ask no read holds (a checkout's, moved or unreadable): whether it is owner-only cannot be known, so it is held.
    if (!ask) return this.stop(receipt, agentId);
    if (ask.idea) {
      return this.routed(receipt, {
        route: "none",
        agentId,
        work: null,
        reason: "An idea's answer files its own work: develop files it, park and kill need none.",
      });
    }
    const option = ask?.options.find((entry) => entry.id === receipt.answerOption) ?? null;
    if (option?.statusQuo) {
      return this.routed(receipt, {
        route: "none",
        agentId,
        work: null,
        reason: `"${option.label}" keeps things as they are (the ledger marks it status_quo), so no work was filed.`,
      });
    }
    // Owner-only: held for you, never relayed, never started (BRO-2910).
    if (ownerOnly(ask)) {
      return this.held(
        receipt,
        ask,
        agentId,
        `${why} The ask is owner-only, so the act it decides is yours.`,
        "Your answer decides an owner-only act. Carry it out from the ask's own steps, then close this.",
      );
    }
    const relayed = await this.relay(paseo, receipt, ask, read, log, why);
    if (relayed) return relayed;
    // Filed as work by a Maestro before BRO-2990, its receipt never written (a crash between): that item stands.
    const existing = (await this.options.engine.answered()).get(key);
    if (existing) {
      return this.routed(receipt, {
        route: "work",
        agentId,
        work: { id: existing.id, title: existing.title },
        reason: `${why} Filed as work before; that item stands.`,
      });
    }
    // No one to take it: queued for the conductor, never as work (A8). In 13b97ad9 the work this filed was started.
    const candidate = conductorCandidate(receipt, ask, agentId, await this.repoFor(ask));
    this.options.log?.(`answers: ${receipt.ledger} ${receipt.id}: ${why} Queued for the conductor (lane.assign)`);
    return this.routed(receipt, {
      route: "conductor",
      agentId,
      work: null,
      reason: `${why} No session on its arc could take it, so it waits for the conductor to give it to a lane. Nothing was started.`,
      candidate,
    });
  }

  /**
   * The answers queued for the conductor (route `conductor`), oldest first,
   * that you have not filed or dismissed and hold no decision of yours in its
   * undo window: the `lane.assign` candidates the conductor (BRO-2989) reads. Pure: a read
   * of the receipt log, which is the queue. A line whose candidate does not
   * parse is skipped, never guessed at.
   */
  async candidates(): Promise<ConductorCandidate[]> {
    const log = await this.log();
    const out: ConductorCandidate[] = [];
    for (const routed of log.routed.values()) {
      if (routed.route !== "conductor") continue;
      // Filed or dismissed by you, or with your decision in its undo window: not the conductor's.
      if (closedDecision(log, routed.key) || pendingDecision(log, routed.key)) continue;
      const parsed = ConductorCandidateSchema.safeParse(routed.candidate);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /**
   * An answer its asker cannot take, sent to the first session that can: the
   * arc's other askers, newest first, then the initiative's driver. One at
   * work holds the answer until it is idle; one gone is passed over. Null when
   * none is left, and the answer is queued for the conductor (BRO-2918, BRO-2990).
   */
  private async relay(
    paseo: Paseo | null,
    receipt: AnsweredReceipt,
    ask: DecisionAsk,
    read: WorkspaceRead,
    log: Log,
    why: string,
  ): Promise<RouteOutcome | null> {
    const askers = arcAskers(read.all, ask);
    if (!paseo) {
      if (askers.length === 0 && !ask.initiative) return null;
      return this.wait(
        receipt,
        "queued",
        `${why} Paseo has not connected to Maestro yet, so its arc could not be asked.`,
      );
    }
    const key = answerKey(receipt);
    const since = log.waiting.get(key)?.since;
    // The driver is looked up only once the arc's own askers are exhausted.
    for (let at = 0; ; at += 1) {
      const relay =
        at < askers.length
          ? askers[at]
          : at === askers.length && ask.initiative && this.options.driver
            ? await this.options.driver(ask.initiative, paseo)
            : null;
      if (!relay) return null;
      const session = await this.session(paseo, relay.agentId);
      if (session === "gone") continue;
      if (session === "busy") {
        // Waited RELAY_WAIT_MS on this one since it first did: the next is asked, so a busy one never holds it forever.
        const first = since?.get(relay.agentId);
        if (first && this.now() - Date.parse(first) >= RELAY_WAIT_MS) continue;
        if (!first) {
          await this.append({
            kind: "ask.waiting",
            actor: "maestro",
            at: new Date(this.now()).toISOString(),
            key,
            on: relay.agentId,
          });
        }
        return this.wait(receipt, "queued", `${why} It goes to ${relay.as} when that session is idle.`);
      }
      await paseo.agents.ref(relay.agentId).send(relayText(receipt, ask, why, relay.as));
      return this.routed(receipt, {
        route: "relayed",
        agentId: relay.agentId,
        work: null,
        reason: `${why} Sent to ${relay.as}, which decides what follows.`,
      });
    }
  }

  /**
   * An answer whose ask no ledger holds by its name now: held work at your
   * gate, which the loop flags in Needs you as yours to start, briefed from
   * the receipt alone. Filed once (Contract.answer).
   */
  private async stop(receipt: AnsweredReceipt, agentId: string | null): Promise<RouteOutcome> {
    const why = `No ledger holds the ask ${receipt.id} in ${receipt.ledger} now (moved, renamed or removed: Maestro does not guess which).`;
    return this.held(
      receipt,
      null,
      agentId,
      why,
      `${why} Start it if your answer still needs acting on, or cancel it.`,
    );
  }

  /** Held work at your gate, never started for you: Needs you flags it as yours. Filed once (Contract.answer). */
  private async held(
    receipt: AnsweredReceipt,
    ask: DecisionAsk | null,
    agentId: string | null,
    why: string,
    hold: string,
  ): Promise<RouteOutcome> {
    const key = answerKey(receipt);
    const existing = (await this.options.engine.answered()).get(key);
    const work = existing
      ? { id: existing.id, title: existing.title }
      : await (async () => {
          const { title, brief } = routedWork(receipt, ask, why);
          const item = await this.options.engine.create(
            this.options.client(),
            {
              title,
              brief,
              repo: this.options.controlRepo,
              gate: "human",
              check: "",
              initiative: ask?.initiative ?? "",
              dispatch: false,
              answer: key,
              hold,
            },
            LOOP,
          );
          return { id: item.id, title: item.title };
        })();
    return this.routed(receipt, { route: "work", agentId, work, reason: `${why} Held for you as work.` });
  }

  /** The asking session's folder when it is still there, else the control repo. */
  private async repoFor(ask: DecisionAsk | null): Promise<string> {
    const cwd = ask?.origin?.cwd;
    if (cwd) {
      const folder = await inspectFolder(cwd).catch(() => null);
      if (folder?.directory && folder.git) return folder.path;
    }
    return this.options.controlRepo;
  }

  private async session(paseo: Paseo, agentId: string): Promise<Session> {
    const snapshot = await within(() => paseo.agents.ref(agentId).refresh(), this.options.sessionMs ?? SESSION_MS);
    const agent = snapshot?.agent;
    if (!agent || agent.archivedAt || agent.status === "closed") return "gone";
    // Not mid-turn: idle, or stopped on an error (its next turn is the answer). Starting, or asking a permission, waits.
    const between = agent.status === "idle" || agent.status === "error";
    if (between && !agent.activeTurn && agent.pendingPermissions.length === 0) return "idle";
    return "busy";
  }

  private async routed(
    receipt: AnsweredReceipt,
    fields: Pick<RoutedReceipt, "route" | "agentId" | "work" | "reason" | "candidate">,
  ): Promise<RouteOutcome> {
    const key = answerKey(receipt);
    const line: RoutedReceipt = {
      kind: "ask.routed",
      actor: "maestro",
      at: new Date(this.now()).toISOString(),
      key,
      ledger: receipt.ledger,
      uid: receipt.uid,
      id: receipt.id,
      ...fields,
    };
    await this.append(line);
    this.waits.delete(key);
    return {
      key,
      ledger: receipt.ledger,
      id: receipt.id,
      status: "routed",
      route: fields.route,
      words: fateWords(line),
    };
  }

  private wait(receipt: AnsweredReceipt, status: "unlanded" | "queued" | "failed", words: string): RouteOutcome {
    const key = answerKey(receipt);
    const said =
      status === "failed" ? `Maestro could not act on it yet (${words}); it tries again at its next check.` : words;
    this.waits.set(key, { status, words: said });
    if (status === "failed") this.options.log?.(`answers: routing ${receipt.ledger} ${receipt.id}: ${words}`);
    return { key, ledger: receipt.ledger, id: receipt.id, status, route: null, words: said };
  }

  private async append(line: object): Promise<void> {
    await mkdir(dirname(this.options.receipts), { recursive: true, mode: 0o700 });
    await appendFile(this.options.receipts, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    this.cached = null;
  }

  private async log(): Promise<Log> {
    const info = await stat(this.options.receipts).catch(() => null);
    if (!info) return { answered: [], routed: new Map(), began: null, waiting: new Map(), decisions: new Map() };
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (this.cached?.stamp === stamp) return this.cached.log;
    const log = readLog(await readFile(this.options.receipts, "utf8"));
    this.cached = { stamp, log };
    return log;
  }

  /**
   * Each answered ask of the workspace's with what became of your answer
   * (shared/answers.ts AnswerFate): only asks Maestro holds a receipt for. The
   * newest receipt for an ask is its answer.
   */
  async fates(asks: readonly DecisionAsk[], landing: AnswersLanding | null): Promise<DecisionAsk[]> {
    const log = await this.log().catch(() => null);
    if (!log) return [...asks];
    return asks.map((ask) => {
      if (ask.state !== "answered" || ask.scope) return ask;
      // The newest receipt for this ask at its own kind of home (its checkout's, by path), else any for its handle.
      const own = (receipt: AnsweredReceipt) =>
        ask.home.kind === "main"
          ? receipt.homeKind === "main"
          : receipt.homeKind === "checkout" && receipt.home.startsWith(`${ask.home.path.replace(/[\\/]+$/, "")}/`);
      let at = -1;
      let any = -1;
      log.answered.forEach((receipt, index) => {
        if (!sameAsk(ask, receipt)) return;
        any = index;
        if (own(receipt)) at = index;
      });
      if (at < 0) at = any;
      const receipt = log.answered[at];
      if (!receipt) return ask;
      return { ...ask, fate: this.fateOf(receipt, log, ask, landing) };
    });
  }

  private fateOf(receipt: AnsweredReceipt, log: Log, ask: DecisionAsk, landing: AnswersLanding | null): AnswerFate {
    const key = answerKey(receipt);
    const routed = log.routed.get(key);
    const blank = { route: null, pr: null, work: null, agentId: null };
    if (routed?.route === "conductor") {
      const closed = closedDecision(log, key);
      if (closed) {
        return {
          stage: "acted",
          words: closed.closed?.work
            ? `Acted on: you filed it as work, "${closed.closed.work.title}".`
            : closed.verb === "file"
              ? "Acted on: you filed it as work."
              : "Dismissed by you: nothing follows from it, and the conductor will not get it.",
          route: "conductor",
          pr: null,
          work: closed.closed?.work ?? null,
          agentId: routed.agentId,
        };
      }
      const pending = pendingDecision(log, key);
      return {
        stage: "conductor",
        words: fateWords(routed),
        route: "conductor",
        pr: null,
        work: null,
        agentId: routed.agentId,
        key,
        pending: pending ? { verb: pending.verb, receipt: pending.receipt, appliesAt: pending.appliesAt } : null,
      };
    }
    if (routed) {
      return {
        stage: routed.route === "superseded" ? "superseded" : "acted",
        words: fateWords(routed),
        route: routed.route,
        pr: null,
        work: routed.work,
        agentId: routed.agentId,
      };
    }
    if (ask.batched) {
      const pr = landing?.pr ?? null;
      const words =
        landing?.stage === "conflict"
          ? "Waits to land: maestro/answers conflicts with origin/main, and Needs you says where."
          : landing?.stage === "blocked"
            ? `Waits to land: Maestro stopped (${landing.error ?? "no reason given"}), and Needs you says why.`
            : landing?.stage === "failed"
              ? `Waits to land: the last landing step failed (${landing.error ?? "no reason given"}).`
              : pr
                ? `Waits to land: PR #${pr.number}.`
                : "Waits to land: Maestro opens its PR at its next check.";
      // Given before routing began: it lands like any other, and nothing acts on it after.
      const after = afterBegan(receipt, log.began)
        ? ""
        : " Answered before Maestro acted on answers, so nothing here acts on it once it lands.";
      return { ...blank, stage: "unlanded", words: `${words}${after}`, pr };
    }
    if (!afterBegan(receipt, log.began)) {
      return {
        ...blank,
        stage: "before",
        words: "Answered before Maestro acted on answers, so nothing here acted on it.",
      };
    }
    const waiting = this.waits.get(key);
    const where = receipt.homeKind === "main" ? "Landed on origin/main" : `Written in ${homeWords(ask.home)}`;
    // Not where it belongs yet (open where it lives now): its own words; else where it is, and why it still waits.
    const words =
      waiting?.status === "unlanded"
        ? waiting.words
        : waiting
          ? `${where}. ${waiting.words}`
          : `${where}; Maestro acts on it at its next check.`;
    return { ...blank, stage: "unrouted", words };
  }
}

/** A routed answer waiting for the conductor, as Decisions says it. */
export const FOR_THE_CONDUCTOR =
  "For the conductor: no session on its arc could take your answer, so it waits for the conductor to give it to a lane. Nothing was started.";

/** A routed answer, in a sentence. */
export function fateWords(routed: Pick<RoutedReceipt, "route" | "work" | "reason">): string {
  if (routed.route === "delivered") return "Acted on: sent to the session that asked.";
  if (routed.route === "relayed") return `Acted on: ${routed.reason}`;
  if (routed.route === "work")
    return `Acted on: filed as work, ${routed.work ? `"${routed.work.title}"` : "an item"}, for your gate.`;
  if (routed.route === "superseded") return `Not acted on. ${routed.reason}`;
  if (routed.route === "conductor") return FOR_THE_CONDUCTOR;
  return `Acted on: nothing to do. ${routed.reason}`;
}
