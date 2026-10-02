// The Fleet view's words: a scope's health, its ticks, its proposals and your
// verdicts on them, and where the fleet's asks are in Maestro. No React here,
// so every rule is tested.

import type {
  ClassCount,
  FleetAsk,
  FleetHealthStatus,
  FleetNotice,
  FleetProposal,
  FleetReview,
  FleetScope,
  FleetTick,
  ProposalGroup,
  TickStatus,
} from "../shared/fleet";
import { PLAIN_VOICE } from "../shared/states";
import { ago, plural } from "./format";
import { dayKey, shortDay, timeText } from "./history-model";

export const HEALTH_LABEL: Record<FleetHealthStatus, string> = {
  ok: "On time",
  failing: "Failing",
  missed: "Missed",
  off: "Off",
  unscheduled: "Not scheduled",
};

/** How a health reads at a glance; color is always paired with its label. */
export function healthTone(status: FleetHealthStatus): "danger" | "warn" | "success" | "muted" {
  if (status === "failing" || status === "missed") return "danger";
  if (status === "off") return "warn";
  return status === "ok" ? "success" : "muted";
}

export const TICK_LABEL: Record<TickStatus, string> = {
  ok: "Passed",
  failed: "Failed",
  running: "Running",
  died: "Never finished",
  unknown: "No exit recorded",
};

export function tickTone(status: TickStatus): "danger" | "success" | "muted" | "accent" {
  if (status === "failed" || status === "died") return "danger";
  if (status === "running") return "accent";
  return status === "ok" ? "success" : "muted";
}

/** `report mode, dry run`, as the scope's config says. */
export function modeText(scope: Pick<FleetScope, "mode" | "dryRun">): string {
  const mode = scope.mode ? `${scope.mode} mode` : "mode unknown";
  const dry = scope.dryRun === null ? null : scope.dryRun ? "dry run" : "live";
  return dry ? `${mode}, ${dry}` : mode;
}

/** `53 out of scope · 1 error · 2 unmanaged`, in the class table's order. */
export function classText(counts: readonly ClassCount[] | null): string {
  if (!counts) return "No report";
  if (counts.length === 0) return "No sessions";
  return counts.map((count) => `${count.count} ${count.name}`).join(" · ");
}

/** How long ago, in words: "just now", "12m ago". */
export function agoText(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const age = ago(iso, now);
  return age === "now" ? "just now" : `${age} ago`;
}

/** When a tick started: local time today, else with its day ("Yesterday 23:05", "Tue 09:12"). */
export function tickWhen(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "time unknown";
  const day = dayKey(iso);
  if (day === dayKey(now)) return timeText(iso);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return `${day === dayKey(yesterday.getTime()) ? "Yesterday" : shortDay(day, now)} ${timeText(iso)}`;
}

/** One tick's line: its number, its status and when, for a screen reader too. */
export function tickLabel(tick: FleetTick, now: number = Date.now()): string {
  const step = tick.failedStep ? ` at ${tick.failedStep}` : "";
  return `Tick ${tick.tick}, ${TICK_LABEL[tick.status].toLowerCase()}${step}, ${agoText(tick.at, now) ?? "time unknown"}`;
}

/** Where a proposal stands with you, in words. */
export function reviewText(review: FleetReview | null, now: number = Date.now()): string {
  if (!review) return "Not reviewed";
  const at = agoText(review.at, now);
  const verb = review.verdict === "accept" ? "You accepted this" : "You rejected this";
  return review.note ? `${verb} ${at}: ${review.note}` : `${verb} ${at}`;
}

/** What a proposal is about: the session, or the coordinator's verb. */
export function proposalSubject(proposal: FleetProposal): string {
  if (proposal.session) {
    const name = proposal.session.name ? ` ${proposal.session.name}` : "";
    return `${proposal.session.short}${name}`;
  }
  return proposal.verb ? `Coordinator ${proposal.verb}` : proposal.key;
}

export function proposalClass(proposal: FleetProposal): string | null {
  if (!proposal.classId) return null;
  return proposal.className ? `Class ${proposal.classId}, ${proposal.className}` : `Class ${proposal.classId}`;
}

/** Where an ask is in Maestro: the work the fleet raised for its batch, or why there is none yet. */
export function askWhere(ask: FleetAsk): string {
  const item = ask.item;
  if (!item) {
    return ask.batch
      ? "Its batch has no Maestro work yet: the fleet raises it at a later tick."
      : "Not raised yet: the fleet raises an ask once it lasts.";
  }
  if (item.needsYou) return "In Needs you";
  return `In Maestro, ${PLAIN_VOICE[item.state].label}`;
}

export function askMeta(ask: FleetAsk): string {
  const parts = [ask.class, ask.firstTick !== null ? `since tick ${ask.firstTick}` : null].filter(Boolean);
  return parts.join(" · ");
}

/** The scope chip's words for a screen reader: its name, its health and what waits on you. */
export function scopeChipLabel(scope: FleetScope): string {
  const parts = [scope.id, HEALTH_LABEL[scope.health.status]];
  if (scope.unreviewed > 0) parts.push(`${plural(scope.unreviewed, "proposal")} to review`);
  if (scope.openAsks > 0) parts.push(`${plural(scope.openAsks, "open ask")}`);
  return parts.join(", ");
}

/** The last tick in words: `tick 35, 12m ago`. */
export function lastTickText(scope: FleetScope, now: number = Date.now()): string {
  const last = scope.lastTick;
  if (!last) return "No tick yet";
  const when = agoText(last.at, now);
  return `Tick ${last.tick}${when ? `, ${when}` : ""}`;
}

/** The Would do heading's count: the groups, and how many still wait on you. */
export function proposalsHeading(groups: readonly ProposalGroup[]): string {
  const open = groups.filter((group) => group.review === null).length;
  return open > 0 ? `${groups.length} · ${open} to review` : `${groups.length} · all reviewed`;
}

/** Where a group stands with you: every proposal in it stands the same (shared/fleet.ts groupProposals). */
export function groupReviewText(group: ProposalGroup, now: number = Date.now()): string {
  return reviewText(group.review, now);
}

/** What a group is about: its one session or verb, or how many sessions. */
export function groupSubject(group: ProposalGroup): string {
  const [first] = group.proposals;
  if (group.proposals.length === 1 && first) return proposalSubject(first);
  return plural(group.proposals.length, "session");
}

/** The keys a verdict writes: the group's, unless they all have it already (then none, and no lines are added). */
export function keysFor(group: ProposalGroup, verdict: FleetReview["verdict"]): string[] {
  return group.review?.verdict === verdict ? [] : group.proposals.map((proposal) => proposal.key);
}

/** A fleet notice as the header area says it: the scope, what is wrong, for how long, and why. */
export function noticeText(notice: FleetNotice, now: number = Date.now()): string {
  const what = notice.status === "missed" ? "missed tick" : "failing tick";
  const since = notice.since ? ago(notice.since, now) : "";
  const span = since && since !== "now" ? ` for ${since}` : "";
  return `Fleet ${notice.scope}: ${what}${span}. ${notice.reason}`;
}
