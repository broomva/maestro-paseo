// Read-only RPC contracts for the record: History across all work, and the
// files in one work folder. Served to Maestro's own surfaces only, never on the
// agent socket. Plain Zod values: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { WorkEventSchema } from "./contracts";

export const HISTORY_DAYS = { min: 1, max: 30, default: 7 } as const;
/** History returns at most this many events, the newest. */
export const HISTORY_CAP = 500;
/** A file is read up to this many bytes; the rest is left out and the answer says so. */
export const FILE_READ_BYTES = 64 * 1024;

/** One receipt, with the work it belongs to. */
export const HistoryEventSchema = WorkEventSchema.extend({
  itemId: z.string(),
  title: z.string(),
  initiative: z.string().nullable(),
  project: z.string().nullable(),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const historyWork = defineRpc({
  name: "work.history",
  input: z.object({
    /** Local days back, today included. */
    days: z.number().int().min(HISTORY_DAYS.min).max(HISTORY_DAYS.max).default(HISTORY_DAYS.default),
  }),
  output: z.object({
    /** Newest first. */
    events: z.array(HistoryEventSchema),
    /** More events fell in the window than HISTORY_CAP: the oldest were left out. */
    capped: z.boolean(),
  }),
});

export const WorkFileSchema = z.object({
  name: z.string(),
  size: z.number(),
  mtime: z.string(),
});
export type WorkFile = z.infer<typeof WorkFileSchema>;

export const workFiles = defineRpc({
  name: "work.files",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ files: z.array(WorkFileSchema) }),
});

export const readWorkFile = defineRpc({
  name: "work.file",
  input: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  output: z.object({ name: z.string(), text: z.string(), truncated: z.boolean() }),
});
