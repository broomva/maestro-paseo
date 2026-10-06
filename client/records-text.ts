// How the records agents write read on Maestro's surfaces: a title without
// the fleet's marker, a meta line in words, and receipts that say a repeat
// once. Pure, so every surface shows the same words.

import type { WorkItem } from "../shared/contracts";
import { fleetMarker, fleetMeta, withoutMarker } from "../shared/fleet-item";
import type { HistoryEvent } from "../shared/records";
import { basename } from "./format";

/** The title a person reads: the daemon's display title, else the raw one without a fleet marker. */
export function titleText(item: Pick<WorkItem, "title" | "display">): string {
  return item.display?.title || withoutMarker(item.title);
}

/**
 * The line above a card's title: where fleet work came from (`fleet · sri ·
 * tick 7`), else the initiative and project or repo (`holon · broomva`).
 */
export function placeText(
  item: Pick<WorkItem, "title" | "display" | "initiative" | "project" | "repo">,
): string | null {
  const fleet = item.display?.fleet ?? originOf(item.title);
  if (fleet) return fleetMeta(fleet);
  const leaf = item.project ?? basename(item.repo);
  const parts = [item.initiative, leaf === item.initiative ? null : leaf].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A fleet origin read from the title alone: the tick is the batch id's first number when it has one. */
function originOf(title: string) {
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

/** One receipt shown, and how many identical ones in a row it stands for. */
export interface Collapsed<T> {
  event: T;
  count: number;
}

type Receipt = { type: string; text: string; detail: string | null; itemId?: string };

/**
 * Receipts with each run of identical neighbours (same kind, words, detail,
 * and work) said once, with its count. Order is kept; the first of a run
 * stands for it, so in a newest-first list that is the newest.
 */
export function collapseRepeats<T extends Receipt>(events: readonly T[]): Collapsed<T>[] {
  const out: Collapsed<T>[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (
      last &&
      last.event.type === event.type &&
      last.event.text === event.text &&
      (last.event.detail ?? null) === (event.detail ?? null) &&
      last.event.itemId === event.itemId
    ) {
      last.count += 1;
    } else {
      out.push({ event, count: 1 });
    }
  }
  return out;
}

/** "×3" beside a receipt that stands for three; empty for one. */
export function repeatText(count: number): string {
  return count > 1 ? `×${count}` : "";
}
