// Decisions, as the Fleet view lists them: each ledger's asks together, the
// ledgers with asks that wait on you first, the answered ones apart so they
// can stay folded. And the words for where an answer goes. Pure.

import { type AskNotice, type DecisionAsk, type DecisionOption, homeKey } from "../shared/fleet";
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

/**
 * One ask's full identity, as an answer names it: its home, its ledger, its
 * uid and its id (sameAsk's fields). Two asks with one key are one ask.
 */
export function askKey(ask: Pick<DecisionAsk, "home" | "ledger" | "uid" | "id">): string {
  return JSON.stringify([homeKey(ask.home), ask.ledger, ask.uid, ask.id]);
}

/** Whether two reads name the same ask at the same home. */
export function sameAsk(
  a: Pick<DecisionAsk, "home" | "ledger" | "uid" | "id">,
  b: Pick<DecisionAsk, "home" | "ledger" | "uid" | "id">,
): boolean {
  return askKey(a) === askKey(b);
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

/** The rail's folded ledgers in one line: how many, how many open, and how many of those wait on you. */
export function railOverflow(hidden: readonly LedgerEntry[]): string {
  const open = hidden.reduce((sum, entry) => sum + entry.open, 0);
  const waiting = hidden.reduce((sum, entry) => sum + entry.waiting, 0);
  return [
    `+ ${hidden.length} more`,
    `${open} open`,
    waiting > 0 ? `${waiting} ${waiting === 1 ? "waits" : "wait"} on you` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The longest a ledger's name runs in the rail. */
export const RAIL_CHARS = 24;

/** A ledger's name for the rail: cut at a word (a hyphen or a space) with an ellipsis, never mid-word. */
export function railName(ledger: string, max = RAIL_CHARS): string {
  const name = ledgerName(ledger);
  if (name.length <= max) return name;
  const cut = Math.max(name.lastIndexOf("-", max - 1), name.lastIndexOf(" ", max - 1));
  return `${name.slice(0, cut > max / 3 ? cut : max - 1)}…`;
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

/** The skipped set without asks no longer open; the same set when nothing left. */
export function pruneSkipped(skipped: ReadonlySet<string>, open: readonly DecisionAsk[]): ReadonlySet<string> {
  const keys = new Set(open.map(askKey));
  const kept = [...skipped].filter((key) => keys.has(key));
  return kept.length === skipped.size ? skipped : new Set(kept);
}

/**
 * The ask to show once the one on screen is left (answered, skipped, or gone):
 * the first of the queue at or after where it stood, the one on screen
 * excluded; else the one before; null when nothing else is open.
 */
export function nextAfter(queue: readonly DecisionAsk[], leaving: string | null, at: number): DecisionAsk | null {
  const rest = queue.filter((ask) => askKey(ask) !== leaving);
  if (rest.length === 0) return null;
  return rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null;
}

/** The asks after the current one, up to `count`. */
export function upNext(queue: readonly DecisionAsk[], index: number, count = 3): DecisionAsk[] {
  return queue.slice(index + 1, index + 1 + count);
}

/**
 * What a focus names: a ledger, an id, and the uid and home when it knows
 * them. The one open ask that matches every field it gives; null when none
 * does, or more than one (then nothing is guessed).
 */
export function matchFocus(
  queue: readonly DecisionAsk[],
  want: { ledger: string | null; id: string; uid?: string | null; home?: string | null },
): DecisionAsk | null {
  const found = queue.filter(
    (ask) =>
      ask.id === want.id &&
      (want.ledger == null || ask.ledger === want.ledger) &&
      (want.uid == null || ask.uid === want.uid) &&
      (want.home == null || homeKey(ask.home) === want.home),
  );
  return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * A focus resolved: the one ask it names; with only a ledger and an id that
 * two homes share, the one that waits on you, else the first with a note
 * saying there are more; null with no match.
 */
export function resolveFocus(
  queue: readonly DecisionAsk[],
  want: { ledger: string | null; id: string; uid?: string | null; home?: string | null },
): { ask: DecisionAsk; note: string | null } | null {
  const found = queue.filter(
    (ask) =>
      ask.id === want.id &&
      (want.ledger == null || ask.ledger === want.ledger) &&
      (want.uid == null || ask.uid === want.uid) &&
      (want.home == null || homeKey(ask.home) === want.home),
  );
  const [first] = found;
  if (!first) return null;
  if (found.length === 1) return { ask: first, note: null };
  const waiting = found.filter((ask) => ask.waiting);
  const [only] = waiting;
  if (only && waiting.length === 1) return { ask: only, note: null };
  const pick = waiting[0] ?? first;
  return {
    ask: pick,
    note: `${found.length} asks are named ${want.id} in ${ledgerName(pick.ledger)}: this is the one ${writtenTo(pick)
      .replace(/^Written to /, "at ")
      .replace(/^Written into /, "in ")}.`,
  };
}

/**
 * "Decision N of M": M is every ask this visit has had in its queue, N the
 * ones answered (here or elsewhere) plus the one on screen when it is still
 * open (a card answered elsewhere is already among the answered). The bar is
 * answered / M: a skip is not done, and is counted apart.
 */
export function progressOf(answered: number, total: number, currentOpen = true): { text: string; fraction: number } {
  if (total <= 0) return { text: "No decisions open", fraction: 0 };
  const done = Math.min(Math.max(answered, 0), total);
  const at = Math.min(Math.max(done + (currentOpen ? 1 : 0), 1), total);
  return { text: `Decision ${at} of ${total}`, fraction: done / total };
}

/** A key the tab acts on. */
export type TriageKey =
  | { kind: "choose"; index: number }
  | { kind: "cancel" }
  | { kind: "answer" }
  | { kind: "skip" }
  | { kind: "next" }
  | { kind: "previous" };

/**
 * What a key press does, on the web: 1–4 choose an option, Enter answers, S
 * skips (only where Skip is offered), J and K go to the next and the previous,
 * Escape cancels a confirm. On a focused option card, Enter and Space select
 * that option and never answer. Nothing while you type (in the note field or
 * anywhere else; Escape aside), with a modifier held (the browser's and the
 * host's shortcuts stay theirs), or, for Enter, while another control has
 * focus, where Enter presses that control.
 */
export function triageKey(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  context: {
    typing: boolean;
    onControl: boolean;
    options: number;
    canSkip?: boolean;
    /** The option card that has focus, by its place: Enter or Space selects it, and never answers. */
    onOption?: number | null;
  },
): TriageKey | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key;
  if (key === "Escape") return { kind: "cancel" };
  if (context.typing) return null;
  if (context.onOption != null && (key === "Enter" || key === " " || key === "Spacebar")) {
    return { kind: "choose", index: context.onOption };
  }
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    return index < Math.min(context.options, 4) ? { kind: "choose", index } : null;
  }
  if (key === "Enter") return context.onControl ? null : { kind: "answer" };
  const lower = key.toLowerCase();
  if (lower === "s") return context.canSkip === false ? null : { kind: "skip" };
  if (lower === "j") return { kind: "next" };
  if (lower === "k") return { kind: "previous" };
  return null;
}

/** The longest a headline taken from a question runs before it is cut at a word. */
export const HEADLINE_CHARS = 120;

/** Text cut at the last word that fits in `max` characters, with an ellipsis; as it was when it fits. */
export function cutAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const space = value.lastIndexOf(" ", max);
  return `${value.slice(0, space > max / 3 ? space : max).replace(/[,;:]$/, "")}…`;
}

/**
 * What the card leads with: the ask's own headline; else its question's first
 * sentence, cut at a word past HEADLINE_CHARS. `rest` is what the headline
 * leaves out of a question it was taken from (behind Full question): the
 * sentences after it, or, for a sentence cut short, the rest of that sentence
 * on. Null when the headline is the whole question, or is the ask's own.
 */
export function headlineOf(ask: Pick<DecisionAsk, "headline" | "question" | "id">): {
  headline: string;
  rest: string | null;
  derived: boolean;
} {
  if (ask.headline) return { headline: ask.headline, rest: null, derived: false };
  const question = (ask.question ?? "").replace(/\s+/g, " ").trim();
  if (!question) return { headline: ask.id, rest: null, derived: true };
  const end = question.search(/[.?!](\s|$)/);
  const sentence = end >= 0 ? question.slice(0, end + 1) : question;
  const headline = cutAtWord(sentence, HEADLINE_CHARS);
  if (headline !== sentence) {
    // Where the cut fell in the question (cutAtWord may have dropped a trailing comma): the rest starts at the next word.
    const shown = headline.slice(0, -1).length;
    return { headline, rest: `…${question.slice(shown).replace(/^[\s,;:.]+/, "")}`, derived: true };
  }
  const rest = question.slice(sentence.length).trim();
  return { headline, rest: rest.length > 0 ? rest : null, derived: true };
}

/** Whether every option can be undone (true), any cannot (false), or the ledger does not say (null). */
export function reversibility(options: readonly DecisionOption[]): boolean | null {
  if (options.some((option) => option.reversible === false)) return false;
  if (options.length > 0 && options.every((option) => option.reversible === true)) return true;
  return null;
}

/** The card's muted first line: the ledger, age, blocking or not, and whether it can be undone (the id is in Details). */
export function metaLine(ask: DecisionAsk, now: number = Date.now()): string {
  const age = ask.askedAt ? ago(ask.askedAt, now) : "";
  const undo = reversibility(ask.options);
  return [
    ledgerName(ask.ledger),
    age ? (age === "now" ? "asked just now" : `asked ${age} ago`) : null,
    ask.blocking ? "blocking" : "not blocking",
    undo === true ? "reversible" : undo === false ? "an option cannot be undone" : "undo: not stated",
  ]
    .filter(Boolean)
    .join(" · ");
}

const plain = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Shorter names than this match a default only whole, never as its first word. */
const NAME_PREFIX_CHARS = 4;

/** Words that carry no meaning of their own when an option is compared with a default. */
const STOP_WORDS = new Set(
  "a an the them it its this that these those their there to of and or for on in with as at by be is are was me my you your our we us so now all any".split(
    " ",
  ),
);

/** A text's content words: lowercase, punctuation gone, stop words dropped. */
export function contentWords(value: string): string[] {
  return plain(value)
    .split(" ")
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

/** How many of a label's content words the given words say, as a share of the label's. */
function overlap(label: string, words: readonly string[]): number {
  const own = contentWords(label);
  if (own.length === 0) return 0;
  return own.filter((word) => words.includes(word)).length / own.length;
}

/** Labels that keep going as things are: a default is often one of these in other words, so it is never said to be none. */
const CARRY_ON = /^(carry on|continue|proceed|keep|leave|stay|ship|wait|hold|defer|do nothing|skip)\b/;

/**
 * The option the default names: the default is an option's id or label, or
 * begins with one (four characters or more, as a whole word); else its
 * leading clause says at least two thirds of one label's content words (two
 * at least): "leave the PRs open with…" is "Leave them open". Only when it
 * names exactly one; a short id inside a sentence is never a match.
 */
export function fallbackOption(ask: Pick<DecisionAsk, "fallback" | "options">): DecisionOption | null {
  if (!ask.fallback) return null;
  const said = plain(ask.fallback);
  const named = ask.options.filter((option) =>
    [option.id, option.label].some((raw) => {
      const name = plain(raw);
      if (!name) return false;
      return said === name || (name.length >= NAME_PREFIX_CHARS && said.startsWith(`${name} `));
    }),
  );
  if (named.length === 1) return named[0] ?? null;
  if (named.length > 1) return null;
  const clause = contentWords(ask.fallback.split(/[;,—–(]/)[0] ?? "");
  const close = ask.options.filter(
    (option) => contentWords(option.label).length >= 2 && overlap(option.label, clause) >= 2 / 3,
  );
  return close.length === 1 ? (close[0] ?? null) : null;
}

/**
 * Whether the default is surely none of the options: no option shares half
 * its content words with it, and no option is a way of carrying on (which a
 * default often is, in other words). When unsure, nothing is claimed.
 */
function surelyNoOption(ask: Pick<DecisionAsk, "fallback" | "options">): boolean {
  if (!ask.fallback || ask.options.length === 0) return false;
  const words = contentWords(ask.fallback);
  return ask.options.every((option) => overlap(option.label, words) < 1 / 2 && !CARRY_ON.test(plain(option.label)));
}

/**
 * What happens if you say nothing, on its own row. A default that names an
 * option says that option's label, and whether it is the recommendation; one
 * that surely names none says the ledger's words and that they are not one of
 * the options; otherwise the ledger's words, with no claim. `words` is the
 * ledger's own wording when it says more than the option's label.
 */
export function silenceOf(ask: Pick<DecisionAsk, "fallback" | "options">): {
  text: string;
  tag: "same" | "differs" | null;
  words: string | null;
} | null {
  if (!ask.fallback) return null;
  const named = fallbackOption(ask);
  if (!named) {
    const outside = surelyNoOption(ask) ? " (not one of the options above)" : "";
    return { text: `If you say nothing: ${ask.fallback}${outside}`, tag: null, words: null };
  }
  const recommended = ask.options.find((option) => option.recommended) ?? null;
  const tag = recommended ? (recommended.id === named.id ? "same" : "differs") : null;
  const extra = plain(ask.fallback) !== plain(named.label) && plain(ask.fallback) !== plain(named.id);
  return { text: `If you say nothing: ${named.label}`, tag, words: extra ? ask.fallback : null };
}

/** The silence tag's words. */
export const SILENCE_TAG = { same: "same as recommended", differs: "differs from the recommendation" } as const;

/** The longest an option's label runs on the Answer button before it is cut. */
export const VERB_CHARS = 36;

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

/** A folder's last part, for a short home. */
const lastPart = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Where an answer is written, short (no machine paths): the answers batch, a checkout and its branch, or a root's folder. */
export function writtenTo(ask: DecisionAsk): string {
  const { home } = ask;
  if (home.kind === "main") return "Written to Maestro's answers batch, on maestro/answers";
  if (home.kind === "checkout")
    return `Written to the checkout ${lastPart(home.path)}${home.branch ? ` (${home.branch})` : ""}`;
  return home.path ? `Written to ${lastPart(home.path)}` : `Written into ${ask.ledger}`;
}

/** The answered asks the tab lists, newest first. */
export function recentlyAnswered(asks: readonly DecisionAsk[]): DecisionAsk[] {
  return asks
    .filter((ask) => ask.state !== "open" && !ask.idea)
    .sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""));
}

/** Lines with a key each, unique even when two lines read the same (the second is `line#2`). */
export function keyedLines(lines: readonly string[]): { key: string; line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    return { key: count === 1 ? line : `${line}#${count}`, line };
  });
}

/** What an ask answered elsewhere was answered with: its option's label, else its words, cut short. */
export function answeredElsewhere(ask: DecisionAsk): string {
  const option = ask.options.find((entry) => entry.id === ask.answerOption);
  const said = option
    ? `“${option.label}”`
    : ask.answer
      ? `“${cutAtWord(ask.answer.replace(/\s+/g, " "), 160)}”`
      : null;
  return said
    ? `This was answered elsewhere: ${said}. Nothing was sent from here.`
    : "This was answered elsewhere: its answer is in the ledger now. Nothing was sent from here.";
}
