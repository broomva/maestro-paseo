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
//   - Gone, or none named: a work item, queued with gate human, briefed from
//     the ask and the answer, in the ask's initiative when it names one, and
//     filed once (Contract.answer). An answer that takes an option the ledger
//     marks `status_quo: true` needs none; nor does an idea's, whose develop
//     answer files its own (index.server.ts). Read from the ask's own keys,
//     never from the words of an option.
// Answers given before routing first ran (`routing.began`, by time, so the
// order its line and an answer's are appended in does not matter) are never
// routed: they were acted on by hand, or not, before Maestro could. An answer
// whose ask now records another outcome where it lives (main's wins, §5.2) is
// superseded: recorded, never acted on, its words kept in its receipt. A
// fleet scope's own asks are the fleet's to act on, and are never routed here.
// Routing never decides: the delivery is your answer verbatim, the work item
// waits at your gate, and how the loop starts it is the loop's own rule.

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type AnswerFate, type AnswersLanding, answersWord, type Route } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { isRow, text } from "./control-asks";
import { homeWords, type WorkspaceRead } from "./control-home";
import { type Engine, within } from "./engine";
import { LOOP } from "./events";
import { inspectFolder } from "./folders";
import type { Paseo } from "./runs";

/** The longest a route waits for a session to say how it is. */
export const SESSION_MS = 10_000;

/** How long an answer waits on a relay at work before the next one is asked, and at the end, work is filed. */
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
  const log: Log = { answered: [], routed: new Map(), began: null };
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
    } else if (row.kind === "ask.routed" && typeof row.key === "string") {
      if (!log.routed.has(row.key)) log.routed.set(row.key, row as unknown as RoutedReceipt);
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
 * An ask whose answer decides an act only you perform: `class: authority` or
 * `credential`, or a `why_you` that says owner-only. Its answer authorizes the
 * decision, never an agent doing the act (BRO-2910). Pure.
 */
export function ownerOnly(ask: DecisionAsk | null): boolean {
  const kind = ask?.audit?.class;
  return kind === "authority" || kind === "credential" || /owner[- ]only/i.test(ask?.whyYou ?? "");
}

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
  private readonly waits = new Map<
    string,
    { status: "unlanded" | "queued" | "failed"; words: string; on?: string | undefined }
  >();

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

  /**
   * Routes every answer that is due (the header above), one pass at a time;
   * `agentId` limits it to the answers that session asked, as when its turn
   * ends. Never throws: an answer that could not be routed waits for a later
   * pass, and says why.
   */
  route(only: { agentId?: string } = {}): Promise<RouteOutcome[]> {
    const next = this.running.catch(() => undefined).then(() => this.pass(only));
    this.running = next;
    return next;
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
          this.waits.get(answerKey(receipt))?.on === only.agentId,
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
          : await this.one(receipt, ask, agentId, read).catch((error) =>
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
    const relayed = await this.relay(paseo, receipt, ask, read, why);
    if (relayed) return relayed;
    const existing = (await this.options.engine.answered()).get(key);
    if (existing) {
      return this.routed(receipt, {
        route: "work",
        agentId,
        work: { id: existing.id, title: existing.title },
        reason: `${why} Filed as work before; that item stands.`,
      });
    }
    const { title, brief } = routedWork(receipt, ask, why);
    const item = await this.options.engine.create(
      paseo,
      {
        title,
        brief,
        repo: await this.repoFor(ask),
        gate: "human",
        check: "",
        initiative: ask?.initiative ?? "",
        dispatch: false,
        answer: key,
      },
      LOOP,
    );
    this.options.log?.(`answers: ${receipt.ledger} ${receipt.id}: ${why} Filed ${item.id}, queued, gate human`);
    return this.routed(receipt, {
      route: "work",
      agentId,
      work: { id: item.id, title: item.title },
      reason: `${why} Filed as work, queued, for your gate.`,
    });
  }

  /**
   * An answer its asker cannot take, sent to the first session that can: the
   * arc's other askers, newest first, then the initiative's driver. One at
   * work holds the answer until it is idle; one gone is passed over. Null when
   * none is left, and the answer is filed as work (BRO-2918).
   */
  private async relay(
    paseo: Paseo | null,
    receipt: AnsweredReceipt,
    ask: DecisionAsk,
    read: WorkspaceRead,
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
    // Waited RELAY_WAIT_MS on one at work: the next is asked instead, so an answer is never held by a busy one forever.
    const patient = !(this.now() - Date.parse(receipt.at ?? "") >= RELAY_WAIT_MS);
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
      if (session === "gone" || (session === "busy" && !patient)) continue;
      if (session === "busy") {
        return this.wait(receipt, "queued", `${why} It goes to ${relay.as} when that session is idle.`, relay.agentId);
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
    fields: Pick<RoutedReceipt, "route" | "agentId" | "work" | "reason">,
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

  /** `on`: the session the answer waits on, so that session's turn's end routes it. */
  private wait(
    receipt: AnsweredReceipt,
    status: "unlanded" | "queued" | "failed",
    words: string,
    on?: string,
  ): RouteOutcome {
    const key = answerKey(receipt);
    const said =
      status === "failed" ? `Maestro could not act on it yet (${words}); it tries again at its next check.` : words;
    this.waits.set(key, { status, words: said, on });
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
    if (!info) return { answered: [], routed: new Map(), began: null };
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

/** A routed answer, in a sentence. */
export function fateWords(routed: Pick<RoutedReceipt, "route" | "work" | "reason">): string {
  if (routed.route === "delivered") return "Acted on: sent to the session that asked.";
  if (routed.route === "relayed") return `Acted on: ${routed.reason}`;
  if (routed.route === "work")
    return `Acted on: filed as work, ${routed.work ? `"${routed.work.title}"` : "an item"}, for your gate.`;
  if (routed.route === "superseded") return `Not acted on. ${routed.reason}`;
  return `Acted on: nothing to do. ${routed.reason}`;
}
