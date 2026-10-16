// The phone's M1 shape as a pure model (BRO-3037; docs/design/next/m1-feed-home-mobile.png, m5-decisions-mobile.png):
// every tab is a deck of what needs you there and a sheet of everything else. This module decides what the deck
// holds, what the sheet's rows and counts say, which tab a hold belongs to, where the deck stands when the list
// changes under it, and when an answer that cannot be undone has been asked for twice. The views
// (client/phone/*.tsx) only draw it; every number is a projection's, never a sum of several reads
// (view-models.md invariants 1 and 2): the Feed tab is needs.list's total, the Decisions tab the holds it lists,
// Health the notices.list rows, the sheet's counts the lengths of the rows it lists.

import type { AnswersStatus } from "../../shared/answers";
import type { WorkItem } from "../../shared/contracts";
import type { DecisionAsk } from "../../shared/fleet";
import { askRowOf, type Handled } from "../../shared/needs";
import { isStanding } from "../../shared/needs-you";
import type { NoticeRow } from "../../shared/notices";
import { ticketOf } from "../../shared/text";
import { headlineOf, ledgerName, ledgerOf, reversibility, silenceOf } from "../decisions-model";
import type { NeedEntry } from "../feed-model";
import { ago } from "../format";
import { tabOf } from "../header-count";
import { type HealthRow, HOME_TABS, type HomeSections, type HomeTab, homeBadges, workScope } from "../home-model";
import type { MaestroIntent } from "../intent";
import type { InspectorItem } from "../kit/inspector";
import { panelVerbsFor, verbsFor } from "../kit/inspector-model";
import type { Tab } from "../kit/tab-bar";
import { titleText } from "../records-text";
import { type SettingsPageId, settingsTrail } from "./settings-trail";

// ── The tabs ─────────────────────────────────────────────────────────────────

/** The tab bar's four tabs: Initiatives has none on the phone (M8: a page reached from Health's sheet). */
export const PHONE_TABS = HOME_TABS.filter((tab) => tab.id !== "initiatives");
export type PhoneTab = (typeof PHONE_TABS)[number]["id"];

/**
 * The tab bar's tabs and their counts. Feed, Decisions and Health carry needs.list's and notices.list's numbers
 * (homeBadges: the desktop header's too, so the two never differ); Work carries none, as M1 draws it.
 */
export function phoneTabs(needs: Parameters<typeof homeBadges>[0], notices: number): Tab[] {
  const badges = homeBadges(needs, 0, notices);
  return PHONE_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    ...(tab.id === "work" || !badges[tab.id as HomeTab]
      ? {}
      : {
          badge: badges[tab.id as HomeTab]?.count,
          badgeTone: tab.id === "health" ? ("warn" as const) : ("needs" as const),
        }),
  }));
}

/** What a view-model tab is on the phone: Initiatives is reached from Health. */
export function phoneTabOf(tab: HomeTab): PhoneTab {
  return tab === "initiatives" ? "health" : tab;
}

// ── The decks ────────────────────────────────────────────────────────────────

/** The Feed's deck: every hold, in needs.list's order (the Feed tab's badge is its length). */
export function feedDeck(entries: readonly NeedEntry[]): NeedEntry[] {
  return [...entries];
}

/**
 * The Decisions deck: the holds that open in Decisions (an ask that waits on you, the answers batch), the Decisions
 * tab's badge is its length (header-count.ts holdsByTab). A due review is Initiatives' and an approval or owner
 * step is the Feed's.
 */
export function decisionsDeck(entries: readonly NeedEntry[]): NeedEntry[] {
  return entries.filter((entry) => tabOf(entry.row) === "decisions");
}

/**
 * Where the deck stands when its list changes under it. It follows the hold it was on by key, so a hold that
 * leaves (its undo window closed, it was answered in the session) never moves the deck onto its neighbour; a
 * hold that is gone leaves the deck at the same place, never past the last.
 */
export function resolveIndex(keys: readonly string[], focus: string | null, last: number): number {
  if (keys.length === 0) return 0;
  const at = focus === null ? -1 : keys.indexOf(focus);
  return at >= 0 ? at : Math.min(Math.max(last, 0), keys.length - 1);
}

/**
 * The hold after `key` that is not waiting out its undo window (`waiting`), else the one before it; the same
 * key when nothing else is free. "Allow on the deck advances to the next hold" (M1 frame 3).
 */
export function advanceTo(keys: readonly string[], key: string, waiting: ReadonlySet<string>): string {
  const at = keys.indexOf(key);
  const free = (candidate: string | undefined): candidate is string =>
    candidate !== undefined && !waiting.has(candidate);
  const after = keys.slice(at + 1).find(free);
  if (after) return after;
  const before = keys.slice(0, Math.max(at, 0)).reverse().find(free);
  return before ?? key;
}

// ── What a hold on the deck offers ──────────────────────────────────────────

export interface DeckVerbSpec {
  id: string;
  label: string;
  primary: boolean;
}

/**
 * A hold's verbs on the deck: the kind's own (client/kit/inspector-model.ts), two at most, the primary last. A due
 * review is answered with one of its three or left, so its secondary is the driver's session when it has one.
 */
export function deckVerbs(item: InspectorItem, hasSession: boolean): DeckVerbSpec[] {
  const specs =
    item.kind === "review"
      ? panelVerbsFor("review", item.primaryLabel, hasSession)
      : verbsFor(item.kind, item.primaryLabel);
  return specs.map((verb) => ({ id: verb.id, label: verb.label, primary: verb.primary }));
}

/** The option an ask opens on: the one chosen by the item (the recommendation), else none. */
export function openingChoice(item: InspectorItem): string | undefined {
  return item.kind === "ask" || item.kind === "review" ? item.chosen : undefined;
}

/** Whether an item's chosen option cannot be undone (an ask or a review option marked irreversible). */
export function irreversibleChoice(item: InspectorItem, choice: string | undefined): boolean {
  if ((item.kind !== "ask" && item.kind !== "review") || choice === undefined) return false;
  return item.options.find((option) => option.id === choice)?.irreversible === true;
}

// ── An answer that cannot be undone asks twice ──────────────────────────────

/** A second press this soon after the first is not deliberate: the same breath, the same thumb. */
export const CONFIRM_MS = 400;
/** The first press stays armed this long; after it the answer asks again. */
export const CONFIRM_WINDOW_MS = 6000;

export interface Armed {
  key: string;
  choice: string;
  at: number;
}

/**
 * The step a press on Answer takes. A reversible choice is sent. One that cannot be undone is armed by the first
 * press, sent by a second on the same hold and the same choice that is deliberate (CONFIRM_MS later) and within
 * CONFIRM_WINDOW_MS; a press that is too soon waits, and one for another choice or hold arms again.
 */
export function answerStep(
  armed: Armed | null,
  press: { key: string; choice: string; irreversible: boolean },
  now: number,
): "send" | "arm" | "wait" {
  if (!press.irreversible) return "send";
  if (armed === null || armed.key !== press.key || armed.choice !== press.choice || now - armed.at > CONFIRM_WINDOW_MS)
    return "arm";
  return now - armed.at < CONFIRM_MS ? "wait" : "send";
}

// ── The sheet ────────────────────────────────────────────────────────────────

export type RowLead = "running" | "standing" | "queued" | "ok" | "danger" | "warn";

/** What a row opens or does: its work in the inspector card, a notice's own view, or its session. */
export interface RowTarget {
  item: WorkItem | null;
  notice: NoticeRow | null;
  open: MaestroIntent | null;
}

export interface SheetRow {
  key: string;
  /** The kind the swipe model reads: a hold never swipes (client/kit/swipe-model.ts); none of these is one. */
  kind: "running" | "queued" | "finished" | "notice";
  title: string;
  meta: string;
  age: string;
  lead: RowLead;
  target: RowTarget;
  /** The left swipe's verbs, besides Open. */
  verbs: { continue: boolean; snooze: boolean };
}

export interface SheetGroup {
  id: "queued" | "running" | "health" | "finished";
  title: string;
  rows: SheetRow[];
}

const metaOf = (item: WorkItem): string =>
  [workScope(item), item.ticket ?? ticketOf(item.title), item.phase].filter(Boolean).join(" · ");

function workRow(item: WorkItem, kind: SheetRow["kind"], lead: RowLead, now: number): SheetRow {
  return {
    key: `work:${item.id}`,
    kind,
    title: titleText(item),
    meta: metaOf(item),
    age: ago(item.updatedAt, now),
    lead,
    target: { item, notice: null, open: null },
    verbs: { continue: kind === "finished", snooze: false },
  };
}

function noticeRow(row: HealthRow, now: number): SheetRow {
  return {
    key: row.key,
    kind: "notice",
    title: row.title,
    meta: [row.notice.scope, row.notice.ticket].filter(Boolean).join(" · "),
    age: row.since ? ago(row.since, now) : "",
    lead: row.notice.kind === "stuck" || row.notice.kind === "schedule" ? "danger" : "warn",
    target: { item: row.item, notice: row.notice, open: row.open },
    // Snooze is offered by the notice itself (a quiet run), never assumed from its kind.
    verbs: { continue: false, snooze: row.notice.verb.id === "snooze" },
  };
}

/** The Feed sheet's groups, from the sections the desktop's main column reads (homeSections): Queued, Running, Health, Finished. */
export function feedSheet(sections: HomeSections, now: number): SheetGroup[] {
  const groups: SheetGroup[] = [
    { id: "queued", title: "Queued", rows: sections.queued.map((item) => workRow(item, "queued", "queued", now)) },
    {
      id: "running",
      title: "Running",
      rows: sections.running.map((item) => workRow(item, "running", isStanding(item) ? "standing" : "running", now)),
    },
    { id: "health", title: "Health", rows: sections.health.map((row) => noticeRow(row, now)) },
    {
      id: "finished",
      title: "Finished",
      rows: sections.finished.map((item) => workRow(item, "finished", "ok", now)),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

export interface SheetCount {
  id: string;
  label: string;
  tone?: "warn";
  running?: boolean;
}

/**
 * The line of counts under the Feed sheet's title ("3 running · 2 finished · 4 health · 22 handled"): the lengths of
 * the sections it lists, and handled.list's `today.closedForYou`, the desktop's Handled tile.
 */
export function feedCounts(
  sections: Pick<HomeSections, "running" | "finished" | "health">,
  handled: Handled | null,
): SheetCount[] {
  return [
    { id: "running", label: `${sections.running.length} running`, running: true },
    { id: "finished", label: `${sections.finished.length} finished` },
    { id: "health", label: `${sections.health.length} health` },
    { id: "handled", label: handled ? `${handled.today.closedForYou} handled` : "handled: not read" },
  ];
}

/**
 * The sources needs.list could not read, in words (BRO-3008): a hold of one is missing because the read failed, not
 * because it was answered. null when every source was read.
 */
export function unreadWords(unread: readonly string[] | undefined, tab: PhoneTab = "feed"): string | null {
  if (!unread?.length) return null;
  return tab === "health"
    ? `Couldn't read ${unread.join(", ")}: notices may be missing.`
    : `Couldn't read ${unread.join(", ")}: what needs you may be missing holds.`;
}

/**
 * What the deck says when it is empty: never "nothing needs you" over a read that failed or left a source unread.
 */
export function deckEmptyWords(
  read: DeckRead,
  tab: PhoneTab,
  unread: readonly string[] | undefined = undefined,
): string {
  // Health's deck is the notices, Work's the work that needs you: what each could not read is that, not "what needs you".
  const what =
    tab === "health"
      ? "the notices"
      : tab === "work"
        ? "the work that needs you"
        : tab === "decisions"
          ? "the open asks"
          : "what needs you";
  if (read === "pending") return `Reading ${what}…`;
  if (read === "error") return `Couldn't read ${what}.`;
  // A refetch that failed over an empty read concludes nothing (BRO-3094).
  if (read === "stale") return `Couldn't read ${what} again: the last read held none, and may be out of date.`;
  if (unread?.length) return `Couldn't read ${what} (${unread.join(", ")}).`;
  if (tab === "health") return "Nothing is asking for a look.";
  if (tab === "work") return "No work needs you.";
  return tab === "decisions" ? "No ask is open: nothing waits on you." : "Nothing needs you.";
}

/** A deck's title and its trailing words. */
export function deckTitle(tab: PhoneTab): string {
  return tab === "feed" ? "Needs you" : (PHONE_TABS.find((entry) => entry.id === tab)?.label ?? "Maestro");
}

/** The first line of the sheet's peek for a tab (the frame's "Everything else", "Your answers"). */
export function sheetTitle(tab: PhoneTab): string {
  switch (tab) {
    case "feed":
      return "Everything else";
    case "decisions":
      return "Your answers";
    case "work":
      return "The board";
    case "health":
      return "The fleet";
  }
}

/**
 * The line of counts under the Decisions sheet's title ("27 waiting to land · 3 routed · 41 acted on · 2 held"):
 * answers.status's own numbers, the stranded ones in warn. Not read: it says so.
 */
export function answersCounts(status: AnswersStatus | null): SheetCount[] {
  if (!status) return [{ id: "unread", label: "answers: not read", tone: "warn" }];
  return [
    {
      id: "waiting",
      label: `${status.waitingToLand} waiting to land`,
      ...(status.waitingToLand > 0 ? { tone: "warn" as const } : {}),
    },
    { id: "routed", label: `${status.routed} routed` },
    { id: "acted", label: `${status.acted} acted` },
    { id: "held", label: `${status.held} held` },
  ];
}

// ── Every open ask on the Decisions deck ─────────────────────────────────────

/**
 * Where an open ask stands on the Decisions deck (BRO-3140, deciding BRO-3113: "see all decisions and asks
 * regardless"). `waits`: it waits on you (a hold, or isWaiting); `open`: answerable, blocks nothing; `idea`: an
 * initiative's develop, park or kill. The deck lists them in that order, each card wearing its words.
 */
export type DeckLane = "waits" | "open" | "idea";

export const LANE_WORDS: Record<DeckLane, string> = { waits: "Waits on you", open: "Not blocking", idea: "Idea" };

const LANE_ORDER: Record<DeckLane, number> = { waits: 0, open: 1, idea: 2 };

/**
 * An open ask that needs.list does not hold: answerable from its card on the deck, after the holds. `entry` is the
 * hold the card and the inspector open, so its answer is the same verb as a hold's.
 */
export interface OpenAskRow {
  key: string;
  lane: DeckLane;
  title: string;
  /** Its ledger, and whether it can be undone: "sri · leadership-20261013 · reversible". */
  meta: string;
  age: string;
  /** What happens if you say nothing ("silent → hold"); null when the ledger does not say. */
  silent: string | null;
  entry: NeedEntry;
}

/** The name needs.list gives the control repo's own asks (server/needs.ts: its folder's name, else "workspace"). */
export function workspaceNameOf(controlRepo: string | null | undefined): string {
  return controlRepo?.split("/").filter(Boolean).pop() ?? "workspace";
}

/**
 * Every open ask the deck's holds do not already carry, ideas among them, in the workspace chosen (`scope`, null:
 * all): those that wait on you first (an ask needs.list could not hold: its prompt session holds it, or its source
 * was not read), then the ones that block nothing, then ideas, each oldest first. `held` is the keys of the holds
 * the deck lists, so no ask is on it twice (BRO-3112). `workspace` is the name needs.list gives the control repo's
 * own asks (server/needs.ts), so the chip narrows both the same. Pure.
 */
export function openAsks(
  asks: readonly DecisionAsk[],
  workspace: string,
  scope: string | null,
  now: number,
  held: ReadonlySet<string> = new Set(),
  promptHeld = false,
): OpenAskRow[] {
  const laneOf = (ask: DecisionAsk): DeckLane => (ask.idea ? "idea" : ask.waiting ? "waits" : "open");
  const seen = new Set<string>();
  return (
    asks
      .filter((ask) => ask.state === "open" && (scope === null || (ask.scope ?? workspace) === scope))
      // One prompt is one hold (server/needs.ts): a waiting prompt ask needs.list did not hold is held by its
      // session's permission prompt, which the Feed carries as the approval. `promptHeld`: needs.list read its asks.
      .filter((ask) => !(promptHeld && ask.promptSession && ask.waiting))
      .map((ask) => ({ ask, row: askRowOf(ask, workspace, ask.askedAt ?? "") }))
      // One ask read twice is one card, as it is one hold.
      .filter(({ row }) => !held.has(row.key) && !seen.has(row.key) && Boolean(seen.add(row.key)))
      .sort(
        (a, b) =>
          LANE_ORDER[laneOf(a.ask)] - LANE_ORDER[laneOf(b.ask)] ||
          (a.ask.askedAt ?? "\uffff").localeCompare(b.ask.askedAt ?? "\uffff") ||
          a.ask.id.localeCompare(b.ask.id),
      )
      .map(({ ask, row }) => {
        const undo = reversibility(ask.options);
        const silence = silenceOf(ask);
        return {
          key: row.key,
          lane: laneOf(ask),
          title: headlineOf(ask).headline,
          meta: [
            ledgerName(ledgerOf(ask)),
            undo === true ? "reversible" : undo === false ? "an option cannot be undone" : null,
          ]
            .filter(Boolean)
            .join(" · "),
          age: ago(ask.askedAt, now),
          silent: silence ? `silent → ${silence.text.replace(/^If you say nothing: /, "")}` : null,
          entry: { row, item: null, ask },
        };
      })
  );
}

/** A card on the Decisions deck: a hold or an open ask, and the words it wears. */
export interface DecisionCard {
  entry: NeedEntry;
  lane: DeckLane;
}

/**
 * The Decisions deck: its holds (decisionsDeck, which wait on you), then every other open ask (openAsks). The
 * empty state is only for a deck whose reads both succeeded and held nothing (deckEmptyWords).
 */
export function decisionCards(holds: readonly NeedEntry[], open: readonly OpenAskRow[]): DecisionCard[] {
  return [
    ...holds.map((entry) => ({ entry, lane: "waits" as const })),
    ...open.map((row) => ({ entry: row.entry, lane: row.lane })),
  ];
}

/** The line over the Decisions deck: how many it lists and how many of them wait on you ("23 open · none waits on you"). Only over two reads that landed: a failed one is said instead. */
export function decisionCountWords(cards: readonly DecisionCard[]): string {
  const waits = cards.filter((card) => card.lane === "waits").length;
  const ideas = cards.filter((card) => card.lane === "idea").length;
  return [
    `${cards.length} open`,
    waits === 0 ? "none waits on you" : `${waits} ${waits === 1 ? "waits" : "wait"} on you`,
    ideas > 0 ? `${ideas} ${ideas === 1 ? "idea" : "ideas"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * How a read stands for what a deck says (BRO-3094): `stale` is a refetch that failed over data read before, so
 * nothing it lists is concluded answered or gone, and an empty deck is never "nothing".
 */
export type DeckRead = "pending" | "error" | "stale" | "ok";

export function readOf(query: { data?: unknown; isError: boolean }): DeckRead {
  if (query.data === undefined || query.data === null) return query.isError ? "error" : "pending";
  return query.isError ? "stale" : "ok";
}

/** Two reads as one: the worst of them (an error, then a stale read, then one still reading). */
export function bothRead(a: DeckRead, b: DeckRead): DeckRead {
  const rank: Record<DeckRead, number> = { error: 0, stale: 1, pending: 2, ok: 3 };
  return rank[a] <= rank[b] ? a : b;
}

/** The line over a deck whose last refetch failed (BRO-3094): what it shows is the read from `at`, said. */
export function staleWords(at: number, now: number): string {
  const age = ago(new Date(at).toISOString(), now);
  const when = age === "now" ? "just now" : `${age} ago`;
  return `Couldn't read again: this is the read from ${when}, and may be out of date.`;
}

// ── Pages ────────────────────────────────────────────────────────────────────

/** A page that rises over the surface: Health's sheet reaches the first four, the presence menu the last. */
export type PhonePage =
  | { kind: "initiatives" }
  | { kind: "fleet"; scope: string | null; tick: number | null }
  | { kind: "timeline" }
  | { kind: "loops" }
  | { kind: "settings"; page: SettingsPageId };

/** The page an intent opens on the phone, or null when it opens a tab or something else (Decisions, work). */
export function pageOfIntent(intent: MaestroIntent): PhonePage | null {
  switch (intent.kind) {
    case "fleet":
      return { kind: "fleet", scope: intent.scope, tick: null };
    case "timeline":
      return { kind: "timeline" };
    case "loops":
      return { kind: "loops" };
    case "initiatives":
      return { kind: "initiatives" };
    default:
      return null;
  }
}

/** Where you are, for a page's header ("from Health" over the list M8 reaches from Health's sheet). */
export function pageTrail(page: PhonePage): string[] {
  switch (page.kind) {
    case "initiatives":
      return ["from Health"];
    case "fleet":
      return ["Fleet"];
    case "timeline":
      return ["Timeline"];
    case "loops":
      return ["Loops"];
    case "settings":
      return settingsTrail(page.page);
  }
}
