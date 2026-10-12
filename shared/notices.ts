// What you watch that went wrong (J7's Open notices, J1's Health section, BRO-3036): one projection of every
// notice, each with what closes it and its one verb. Owner answer A1: a notice is a fact, never a hold, so it is
// never in needs.list; it closes by itself (a session takes a turn, a run passes, a drift is fixed) or by
// something you do (cancel, snooze). The server computes it once (server/notices.ts) and every count reads it:
// the Health tab's badge, the Feed's Health section and J7's list are the same rows. Plain Zod values only: this
// module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { VerbReceiptSchema } from "./verbs";

export const NOTICE_KINDS = ["stuck", "quiet", "schedule", "loop", "initiative"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The one verb a notice offers. `snooze` is the owner's (8 s undo); the rest open where the notice is handled. */
export const NOTICE_VERBS = ["unblock", "snooze", "open-log", "show-fix", "open-initiatives"] as const;
export type NoticeVerbId = (typeof NOTICE_VERBS)[number];

/** Where a notice opens: its work, a fleet scope's ticks, the timeline, the loops, the initiatives. */
export const NoticeLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work"), id: z.string() }),
  z.object({ kind: z.literal("fleet"), scope: z.string() }),
  z.object({ kind: z.literal("timeline") }),
  z.object({ kind: z.literal("loops") }),
  z.object({ kind: z.literal("initiatives") }),
]);
export type NoticeLink = z.infer<typeof NoticeLinkSchema>;

export const NoticeRowSchema = z.object({
  /** Stable while the notice holds: `work:<id>`, `schedule:<source>`, `fleet:<scope>`, `loop:<id>`, `initiatives:due`. */
  key: z.string(),
  kind: z.enum(NOTICE_KINDS),
  title: z.string(),
  /** Where it comes from: the work's workspace, `launchd`, `Paseo`, the fleet scope, `initiatives`. */
  scope: z.string(),
  ticket: z.string().optional(),
  /** When it began, ISO, or null when its source does not say. */
  since: z.string().nullable(),
  /** What happened, in a line. */
  detail: z.string(),
  /** Each way it ends: `when` it happens, and what the notice `becomes`. */
  closesWhen: z.array(z.object({ when: z.string(), becomes: z.string() })),
  verb: z.object({ id: z.enum(NOTICE_VERBS), label: z.string() }),
  link: NoticeLinkSchema,
});
export type NoticeRow = z.infer<typeof NoticeRowSchema>;

export const NoticeSummarySchema = z.object({
  /** == rows.length == the Health tab's badge == the Feed's Health section (client/health-count test). */
  total: z.number().int().min(0),
  byKind: z.object({
    stuck: z.number().int().min(0),
    quiet: z.number().int().min(0),
    schedule: z.number().int().min(0),
    loop: z.number().int().min(0),
    initiative: z.number().int().min(0),
  }),
  /** Notices you snoozed that would otherwise be listed. */
  snoozed: z.number().int().min(0),
  /** Sources that could not be read (the fleet, the timeline, the loops, the initiatives): their notices are missing, not none. */
  unread: z.array(z.string()),
});
export type NoticeSummary = z.infer<typeof NoticeSummarySchema>;

/** Every notice, oldest first with those of unknown age last; a pure read (BRO-2995). */
export const listNotices = defineRpc({
  name: "notices.list",
  input: z.object({}),
  output: z.object({ rows: z.array(NoticeRowSchema), summary: NoticeSummarySchema }),
});
export type Notices = z.infer<typeof listNotices.output>;

/** How long Snooze quiets a notice, in hours (J7: "Snooze 4h"). */
export const SNOOZE_HOURS = 4;

/**
 * Quiet one notice for SNOOZE_HOURS. It takes effect UNDO_MS later unless undone (B4), and the notice comes
 * back by itself when the time is up if it still holds. Yours alone: never on the agent socket.
 */
export const snoozeNotice = defineRpc({
  name: "notice.snooze",
  input: z.object({ key: z.string().min(1), hours: z.number().int().min(1).max(24).default(SNOOZE_HOURS) }),
  output: VerbReceiptSchema,
});
