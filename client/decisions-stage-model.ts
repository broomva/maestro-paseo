// J5, Decisions one at a time (BRO-3036; docs/design/next/j5-decisions.png), as a pure model: the four tiles
// (Open, Waiting to land, Routed in progress, Acted on), the header's "Decision 1 of 2 · 1 blocks work" with
// its progress segments, the Up next list and where your last answers went. The view draws it
// (client/decisions-stage.tsx).
//
// Every number is a projection's, never a sum of several reads (view-models.md, invariants 1 and 2): Open is
// the queue the tab walks, and its "on you" part is needs.list's asks (the Decisions tab badge less the
// answers batch); Waiting to land is answers.status's `waitingToLand`, the landing's own count the answers hold
// in Needs you words; Routed and Acted on are answers.status's.

import type { AnswerStage, AnswersStatus, RecentAnswer } from "../shared/answers";
import type { DecisionAsk } from "../shared/fleet";
import { holdOf, type Needs } from "../shared/needs";
import { headlineOf, ledgerName, ledgerOf, ledgerRail, reversibility, silenceOf, writtenTo } from "./decisions-model";
import { ago, plural } from "./format";
import type { InspectorItem } from "./kit/inspector";
import { withOther } from "./kit/inspector-model";
import { richViewOf } from "./rich-ask-model";

/** How many ledgers the Open tile names before it stops. */
const TILE_LEDGERS = 3;

/** The decisions that wait on you, as needs.list holds them: its `ask:` holds. A due review (`review:`) is Initiatives' and the answers batch is its own hold. */
export function askHolds(needs: Pick<Needs, "rows"> | null): number {
  return (needs?.rows ?? []).filter((row) => holdOf(row.key)?.kind === "ask").length;
}

export interface StageTile {
  value: number;
  unit: string;
  line: string;
  /** A second line: the ledgers an Open decision sits in. */
  extra?: string;
  tone: "needs" | "warn" | "plain";
  /** The tile's own verb: the landing PR, which it opens and never merges. */
  verb?: { label: string; url: string };
}

export interface StageTiles {
  open: StageTile;
  landing: StageTile;
  routed: StageTile;
  acted: StageTile;
}

/** The four tiles. `queue` is every open decision the tab walks (ideas aside), all ledgers. */
export function stageTiles(
  queue: readonly DecisionAsk[],
  needs: Pick<Needs, "rows"> | null,
  status: AnswersStatus | null,
  now: number,
): StageTiles {
  const blocking = queue.filter((ask) => ask.blocking).length;
  const onYou = askHolds(needs);
  const oldest = queue
    .map((ask) => ask.askedAt)
    .filter((at): at is string => at !== null)
    .sort()[0];
  const ledgers = ledgerRail(queue)
    .slice(0, TILE_LEDGERS)
    .map((entry) => `${ledgerName(entry.ledger)} ${entry.open}`)
    .join(" · ");
  const open: StageTile = {
    value: queue.length,
    unit: queue.length === 1 ? "decision" : "decisions",
    line:
      queue.length === 0
        ? "Nothing open in any ledger."
        : [
            `${blocking} ${blocking === 1 ? "blocks" : "block"} work`,
            needs ? `${onYou} on you` : null,
            oldest ? `oldest ${ago(oldest, now)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
    ...(ledgers ? { extra: ledgers } : {}),
    tone: queue.length > 0 ? "needs" : "plain",
  };
  const waiting = status?.waitingToLand ?? 0;
  // As Needs you has it (answersNotice): a failed step with nothing waiting is the wake log's to say, not a warning here.
  const stage = status?.landing?.stage;
  const stopped = stage === "conflict" || stage === "blocked" || (stage === "failed" && waiting > 0);
  const pr = status?.landing?.pr ?? null;
  const landing: StageTile = {
    value: waiting,
    unit: waiting === 1 ? "answer" : "answers",
    line: !status
      ? "Where your answers wait is not read yet."
      : stopped
        ? status.landing?.words || "The batch has stopped; Needs you says why."
        : waiting === 0
          ? "Everything you answered is on main."
          : pr
            ? "Answered, but still on maestro/answers, not on main. Agents can't act on them until they land."
            : "Answered, but still on maestro/answers. Maestro opens its PR at its next check.",
    tone: waiting > 0 || stopped ? "warn" : "plain",
    ...(pr && (waiting > 0 || stopped) ? { verb: { label: "Open the PR", url: pr.url } } : {}),
  };
  const routed: StageTile = {
    value: status?.routed ?? 0,
    unit: "in progress",
    line:
      (status?.routed ?? 0) > 0
        ? "Each went to a live session or a coordinator; see the list on the right."
        : "Nothing is between landing and being acted on.",
    tone: "plain",
  };
  const held = status?.held ?? 0;
  const acted: StageTile = {
    value: status?.acted ?? 0,
    unit: "acted on",
    line:
      held > 0
        ? `${plural(held, "more answer")} held for the conductor: nothing starts until a lane takes ${held === 1 ? "it" : "them"} (A8).`
        : status && status.window > 0
          ? `of the ${plural(status.window, "answer")} Maestro can act on.`
          : status
            ? "Nothing you answered has been acted on yet."
            : "",
    tone: "plain",
  };
  return { open, landing, routed, acted };
}

/** The header's line above the stage: "Decision 1 of 2 · 1 blocks work". */
export function stageProgress(progress: { text: string }, queue: readonly DecisionAsk[], skipped: number): string {
  const blocking = queue.filter((ask) => ask.blocking).length;
  return [
    progress.text,
    blocking > 0 ? `${blocking} ${blocking === 1 ? "blocks" : "block"} work` : null,
    skipped > 0 ? `${skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The progress segments: one per decision this visit has had, filled for each answered. At most 12. */
export function progressSegments(answered: number, total: number): boolean[] {
  const count = Math.min(Math.max(total, 0), 12);
  const done = Math.min(Math.max(answered, 0), count);
  return Array.from({ length: count }, (_, at) => at < done);
}

export interface UpNextRow {
  key: string;
  title: string;
  ledger: string;
  blocks: boolean;
  /** The silent default as the frame says it ("silent → hold"), when the ask names one. */
  silent: string | null;
  /** What a screen reader says: the ask's id, its ledger and its headline. */
  label: string;
}

/** One Up next card. */
export function upNextRow(ask: DecisionAsk): UpNextRow {
  return {
    key: ledgerOf(ask) + (ask.uid ?? ask.id),
    title: headlineOf(ask).headline,
    ledger: ledgerName(ledgerOf(ask)),
    blocks: ask.blocking,
    silent: ask.fallback?.trim() ? `silent → ${ask.fallback.trim()}` : null,
    label: `Go to ${ask.id} in ${ledgerOf(ask)}: ${headlineOf(ask).headline}`,
  };
}

export interface AnswerChip {
  word: string;
  tone: "ok" | "info" | "warn" | "muted";
}

/** A stage in the one word the chip says, and a tone only as a second cue. */
export function stageChip(stage: AnswerStage): AnswerChip {
  switch (stage) {
    case "acted":
      return { word: "acted", tone: "ok" };
    case "unrouted":
      return { word: "routed", tone: "info" };
    case "conductor":
      return { word: "held", tone: "warn" };
    case "unlanded":
      return { word: "waiting", tone: "warn" };
    case "superseded":
      return { word: "recorded", tone: "muted" };
    case "before":
      return { word: "earlier", tone: "muted" };
  }
}

export interface WentRow {
  key: string;
  title: string;
  line: string;
  words: string;
  chip: AnswerChip;
}

/** Where your last answers went, each as the rail says it. */
export function wentRows(recent: readonly RecentAnswer[]): WentRow[] {
  return recent.map((answer) => ({
    key: answer.key,
    title: answer.title,
    // Your note beside the option (BRO-3146), so what you said is in view, not only what you chose.
    line: `You: ${answer.answer}${answer.note ? ` · Note: ${answer.note}` : ""}`,
    words: answer.words,
    chip: stageChip(answer.stage),
  }));
}

/**
 * Where your answer goes, as J5 says it: to the session that asked, verbatim; if that is gone, a sibling, then
 * the initiative's driver; with none, it waits for the conductor (A8). And where it is written.
 */
export function routeLine(ask: DecisionAsk): string {
  const asker = ask.origin ? ` (${ask.origin.agentId.slice(0, 8)})` : "";
  return `Goes to the session that asked${asker}, verbatim. If it is gone: a sibling, then the initiative's driver; with none, it waits for the conductor. ${writtenTo(ask)}.`;
}

/**
 * The decision as J3's inspector draws it, at full width (J5): the same body the Feed's inspector has, with the
 * ask's own words. `chosen` is your choice (the draft), never the recommendation unless you made it.
 */
export function stageItem(ask: DecisionAsk, chosen: string | null, now: number): InspectorItem {
  const lead = headlineOf(ask);
  const undo = reversibility(ask.options);
  const silence = silenceOf(ask);
  const rich = richViewOf(ask);
  return {
    kind: "ask",
    key: `${ledgerOf(ask)}#${ask.uid ?? ask.id}`,
    kicker: [
      ledgerName(ledgerOf(ask)),
      ask.id,
      undo === true ? "reversible" : undo === false ? "an option cannot be undone" : "undo: not stated",
    ],
    age: ask.askedAt ? ago(ask.askedAt, now) : undefined,
    title: lead.headline,
    cost: ask.stakes ?? undefined,
    whyYou: ask.whyYou ?? undefined,
    options: withOther(
      ask.options.map((option) => ({
        id: option.id,
        label: option.label,
        note: [option.consequence, option.reversible === false ? "cannot be undone" : null].filter(Boolean).join(" · "),
        recommended: option.recommended,
        irreversible: option.reversible === false,
      })),
      ask,
    ),
    chosen: chosen ?? undefined,
    fallback: silence ? { line: `${silence.text}.` } : undefined,
    goes: routeLine(ask),
    fieldLabel: `Your words for ${ask.id}`,
    optionsLabel: `Options for ${ask.id}`,
    ...(rich ? { rich } : {}),
  };
}

/** A ledger chip's words for a screen reader: its open count, and how many wait on you. */
export function railLabel(name: string, open: number, waiting: number): string {
  return `${name}: ${open} open${waiting > 0 ? `, ${waiting} ${waiting === 1 ? "waits" : "wait"} on you` : ""}`;
}
