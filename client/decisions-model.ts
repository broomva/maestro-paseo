// Decisions, as the Fleet view lists them: each ledger's asks together, the
// ledgers with asks that wait on you first, the answered ones apart so they
// can stay folded. And the words for where an answer goes. Pure.

import type { AskNotice, DecisionAsk, DecisionOption } from "../shared/fleet";
import { ago, plural } from "./format";

export interface DecisionGroup {
  ledger: string;
  /** The ledger's arc, when it names one. */
  arc: string | null;
  /** Its open asks, those that wait on you first, then oldest first. */
  open: DecisionAsk[];
  /** Its answered asks among the latest answered of all (control-asks ANSWERED_SHOWN), newest first. */
  answered: DecisionAsk[];
  waiting: number;
}

/** Each ledger's asks: ledgers holding asks that wait on you first, then the most open, then by name. */
export function groupDecisions(asks: readonly DecisionAsk[]): DecisionGroup[] {
  const groups = new Map<string, DecisionGroup>();
  for (const ask of asks) {
    const group = groups.get(ask.ledger) ?? {
      ledger: ask.ledger,
      arc: ask.arc,
      open: [],
      answered: [],
      waiting: 0,
    };
    if (ask.state === "open") group.open.push(ask);
    else group.answered.push(ask);
    if (ask.waiting) group.waiting += 1;
    groups.set(ask.ledger, group);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.open.sort(
      (a, b) => Number(b.waiting) - Number(a.waiting) || (a.askedAt ?? "￿").localeCompare(b.askedAt ?? "￿"),
    );
    group.answered.sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""));
  }
  return list.sort(
    (a, b) =>
      Number(b.waiting > 0) - Number(a.waiting > 0) ||
      b.open.length - a.open.length ||
      a.ledger.localeCompare(b.ledger),
  );
}

/** A group's heading line: `3 open · 1 waits on you · 2 recently answered`. */
export function groupMeta(group: DecisionGroup): string {
  return [
    group.open.length > 0 ? `${group.open.length} open` : null,
    group.waiting > 0 ? `${group.waiting} ${group.waiting === 1 ? "waits" : "wait"} on you` : null,
    group.answered.length > 0 ? `${group.answered.length} recently answered` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Where your answer to an open ask is written, in words. */
export function homeText(ask: DecisionAsk): string {
  const { home } = ask;
  if (home.kind === "main") {
    return `Its home is origin/main: your answer goes to Maestro's answers worktree, committed on maestro/answers. Landing that batch on main is a step of its own, not built yet.`;
  }
  if (home.kind === "checkout") {
    const where = home.branch ? `${home.path}, on ${home.branch}` : home.path;
    return `Its home is the checkout ${where}, which has not landed it: your answer is written into ${ask.ledger} there, and goes with that branch.`;
  }
  return `Written into ${ask.ledger}.`;
}

/** An answered ask that waits in the answers batch, in words. */
export const BATCHED_TEXT = "In the answers batch on maestro/answers: not on origin/main until it lands.";

/** The Needs you line for decision asks that wait on you. */
export function askNoticeText(asks: readonly AskNotice[]): string {
  const [first] = asks;
  if (!first) return "";
  if (asks.length === 1) return `A decision waits on you: ${first.headline}`;
  const blocking = asks.filter((ask) => ask.blocking).length;
  return `${plural(asks.length, "decision")} wait on you${blocking > 0 ? `, ${blocking} blocking` : ""}: ${first.headline}, and more.`;
}

// ── The Decisions tab: one decision at a time ────────────────────────────────
// The queue the tab walks, the ledger rail beside it, the keys that drive it,
// and the words on its card. Pure, so each rule is tested.

/** How the queue is ordered. */
export const ORDERINGS = [
  { id: "blocking", label: "Blocking first" },
  { id: "oldest", label: "Oldest" },
  { id: "ledger", label: "By ledger" },
] as const;
export type Ordering = (typeof ORDERINGS)[number]["id"];

/** One ask, wherever it is read: its home, its ledger, its identity. */
export function askKey(ask: Pick<DecisionAsk, "home" | "ledger" | "uid" | "id">): string {
  const home = ask.home.kind === "main" ? "origin/main" : ask.home.path;
  return `${home}:${ask.ledger}:${ask.uid ?? ask.id}`;
}

/** A ledger's name as a person reads it: its file name without `.yaml`. */
export function ledgerName(ledger: string): string {
  return ledger.replace(/\.ya?ml$/, "");
}

/** An ask that is answered here: open, and not an idea (ideas are answered in Initiatives). */
export function isTriaged(ask: DecisionAsk): boolean {
  return ask.state === "open" && !ask.idea;
}

const NEVER = "￿";
const byAge = (a: DecisionAsk, b: DecisionAsk) => (a.askedAt ?? NEVER).localeCompare(b.askedAt ?? NEVER);
const byName = (a: DecisionAsk, b: DecisionAsk) => a.ledger.localeCompare(b.ledger) || a.id.localeCompare(b.id);

export interface LedgerEntry {
  ledger: string;
  /** Open asks in it, ideas aside. */
  open: number;
  /** Of those, how many wait on you (DecisionAsk.waiting): the only ledgers that get a warn dot. */
  waiting: number;
}

/** The rail: each ledger with an open ask, in the order groupDecisions puts them (those that wait on you first). */
export function ledgerRail(asks: readonly DecisionAsk[]): LedgerEntry[] {
  return groupDecisions(asks.filter(isTriaged))
    .filter((group) => group.open.length > 0)
    .map((group) => ({ ledger: group.ledger, open: group.open.length, waiting: group.waiting }));
}

/**
 * The asks the tab walks, in order: the open ones (ideas aside), of one ledger
 * or all. Blocking first puts blocking asks first, then the rest that wait on
 * you, then the oldest; Oldest goes by when each was asked; By ledger goes a
 * ledger at a time in the rail's order, each as groupDecisions orders it. Asks
 * you skipped go last, in the same order, so a skip never loses one.
 */
export function triageQueue(
  asks: readonly DecisionAsk[],
  options: { ordering: Ordering; ledger?: string | null; skipped?: ReadonlySet<string> },
): DecisionAsk[] {
  const { ordering, ledger = null, skipped = new Set<string>() } = options;
  const open = asks.filter((ask) => isTriaged(ask) && (ledger === null || ask.ledger === ledger));
  let ordered: DecisionAsk[];
  if (ordering === "ledger") {
    ordered = groupDecisions(open).flatMap((group) => group.open);
  } else if (ordering === "oldest") {
    ordered = [...open].sort((a, b) => byAge(a, b) || byName(a, b));
  } else {
    ordered = [...open].sort(
      (a, b) =>
        Number(b.blocking) - Number(a.blocking) || Number(b.waiting) - Number(a.waiting) || byAge(a, b) || byName(a, b),
    );
  }
  const later = (ask: DecisionAsk) => skipped.has(askKey(ask));
  return [...ordered.filter((ask) => !later(ask)), ...ordered.filter(later)];
}

/**
 * Where the tab stands in the queue: the ask it was on, wherever the queue now
 * puts it; else, that ask gone (answered, or answered elsewhere), the one now at
 * its old place, so the next decision comes up; else the last; -1 when empty.
 */
export function currentIndex(queue: readonly DecisionAsk[], key: string | null, lastIndex: number): number {
  if (queue.length === 0) return -1;
  if (key !== null) {
    const at = queue.findIndex((ask) => askKey(ask) === key);
    if (at >= 0) return at;
  }
  return Math.min(Math.max(lastIndex, 0), queue.length - 1);
}

/** The asks after the current one, up to `count`. */
export function upNext(queue: readonly DecisionAsk[], index: number, count = 3): DecisionAsk[] {
  return index < 0 ? [] : queue.slice(index + 1, index + 1 + count);
}

/** "Decision 3 of 12", and how far through, 0 to 1. */
export function progressOf(index: number, total: number): { text: string; fraction: number } {
  if (total <= 0 || index < 0) return { text: "No decisions open", fraction: 0 };
  return { text: `Decision ${index + 1} of ${total}`, fraction: (index + 1) / total };
}

/** A key the tab acts on. */
export type TriageKey =
  | { kind: "choose"; index: number }
  | { kind: "answer" }
  | { kind: "skip" }
  | { kind: "next" }
  | { kind: "previous" };

/**
 * What a key press does, on the web: 1–4 choose an option, Enter answers, S
 * skips, J and K go to the next and the previous. Nothing while you type (in
 * the note field or anywhere else), with a modifier held (the browser's and
 * the host's shortcuts stay theirs), or, for Enter, while a control has focus,
 * where Enter presses that control.
 */
export function triageKey(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  context: { typing: boolean; onControl: boolean; options: number },
): TriageKey | null {
  if (context.typing || event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key;
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    return index < Math.min(context.options, 4) ? { kind: "choose", index } : null;
  }
  if (key === "Enter") return context.onControl ? null : { kind: "answer" };
  const lower = key.toLowerCase();
  if (lower === "s") return { kind: "skip" };
  if (lower === "j") return { kind: "next" };
  if (lower === "k") return { kind: "previous" };
  return null;
}

/** The longest a headline taken from a question runs before it is cut at a word. */
export const HEADLINE_CHARS = 120;

/**
 * What the card leads with: the ask's own headline; else its question's first
 * sentence, cut at a word past HEADLINE_CHARS, the rest of the question behind
 * Full question. `rest` is null when the headline says all of it.
 */
export function headlineOf(ask: Pick<DecisionAsk, "headline" | "question" | "id">): {
  headline: string;
  rest: string | null;
  derived: boolean;
} {
  if (ask.headline) {
    return {
      headline: ask.headline,
      rest: ask.question && ask.question !== ask.headline ? ask.question : null,
      derived: false,
    };
  }
  const question = (ask.question ?? "").replace(/\s+/g, " ").trim();
  if (!question) return { headline: ask.id, rest: null, derived: true };
  const end = question.search(/[.?!](\s|$)/);
  const headline = cutAtWord(end >= 0 ? question.slice(0, end + 1) : question, HEADLINE_CHARS);
  return { headline, rest: headline === question ? null : (ask.question ?? question), derived: true };
}

/** Whether every option can be undone (true), any cannot (false), or the ledger does not say (null). */
export function reversibility(options: readonly DecisionOption[]): boolean | null {
  if (options.some((option) => option.reversible === false)) return false;
  if (options.length > 0 && options.every((option) => option.reversible === true)) return true;
  return null;
}

/** The card's muted first line: ledger · id, age, blocking or not, and whether it can be undone. */
export function metaLine(ask: DecisionAsk, now: number = Date.now()): string {
  const age = ask.askedAt ? ago(ask.askedAt, now) : "";
  const undo = reversibility(ask.options);
  return [
    `${ledgerName(ask.ledger)} · ${ask.id}`,
    age ? (age === "now" ? "asked just now" : `asked ${age} ago`) : null,
    ask.blocking ? "blocking" : "not blocking",
    undo === true ? "reversible" : undo === false ? "an option cannot be undone" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const plain = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The option the default names, by its id or its label, when it names exactly one. */
export function fallbackOption(ask: Pick<DecisionAsk, "fallback" | "options">): DecisionOption | null {
  if (!ask.fallback) return null;
  const said = ` ${plain(ask.fallback)} `;
  const named = ask.options.filter((option) =>
    [option.id, option.label].some((name) => plain(name).length > 0 && said.includes(` ${plain(name)} `)),
  );
  return named.length === 1 ? (named[0] ?? null) : null;
}

/**
 * "If you say nothing: …", and when the default names an option other than the
 * recommended one, that it is not the recommendation. A default that names no
 * option, or more than one, is said as written, nothing added.
 */
export function fallbackLine(ask: Pick<DecisionAsk, "fallback" | "options">): string | null {
  if (!ask.fallback) return null;
  const recommended = ask.options.find((option) => option.recommended) ?? null;
  const named = fallbackOption(ask);
  const differs = recommended && named && named.id !== recommended.id;
  return `If you say nothing: ${ask.fallback}${differs ? `. That is not the recommendation (${recommended.label}).` : ""}`;
}

/** The longest an option's label runs on the Answer button before it is cut. */
export const VERB_CHARS = 36;

/** Text cut at the last word that fits in `max` characters, with an ellipsis; as it was when it fits. */
export function cutAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const space = value.lastIndexOf(" ", max);
  return `${value.slice(0, space > max / 3 ? space : max).replace(/[,;:]$/, "")}…`;
}

/** The primary verb's words: "Answer with <option>", cut at a word; "Answer" with words alone; "Choose an option" before. */
export function answerVerb(option: Pick<DecisionOption, "label"> | null, hasOptions: boolean, note: string): string {
  if (option) return `Answer with ${cutAtWord(option.label, VERB_CHARS)}`;
  if (!hasOptions) return "Answer";
  return note.trim().length > 0 ? "Answer in your words" : "Choose an option";
}

/** An answered ask in words: the option chosen and when. */
export function answeredLine(ask: DecisionAsk, now: number = Date.now()): string {
  const option = ask.options.find((entry) => entry.id === ask.answerOption);
  const age = ask.answeredAt ? ago(ask.answeredAt, now) : "";
  const when = age ? (age === "now" ? " just now" : ` ${age} ago`) : "";
  return `Answered${when}: ${option ? `“${option.label}”` : "an answer"}`;
}

/** Where an answer is written, in one short line (the long account is homeText). */
export function writtenTo(ask: DecisionAsk): string {
  const { home } = ask;
  if (home.kind === "main") return "Written to Maestro's answers worktree, on maestro/answers";
  if (home.kind === "checkout") return `Written to ${home.path}${home.branch ? ` (${home.branch})` : ""}`;
  return home.path ? `Written to ${home.path}` : `Written into ${ask.ledger}`;
}

/** The answered asks the tab lists, newest first. */
export function recentlyAnswered(asks: readonly DecisionAsk[]): DecisionAsk[] {
  return asks
    .filter((ask) => ask.state !== "open" && !ask.idea)
    .sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""));
}
