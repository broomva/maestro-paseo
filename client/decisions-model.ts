// Decisions, as the Fleet view lists them: each ledger's asks together, the
// ledgers with asks that wait on you first, the answered ones apart so they
// can stay folded. And the words for where an answer goes. Pure.

import type { AskNotice, DecisionAsk } from "../shared/fleet";
import { plural } from "./format";

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
