// The header count and the tab badges: in every workspace, "N need you" while
// anything holds on you, and nothing while none does. The number is needs.list's
// summary.total (server/needs.ts, BRO-3001): the same rows the Feed's Needs
// you section lists, the tabs count and the push says. Nothing here adds lists
// from several reads; each number is the projection's total or the length of
// the rows a tab lists. Pure.

import type { PluginButton } from "@getpaseo/plugin/client";
import { holdOf, type NeedRow, type Needs } from "../shared/needs";
import type { MaestroIntent } from "./intent";

export function needsYouLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

/** The tab a hold opens in: work in the Feed, an ask and the answers batch in Decisions, a review in Initiatives. */
export type HoldTab = "feed" | "decisions" | "initiatives";

export function tabOf(row: Pick<NeedRow, "key">): HoldTab {
  const hold = holdOf(row.key);
  if (hold?.kind === "ask" || hold?.kind === "answers") return "decisions";
  if (hold?.kind === "review") return "initiatives";
  return "feed";
}

/** The ask's id inside its key (Decisions focuses by its full identity, and by the id beside it). */
function askId(askKey: string): string | null {
  try {
    const parts = JSON.parse(askKey) as unknown;
    return Array.isArray(parts) && typeof parts[3] === "string" ? parts[3] : null;
  } catch {
    return null;
  }
}

/** Where one hold opens: its work item, its ask in Decisions, its initiative, or Decisions for the answers batch. */
export function holdTarget(row: Pick<NeedRow, "key">): MaestroIntent {
  const hold = holdOf(row.key);
  switch (hold?.kind) {
    case "work":
      return { kind: "select", id: hold.id };
    case "ask": {
      const id = askId(hold.askKey);
      return id ? { kind: "decisions", ledger: null, id, key: hold.askKey } : { kind: "decisions" };
    }
    case "review":
      return { kind: "initiatives" };
    case "answers":
      return { kind: "decisions" };
    default:
      return { kind: "filter", group: "review" };
  }
}

/**
 * Where the count opens Maestro: the one hold, when one is all; Decisions or
 * Initiatives when every hold opens there; else the Feed, whose Needs you
 * section lists every hold the count counts.
 */
export function needsTarget(needs: Pick<Needs, "rows">): MaestroIntent {
  const [only] = needs.rows;
  if (needs.rows.length === 1 && only) return holdTarget(only);
  const tabs = new Set(needs.rows.map(tabOf));
  if (tabs.size === 1 && tabs.has("decisions")) return { kind: "decisions" };
  if (tabs.size === 1 && tabs.has("initiatives")) return { kind: "initiatives" };
  return { kind: "filter", group: "review" };
}

export type HeaderSpec = { count: number };

/** One header button per workspace, all showing the same count. */
export function headerSpecs(workspaceIds: readonly string[], count: number): Map<string, HeaderSpec> {
  return new Map(workspaceIds.map((id) => [id, { count }]));
}

/** What the button shows. Compact headers drop the label, so the title carries the count too. */
export function headerFace(count: number): Pick<PluginButton, "title" | "label" | "icon" | "visible"> {
  const label = needsYouLabel(count);
  return { title: `${label} in Maestro`, label, icon: "Inbox", visible: count > 0 };
}

/** How many holds open in each tab: the lengths of needs.list's rows by where they open (tabOf). */
export function holdsByTab(rows: readonly Pick<NeedRow, "key">[]): Record<HoldTab, number> {
  const out: Record<HoldTab, number> = { feed: 0, decisions: 0, initiatives: 0 };
  for (const row of rows) out[tabOf(row)] += 1;
  return out;
}

/** A view's badge on the switch (client/plane-controls.tsx ViewBadge). */
export type TabBadge = { count: number; warn: boolean; label: string };

const badge = (count: number, words: string): TabBadge | null =>
  count > 0 ? { count, warn: true, label: `${count} ${words}` } : null;

/**
 * The tabs' badges, from needs.list alone: the Feed carries the total (its
 * Needs you section lists every hold), Decisions the holds it lists (asks that
 * wait on you and the answers batch), Initiatives its due reviews. A tab with
 * none carries no badge.
 */
export function tabBadges(needs: Pick<Needs, "rows" | "summary">): Record<HoldTab, TabBadge | null> {
  const { decisions, initiatives: reviews } = holdsByTab(needs.rows);
  return {
    feed: badge(needs.summary.total, needs.summary.total === 1 ? "needs you" : "need you"),
    decisions: badge(decisions, decisions === 1 ? "waits on you" : "wait on you"),
    initiatives: badge(reviews, reviews === 1 ? "review is due" : "reviews are due"),
  };
}
