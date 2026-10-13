// The Loops tab's pure model: which rows go where, how they sort, and the
// words on each. One row per loop: its intent (desired, owner, purpose)
// beside what is observed (presence, status, last and next run), and a badge
// per drift class. No React here, so every rule is tested.

import {
  DRIFT_WORDS,
  driftName,
  type LoopDrift,
  type LoopNotice,
  type LoopRow,
  type SubstrateKind,
} from "../shared/loops";
import { lastWords, nextWords } from "./timeline-model";

/** As often as the Timeline: Loops reads the same substrates. */
export const LOOPS_POLL_MS = 60_000;

export const KIND_WORDS: Record<SubstrateKind, string> = {
  launchd: "launchd",
  "paseo-schedule": "Paseo schedule",
  "paseo-heartbeat": "Paseo heartbeat",
  "maestro-loop": "Maestro",
  "gha-schedule": "GitHub Actions",
  "session-cron": "Session cron",
  p9: "p9",
};

export { DRIFT_WORDS };

/** A drift that needs you is a danger badge; one that is only shown (an sri row's, one the Timeline raises) is a warning. */
export const driftTone = (drift: Pick<LoopDrift, "needsYou">): "danger" | "warn" =>
  drift.needsYou ? "danger" : "warn";

/** The rows of a section, drifting first (needs-you before badges), then by name. */
export function sortRows(rows: readonly LoopRow[]): LoopRow[] {
  const weight = (row: LoopRow) => (row.drift.some((one) => one.needsYou) ? 0 : row.drift.length > 0 ? 1 : 2);
  return [...rows].sort((a, b) => weight(a) - weight(b) || (a.id ?? a.name).localeCompare(b.id ?? b.name));
}

/** The two sections: standing loops, and the session loops and watchers no row claims. */
export function sections(rows: readonly LoopRow[]): { loops: LoopRow[]; ephemeral: LoopRow[] } {
  return {
    loops: sortRows(rows.filter((row) => row.section === "loops")),
    ephemeral: sortRows(rows.filter((row) => row.section === "ephemeral")),
  };
}

/** What the intent says, in words: "Active · owner · broomva", "Paused since 2026-10-04 · owner", "No row". */
export function intentWords(row: LoopRow): string {
  if (row.id === null) return row.section === "ephemeral" ? "Ephemeral: no row needed" : "No ledger row";
  const since = row.intent?.desiredSince;
  const desired = row.desired
    ? `${row.desired[0]?.toUpperCase()}${row.desired.slice(1)}${since && row.desired !== "active" ? ` since ${since}` : ""}`
    : "Read-only (SRI)";
  return [desired, row.owner, row.scope === "broomva" ? null : row.scope].filter(Boolean).join(" · ");
}

/** What is observed, in words: "On · ok", "Off · paused", "Not found", "Not read". */
export function observedWords(row: LoopRow): string {
  if (row.unread) return "Not read this time";
  const observed = row.observed;
  if (!observed) return "Not found";
  const presence = observed.presence === "on" ? "On" : observed.presence === "off" ? "Off" : "Gone";
  return observed.status === "off" ? presence : `${presence} · ${observed.status}`;
}

/** The last and next run, as the Timeline says them. */
export function runWords(row: LoopRow, now: number): string {
  const observed = row.observed;
  if (!observed) return "";
  return [lastWords(observed, now), nextWords(observed, now)].filter(Boolean).join(" · ");
}

/** The tab's summary: how many loops, and how many drift. */
export function summary(rows: readonly LoopRow[]): string {
  const loops = rows.filter((row) => row.section === "loops");
  const needs = loops.filter((row) => row.drift.some((one) => one.needsYou)).length;
  const badges = loops.filter((row) => row.drift.length > 0).length;
  const head = `${loops.length} ${loops.length === 1 ? "loop" : "loops"}`;
  if (badges === 0) return `${head}, each as its row says.`;
  return `${head}; ${needs} ${needs === 1 ? "needs" : "need"} you, ${badges} drifting.`;
}

/** A row's screen-reader label: its name, intent, observation and drift. */
export function rowLabel(row: LoopRow): string {
  const drift = row.drift.map((one) => driftName(one.kind)).join(", ");
  return `${row.name}. ${intentWords(row)}. ${observedWords(row)}.${drift ? ` Drift: ${drift}.` : ""}`;
}

/** A notice's words for Needs you: "kg-lint: Paused but running. It is paused in the ledger, …". */
export function noticeWords(notice: Pick<LoopNotice, "loop" | "kind" | "detail">): string {
  return `${notice.loop}: ${DRIFT_WORDS[notice.kind]}. ${notice.detail}`;
}
