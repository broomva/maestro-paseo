// Decision layer v2 as every answer surface reads it (BRO-3167): one view of an
// ask's summary, tradeoffs, sources, media and details, built from a DecisionAsk
// or from a needs row's ask body, so the Decisions card, J5, the Feed inspector,
// the phone deck card, the phone's risen card and the session card draw the same
// thing. Pure.

import { type AnswerWhere, type DecisionAsk, homeKey } from "../shared/fleet";
import type { AskBody } from "../shared/needs";
import {
  type AskMedia,
  type AttachmentRef,
  attachmentKey,
  hasRich,
  type RichAsk,
  type TradeoffAxis,
  type TradeoffRow,
  tradeoffColumns,
} from "../shared/rich-ask";

/** How an attachment is asked for: the ask's handle, as `ask.attachment` takes it, and its hash for the cache. */
export interface AttachmentHandle {
  where: AnswerWhere;
  ledger: string;
  uid: string | null;
  id: string;
  hash: string;
}

export interface RichView {
  handle: AttachmentHandle;
  rich: RichAsk | null;
  /** Each option's media, by option id, in option order; only options with some. */
  optionMedia: readonly { option: string; label: string; media: readonly AskMedia[] }[];
}

/** The view of an ask, or null when it carries nothing v2: a yes/no shows exactly what it showed before. */
export function richViewOf(ask: DecisionAsk | null | undefined): RichView | null {
  if (!ask) return null;
  const optionMedia = ask.options.flatMap((option) =>
    option.media && option.media.length > 0 ? [{ option: option.id, label: option.label, media: option.media }] : [],
  );
  if (!hasRich(ask.rich, optionMedia.length)) return null;
  return {
    handle: {
      where: ask.scope ? { kind: "fleet", scope: ask.scope } : { kind: "workspace", home: homeKey(ask.home) },
      ledger: ask.ledger,
      uid: ask.uid,
      id: ask.id,
      hash: ask.hash,
    },
    rich: ask.rich ?? null,
    optionMedia,
  };
}

/** The view from a needs row's ask body (the phone and the session card may hold the row and not the ask). */
export function richViewOfBody(body: AskBody | null | undefined): RichView | null {
  if (!body?.attach) return null;
  const optionMedia = body.options.flatMap((option) =>
    option.media && option.media.length > 0 ? [{ option: option.id, label: option.label, media: option.media }] : [],
  );
  if (!hasRich(body.rich, optionMedia.length)) return null;
  return { handle: body.attach, rich: body.rich ?? null, optionMedia };
}

/** The DecisionAsk's view when this client holds the ask, else the row body's. */
export function richViewFor(ask: DecisionAsk | null | undefined, body: AskBody | null | undefined): RichView | null {
  return ask ? richViewOf(ask) : richViewOfBody(body);
}

export function mediaOfOption(view: RichView | null, option: string): readonly AskMedia[] {
  return view?.optionMedia.find((entry) => entry.option === option)?.media ?? [];
}

/** Compare side by side when two to four options carry media: each option's first picture, in option order. */
export function compareSet(view: RichView | null): { option: string; label: string; media: AskMedia; index: number }[] {
  const set = (view?.optionMedia ?? []).map((entry) => ({
    option: entry.option,
    label: entry.label,
    media: entry.media[0] as AskMedia,
    index: 0,
  }));
  return set.length >= 2 && set.length <= 4 ? set : [];
}

export interface TradeoffLine {
  /** The option's label, or the free row's. */
  name: string;
  option: string | null;
  cells: { axis: TradeoffAxis; text: string | null }[];
}

export const AXIS_WORDS: Record<TradeoffAxis, string> = {
  cost: "Cost",
  risk: "Risk",
  time: "Time",
  reversibility: "Undo",
};

/** The tradeoff table: one line per row in the ledger's order, each named by its option's label, and its columns. */
export function tradeoffTable(
  rows: readonly TradeoffRow[],
  options: readonly { id: string; label: string }[],
): { columns: TradeoffAxis[]; lines: TradeoffLine[] } {
  const columns = tradeoffColumns(rows);
  const labels = new Map(options.map((option) => [option.id, option.label]));
  return {
    columns,
    lines: rows.map((row) => ({
      name: row.option ? (labels.get(row.option) ?? row.option) : (row.label ?? ""),
      option: row.option,
      cells: columns.map((axis) => ({ axis, text: row[axis] })),
    })),
  };
}

/** The ref of an option's media, or the ask's own (option null). */
export const mediaRef = (option: string | null, index: number): AttachmentRef => ({ list: "media", option, index });
export const sourceRef = (index: number): AttachmentRef => ({ list: "sources", option: null, index });

/** The query key an attachment is cached under. */
export function attachmentQueryKey(handle: AttachmentHandle, ref: AttachmentRef): readonly string[] {
  const home = handle.where.kind === "fleet" ? `fleet:${handle.where.scope}` : handle.where.home;
  return ["maestro", "ask-attachment", attachmentKey({ ...handle, home }, ref)];
}
