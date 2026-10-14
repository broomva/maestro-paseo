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
import { headlineOf, isTriaged, ledgerName, ledgerOf, reversibility, silenceOf } from "../decisions-model";
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
  read: "pending" | "error" | "ok",
  tab: PhoneTab,
  unread: readonly string[] | undefined = undefined,
): string {
  // Health's deck is the notices, Work's the work that needs you: what each could not read is that, not "what needs you".
  const what = tab === "health" ? "the notices" : tab === "work" ? "the work that needs you" : "what needs you";
  if (read === "pending") return `Reading ${what}…`;
  if (read === "error") return `Couldn't read ${what}.`;
  if (unread?.length) return `Couldn't read ${what} (${unread.join(", ")}).`;
  if (tab === "health") return "Nothing is asking for a look.";
  if (tab === "work") return "No work needs you.";
  return tab === "decisions" ? "No decision waits on you." : "Nothing needs you.";
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

/**
 * The line of counts the Decisions sheet adds to answersCounts (BRO-3108): the open asks that do not wait on you, and
 * the ledgers that could not be read. Each is the length of what the sheet lists (`rows`, `warnings`); an ask read
 * that failed says so, never "0 open".
 */
export function openAskCounts(rows: readonly OpenAskRow[] | null, warnings: readonly string[] | null): SheetCount[] {
  if (rows === null) return [{ id: "open-unread", label: "open asks: not read", tone: "warn" }];
  return [
    ...(rows.length > 0 ? [{ id: "open", label: `${rows.length} open` }] : []),
    ...(warnings?.length
      ? [
          {
            id: "warnings",
            label: `${warnings.length} read ${warnings.length === 1 ? "warning" : "warnings"}`,
            tone: "warn" as const,
          },
        ]
      : []),
  ];
}

// ── The open asks the deck does not hold ─────────────────────────────────────

/**
 * An open ask that does not wait on you: answerable, never a hold (isWaiting: the ledger forbids `blocking` beside a
 * reversible default), so needs.list leaves it out and the deck never shows it. The Decisions sheet lists it under
 * "Open, not blocking" (BRO-3108), as the desktop's Decisions does; `entry` is the hold the inspector card opens, so
 * its answer is the same verb as a deck hold's.
 */
export interface OpenAskRow {
  key: string;
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
 * The open asks beside the deck: those the desktop lists (open, ideas aside: answered in Initiatives) that are not
 * holds, oldest first, in the workspace chosen (`scope`, null: all). `workspace` is the name needs.list gives the
 * control repo's own asks (server/needs.ts), so the chip narrows both the same. Pure.
 */
export function openAsks(
  asks: readonly DecisionAsk[],
  workspace: string,
  scope: string | null,
  now: number,
): OpenAskRow[] {
  return asks
    .filter((ask) => isTriaged(ask) && !ask.waiting && (scope === null || (ask.scope ?? workspace) === scope))
    .sort((a, b) => (a.askedAt ?? "\uffff").localeCompare(b.askedAt ?? "\uffff") || a.id.localeCompare(b.id))
    .map((ask) => {
      const row = askRowOf(ask, workspace, ask.askedAt ?? "");
      const undo = reversibility(ask.options);
      const silence = silenceOf(ask);
      return {
        key: row.key,
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
    });
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
