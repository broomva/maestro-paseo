// Decision layer v2 (BRO-3167, workspace .control/asks/DECISION-LAYER.md): what
// lets you decide an ask at a glance. The asking agent scales it to the decision,
// so every field is optional and a yes/no carries none:
//
// - `summary`: 2–4 plain sentences, what is decided and what changes;
// - `tradeoffs`: rows, an option (or a free label) × cost, risk, time, reversibility;
// - `sources`: what the agent read (a ticket, a PR, a spec, a doc, a file, a URL, a session);
// - `media`, on the ask and on each option: images, video, SVG or HTML, side by side;
// - `details`: long-form markdown behind a disclosure.
//
// The wire carries what the ledger says, entry by entry, dropping only an entry
// Maestro could not show (an unknown kind, a path that leaves the repo, a URL that
// is not https). A local file's bytes travel only when you look, through
// `ask.media`, which reads nothing an ask does not name (server/rich-ask.ts).
// Plain Zod values: this module is compiled into both bundles.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MEDIA_KINDS = ["image", "video", "svg", "html"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** The extensions a local file of each kind may have: the validator's list (ask_ledger.py MEDIA_EXTENSIONS). */
export const MEDIA_EXTENSIONS: Record<MediaKind, readonly string[]> = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp"],
  video: [".mp4", ".webm", ".mov"],
  svg: [".svg"],
  html: [".html", ".htm"],
};

/** The largest local file of each kind Maestro sends: the validator's caps (ask_ledger.py MEDIA_MAX_BYTES). */
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  image: 5 * 2 ** 20,
  video: 25 * 2 ** 20,
  svg: 2 ** 20,
  html: 2 * 2 ** 20,
};

/** A local doc, spec or file a source names is sent up to this size, as text. */
export const SOURCE_TEXT_MAX_BYTES = 2 * 2 ** 20;

export const SOURCE_KINDS = ["ticket", "pr", "doc", "spec", "url", "file", "session"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const TRADEOFF_AXES = ["cost", "risk", "time", "reversibility"] as const;
export type TradeoffAxis = (typeof TRADEOFF_AXES)[number];

export const AskMediaSchema = z.object({
  kind: z.enum(MEDIA_KINDS),
  /** Repo-relative, inside the ask's home; exactly one of path and url. */
  path: z.string().nullable(),
  /** https only. */
  url: z.string().nullable(),
  caption: z.string().nullable(),
});
export type AskMedia = z.infer<typeof AskMediaSchema>;

export const AskSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  ref: z.string(),
  label: z.string().nullable(),
});
export type AskSource = z.infer<typeof AskSourceSchema>;

export const TradeoffRowSchema = z.object({
  /** The option the row is about; null for a free row, which has a label. */
  option: z.string().nullable(),
  label: z.string().nullable(),
  cost: z.string().nullable(),
  risk: z.string().nullable(),
  time: z.string().nullable(),
  reversibility: z.string().nullable(),
});
export type TradeoffRow = z.infer<typeof TradeoffRowSchema>;

/** The ask-level half of v2. Per-option media rides on DecisionOption.media. */
export const RichAskSchema = z.object({
  summary: z.string().nullable(),
  tradeoffs: z.array(TradeoffRowSchema),
  sources: z.array(AskSourceSchema),
  media: z.array(AskMediaSchema),
  details: z.string().nullable(),
});
export type RichAsk = z.infer<typeof RichAskSchema>;

/** Which media or source of an ask: on the ask, or on one of its options, by position. */
export const AttachmentRefSchema = z.object({
  list: z.enum(["media", "sources"]),
  /** An option's id for its media; null for the ask's own. */
  option: z.string().nullable(),
  index: z.number().int().min(0).max(31),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/**
 * A local file an ask names, read from the ask's home: as a data URL (images,
 * SVG, video) or as text (HTML, markdown, other docs). Asked for when you look,
 * by the ask's handle and the attachment's position, never by a path: the
 * server reads only what the ask names.
 */
export const getAskAttachment = defineRpc({
  name: "ask.attachment",
  input: z.object({
    where: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("fleet"), scope: z.string().min(1) }),
      z.object({ kind: z.literal("workspace"), home: z.string().min(1) }),
    ]),
    ledger: z.string().min(1),
    uid: z.string().min(1).nullable(),
    id: z.string().min(1),
    /** DecisionAsk.hash as you read it: an attachment of an ask changed since is refused, never a different file served. */
    hash: z.string().min(1),
    ref: AttachmentRefSchema,
  }),
  output: z.object({
    /** The file's type, from its extension. */
    mime: z.string(),
    /** `data:` URL for images, SVG and video; null for text. */
    dataUrl: z.string().nullable(),
    /** The file as text, for HTML and docs; null for binary media. */
    text: z.string().nullable(),
    /** The file on GitHub, when its home is origin/main of a GitHub repo; null otherwise. */
    webUrl: z.string().nullable(),
  }),
});
export type AskAttachment = z.infer<typeof getAskAttachment.output>;

// ── Pure helpers, both bundles ────────────────────────────────────────────────

const TICKET = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const PR = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const HTTPS = /^https:\/\/[^\s/]+\S*$/;
const SESSION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

/** Characters no path here may hold: control characters (a newline would split a `git cat-file --batch` spec). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A repo-relative path that stays in the repo: no absolute path, no `..`, no scheme, no backslash, no control
 * character. A source may carry an anchor after `#`, which is checked apart; a media path may not (`anchor: false`):
 * Maestro reads the media path as written, so an anchor there would name a different file than the one validated.
 */
export function safeRelative(ref: string, anchor = true): boolean {
  if (CONTROL.test(ref)) return false;
  if (!anchor && ref.includes("#")) return false;
  const path = ref.split("#", 1)[0] ?? "";
  if (!path || path.startsWith("/") || path.startsWith("~") || path.includes(":") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * The whitespace both readers agree on: ASCII space, tab, newline, carriage return, form feed, vertical tab. Python's
 * `str.strip()` and JS's `trim()` each take more (Python \x1c-\x1f, JS \u00a0 and \ufeff), so neither is used here,
 * nor in ask_ledger.py's v2 checks (`_WS`): a value one reader trims and the other keeps would pass one and fail the
 * other.
 */
const WS = "[ \\t\\n\\r\\f\\v]";
const EDGES = new RegExp(`^${WS}+|${WS}+$`, "g");
const RUNS = new RegExp(`${WS}+`, "g");

/** A value with that whitespace trimmed from both ends. */
export function trimWs(value: string): string {
  return value.replace(EDGES, "");
}

/**
 * A string's length as both readers measure a cap: trimmed, runs of whitespace counted as one space, and counted in
 * code points (Python's `len`), not UTF-16 units: an emoji is one character on both sides.
 */
export function flatLength(value: string): number {
  return Array.from(trimWs(value).replace(RUNS, " ")).length;
}

/** The first `max` code points of a string: a cut that never splits an emoji, and the count Python's `len` makes. */
export function cutCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

export function isHttps(url: string): boolean {
  return HTTPS.test(url);
}

/** Whether a source names a file in the ask's home (read through `ask.attachment`). */
export function isLocalSource(source: Pick<AskSource, "kind">): boolean {
  return source.kind === "doc" || source.kind === "spec" || source.kind === "file";
}

/** A source's web address, when it has one: a ticket on Linear, a PR on GitHub, a URL. Null for local files and sessions. */
export function sourceUrl(source: Pick<AskSource, "kind" | "ref">): string | null {
  if (source.kind === "ticket" && TICKET.test(source.ref)) return `https://linear.app/broomva/issue/${source.ref}`;
  if (source.kind === "pr") {
    const pr = PR.exec(source.ref);
    return pr ? `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}` : null;
  }
  if (source.kind === "url" && isHttps(source.ref)) return source.ref;
  return null;
}

/** Whether a source's ref is well formed for its kind; the server drops one that is not. */
export function sourceShape(kind: SourceKind, ref: string): boolean {
  switch (kind) {
    case "ticket":
      return TICKET.test(ref);
    case "pr":
      return PR.test(ref);
    case "url":
      return isHttps(ref);
    case "session":
      return SESSION.test(ref);
    default:
      return safeRelative(ref);
  }
}

/** A source's chip text: its label, else its ref (a path by its file name, anchor kept). */
export function sourceText(source: AskSource): string {
  if (source.label) return source.label;
  if (isLocalSource(source)) {
    const [path, anchor] = source.ref.split("#", 2);
    const name = (path ?? source.ref).split("/").at(-1) ?? source.ref;
    return anchor ? `${name}#${anchor}` : name;
  }
  if (source.kind === "session") return `session ${source.ref.slice(0, 8)}`;
  if (source.kind === "url") return source.ref.replace(/^https:\/\//, "").replace(/\/$/, "");
  return source.ref;
}

/** The extension of a path (lowercase, with its dot), the anchor aside. */
export function extensionOf(path: string): string {
  const clean = (path.split("#", 1)[0] ?? "").toLowerCase();
  const name = clean.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};

/** A file's type by its extension; text/plain for any other. */
export function mimeOf(path: string): string {
  return MIME[extensionOf(path)] ?? "text/plain";
}

/** Whether there is anything v2 to show for an ask: a summary, a row, a source, a picture or details. */
export function hasRich(rich: RichAsk | null | undefined, optionMedia = 0): boolean {
  if (!rich) return optionMedia > 0;
  return Boolean(
    rich.summary ||
      rich.details ||
      rich.tradeoffs.length > 0 ||
      rich.sources.length > 0 ||
      rich.media.length > 0 ||
      optionMedia > 0,
  );
}

/** The tradeoff axes any row fills, in their fixed order: the table's columns. */
export function tradeoffColumns(rows: readonly TradeoffRow[]): TradeoffAxis[] {
  return TRADEOFF_AXES.filter((axis) => rows.some((row) => row[axis]));
}

/** What a media entry is called where there is no caption: its file name, or its host. */
export function mediaName(media: AskMedia): string {
  if (media.caption) return media.caption;
  if (media.path) return media.path.split("/").at(-1) ?? media.path;
  if (media.url) return media.url.replace(/^https:\/\//, "").split("/")[0] ?? media.url;
  return media.kind;
}

/** The key a client caches a fetched attachment under: the entry's hash pins it to one reading of the ask. */
export function attachmentKey(
  handle: { ledger: string; id: string; uid: string | null; hash: string; home: string },
  ref: AttachmentRef,
): string {
  return [handle.home, handle.ledger, handle.uid ?? handle.id, handle.hash, ref.list, ref.option ?? "", ref.index].join(
    "\u0000",
  );
}
