// How the records agents write read on Maestro's surfaces: a title without
// the fleet's marker, a meta line in words, and receipts that say a repeat
// once. Pure, so every surface shows the same words.

import type { WorkItem } from "../shared/contracts";
import { type FleetOrigin, fleetMarker, fleetMeta, withoutMarker } from "../shared/fleet-item";
import type { HistoryEvent } from "../shared/records";
import { basename } from "./format";

/**
 * The title a person reads: the daemon's display title, else the raw one
 * without a fleet marker. Every surface that shows a work title uses this;
 * client/fleet.tsx (the Fleet cockpit, maestro-paseo#25) switches to it at its rebase.
 */
export function titleText(item: Pick<WorkItem, "title" | "display">): string {
  return item.display?.title || withoutMarker(item.title);
}

/**
 * The line above a card's title: where fleet work came from (`fleet · sri`;
 * the tick is the detail's own line), else the initiative and project or repo (`holon · broomva`).
 */
export function placeText(
  item: Pick<WorkItem, "title" | "display" | "initiative" | "project" | "repo">,
): string | null {
  const fleet = fleetOriginOf(item);
  if (fleet) return fleetMeta(fleet);
  const leaf = item.project ?? basename(item.repo);
  const parts = [item.initiative, leaf === item.initiative ? null : leaf].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Where fleet work came from: the daemon's word, else read from the title's marker; null for other work. */
export function fleetOriginOf(item: Pick<WorkItem, "title" | "display">): FleetOrigin | null {
  return item.display?.fleet ?? originOf(item.title);
}

/** A fleet origin read from the title alone: the tick is the batch id's first number when it has one. */
function originOf(title: string): FleetOrigin | null {
  const mark = fleetMarker(title);
  if (!mark) return null;
  return { scope: mark.scope, what: mark.what, tick: /^batch\s+(\d+)-\d+$/i.exec(mark.what)?.[1] ?? null };
}

/** A History receipt's work title, as a person reads it. */
export function eventTitle(event: Pick<HistoryEvent, "title" | "heading">): string {
  return event.heading || withoutMarker(event.title);
}

/** A History receipt's place: the fleet's words for fleet work, else null (the caller's crumb stands). */
export function eventFleetPlace(event: Pick<HistoryEvent, "title">): string | null {
  const origin = originOf(event.title);
  return origin ? fleetMeta(origin) : null;
}

/** One receipt shown, how many identical ones in a row it stands for, and the oldest of them. */
export interface Collapsed<T> {
  event: T;
  count: number;
  /** The last of the run in list order: in a newest-first list, the oldest. Equal to `event` when count is 1. */
  last: T;
}

type Receipt = { ts: string; type: string; text: string; detail: string | null; actor: string; itemId?: string };

/**
 * Receipts with each run of identical neighbours (same kind, words, detail,
 * actor and work) said once, with its count. Order is kept; the first of a
 * run stands for it, so in a newest-first list that is the newest.
 */
export function collapseRepeats<T extends Receipt>(events: readonly T[]): Collapsed<T>[] {
  const out: Collapsed<T>[] = [];
  for (const event of events) {
    const run = out[out.length - 1];
    const prev = run?.event;
    if (
      run &&
      prev &&
      prev.type === event.type &&
      prev.text === event.text &&
      (prev.detail ?? null) === (event.detail ?? null) &&
      prev.actor === event.actor &&
      prev.itemId === event.itemId
    ) {
      run.count += 1;
      run.last = event;
    } else {
      out.push({ event, count: 1, last: event });
    }
  }
  return out;
}

/**
 * Beside a receipt that stands for several: "×3 · 3h–1h", the count and the
 * ages of the oldest and newest ("×3 · 1h" when both read the same). Empty
 * for one. `when` is the age formatter (format.ts ago), passed in so this stays pure.
 */
export function repeatText<T extends { ts: string }>(run: Collapsed<T>, when: (ts: string) => string): string {
  if (run.count < 2) return "";
  const newest = when(run.event.ts);
  const oldest = when(run.last.ts);
  return `\u00d7${run.count} · ${oldest === newest ? newest : `${oldest}\u2013${newest}`}`;
}

/** What a screen reader hears for the count: "3 times in a row, from 3h to 1h ago". */
export function repeatWords<T extends { ts: string }>(run: Collapsed<T>, when: (ts: string) => string): string {
  if (run.count < 2) return "";
  const newest = when(run.event.ts);
  const oldest = when(run.last.ts);
  return `${run.count} times in a row, ${oldest === newest ? newest : `from ${oldest} to ${newest}`}`;
}
