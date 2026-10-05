// The Initiatives tab's pure model: the words on an initiative's card, its
// dates and badge, where each link goes, an idea's default wake date, and the
// notice for initiatives that need you. No React here, so every rule is tested.

import type { DecisionAsk } from "../shared/fleet";
import type { Initiative, InitiativeNotice, InitiativeStatus, WaitingOn } from "../shared/initiatives";

export const STATUS_TEXT: Record<InitiativeStatus, string> = {
  active: "Active",
  blocked_on_owner: "Waits on you",
  parked: "Parked",
  done: "Done",
  killed: "Killed",
};

/** What the file says when the owner's words were never written down, as the card shows it. */
export const INTENT_NOT_STATED =
  "Intent not stated: the owner's words were not written down where they could be found.";

/** A YYYY-MM-DD date. */
export const isDay = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** A day `count` days after `day` (YYYY-MM-DD, by the calendar, not by a clock). */
export function addDays(day: string, count: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + count);
  return at.toISOString().slice(0, 10);
}

/** The card's date line, and its badge when the date has passed: what makes the initiative need you. */
export function dateLine(initiative: Initiative, today: string): { text: string; badge: string | null } {
  if (initiative.status === "done" || initiative.status === "killed") {
    return { text: initiative.closedAt ? `Closed ${initiative.closedAt}` : "Closed", badge: null };
  }
  if (initiative.status === "parked") {
    const wake = initiative.wake ?? "no wake date";
    return {
      text: `Wakes ${wake}`,
      badge: initiative.stale?.kind === "wake" ? (wake === today ? "Wakes today" : "Wake date passed") : null,
    };
  }
  const reviewBy = initiative.reviewBy ?? "no date";
  return { text: `Review by ${reviewBy}`, badge: initiative.stale?.kind === "overdue" ? "Overdue" : null };
}

/** Who drives it, in words. */
export function driverText(driver: string | null): string {
  if (!driver || driver === "none") return "No driver";
  if (driver === "owner") return "Driven by you";
  if (driver === "fleet") return "Driven by the fleet";
  const [kind, id] = driver.split(":");
  if (kind === "coordinator") return `Driven by the coordinator ${id}`;
  if (kind === "session") return `Driven by the session ${id}`;
  return `Driven by ${driver}`;
}

/** One thing it waits on, in words: the ask it names, an owner step, a PR. */
export function waitingText(entry: WaitingOn): string {
  const note = entry.note ? ` (${entry.note})` : "";
  if (entry.kind === "ask") {
    const which = entry.ledger ? `${entry.ledger}${entry.askId ? ` ${entry.askId}` : ""}` : entry.ref;
    return `Your answer to ${which}${note}`;
  }
  if (entry.kind === "owner-step") return `Your step: ${entry.ref}${note}`;
  if (entry.kind === "pr") return `The PR ${entry.ref}${note}`;
  return `${entry.kind}: ${entry.ref}${note}`;
}

export function linearUrl(id: string): string {
  return `https://linear.app/broomva/issue/${id}`;
}

/** The evidence an idea links, as a URL when it is one Maestro can open. */
export function evidenceUrl(evidence: string | null): string | null {
  if (!evidence) return null;
  if (/^https?:\/\//.test(evidence)) return evidence;
  if (/^BRO-\d+$/.test(evidence)) return linearUrl(evidence);
  const pr = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(evidence);
  return pr ? `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}` : null;
}

export function ideasText(ideas: Initiative["ideas"]): string {
  const total = ideas.open + ideas.triaged;
  if (total === 0) return "No ideas filed";
  return `${total} ${total === 1 ? "idea" : "ideas"}: ${ideas.open} open, ${ideas.triaged} triaged`;
}

/** What a park answer proposes: the idea's own wake date, or 30 days from today once that has passed. */
export function defaultWake(wake: string | null, today: string): string {
  return wake && wake >= today ? wake : addDays(today, 30);
}

/** Why a wake typed for a park cannot be sent, or null. */
export function wakeProblem(wake: string, today: string): string | null {
  if (!isDay(wake)) return "Write the date as YYYY-MM-DD.";
  if (today && wake < today) return "Choose today or a later day.";
  return null;
}

/** The facts under an idea's headline: where it came from and where to read more. */
export function ideaMeta(ask: DecisionAsk): string {
  const idea = ask.idea;
  return [
    idea?.initiative ?? null,
    idea?.source ? `from ${idea.source.kind} ${idea.source.ref}` : null,
    idea?.evidence ? `evidence ${idea.evidence}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** An answered idea, in words. */
export function ideaOutcome(ask: DecisionAsk): string {
  const when = ask.answeredAt ? ` on ${ask.answeredAt.slice(0, 10)}` : "";
  switch (ask.answerOption) {
    case "develop":
      return `Developed${when}: a work item was filed for it, held for you to start.`;
    case "park":
      return `Parked${when} until ${ask.idea?.wake ?? "its wake date"}.`;
    case "kill":
      return `Killed${when}.`;
    default:
      return ask.state === "archived" ? `Retired${when}.` : `Answered${when}.`;
  }
}

/** The tab's facts line. */
export function initiativesMeta(list: readonly Initiative[], ideas: readonly DecisionAsk[]): string {
  const stale = list.filter((initiative) => initiative.stale).length;
  const broken = list.filter((initiative) => initiative.error).length;
  const open = ideas.filter((ask) => ask.state === "open").length;
  return [
    `${list.length} ${list.length === 1 ? "initiative" : "initiatives"}`,
    stale > 0 ? `${stale} ${stale === 1 ? "needs" : "need"} you` : null,
    broken > 0 ? `${broken} cannot be read` : null,
    `${open} open ${open === 1 ? "idea" : "ideas"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The notice above the other views, for initiatives past their date. */
export function initiativeNoticeText(notices: readonly InitiativeNotice[]): string {
  const [first] = notices;
  if (!first) return "";
  const what = first.kind === "overdue" ? `was due for review on ${first.date}` : `was parked until ${first.date}`;
  if (notices.length === 1) return `The initiative ${first.title} ${what}.`;
  return `${notices.length} initiatives need a look: ${first.title} ${what}, and ${notices.length - 1} more.`;
}

/** The ideas for one initiative, open first. */
export function ideasOf(ideas: readonly DecisionAsk[], initiative: string): DecisionAsk[] {
  return ideas.filter((ask) => ask.idea?.initiative === initiative);
}
