// Decision layer v2 on the server (BRO-3167): an ask's summary, tradeoffs,
// sources, media and details read from its ledger entry, and the one way a
// local file an ask names reaches a client.
//
// Reading is lenient where the validator (workspace scripts/ask_ledger.py) is
// strict: an entry Maestro could not show is dropped and the rest are shown, so
// one bad row never hides an ask. The caps are the validator's.
//
// A local file is read only when you look (`ask.attachment`), and only if:
// - the ask names it, by position (the client sends the ask's handle and the
//   attachment's index, never a path);
// - its path is repo-relative and stays in the repo (no `/`, `~`, `..`, scheme);
// - its extension is one its kind allows (media), or any for a doc it cites;
// - it is under its kind's size cap.
// From origin/main it is the blob at that ref (`git cat-file`, never a working
// tree). From a checkout or a fleet root it is a regular file whose real path is
// inside the home's real path, so a link cannot lead out.

import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { AskHome, DecisionAsk } from "../shared/fleet";
import {
  type AskAttachment,
  type AskMedia,
  type AskSource,
  type AttachmentRef,
  extensionOf,
  isHttps,
  isLocalSource,
  MEDIA_EXTENSIONS,
  MEDIA_KINDS,
  MEDIA_MAX_BYTES,
  type MediaKind,
  mimeOf,
  type RichAsk,
  SOURCE_KINDS,
  SOURCE_TEXT_MAX_BYTES,
  type SourceKind,
  safeRelative,
  sourceShape,
  TRADEOFF_AXES,
  type TradeoffRow,
} from "../shared/rich-ask";
import { UserError } from "./engine";
import { catFiles, git, MAIN_REF } from "./git";

/** The validator's caps (ask_ledger.py): an entry past them is not shown. */
export const MEDIA_ASK_MAX = 6;
export const MEDIA_OPTION_MAX = 4;
const SOURCES_MAX = 10;
const TRADEOFF_ROWS_MAX = 8;
const SUMMARY_MAX = 700;
const DETAILS_MAX = 8000;
const CELL_MAX = 160;
const CAPTION_MAX = 120;

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function words(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value.trim();
  return flat.length > 0 && flat.length <= max ? flat : null;
}

/** An ask's (or an option's) media, as Maestro can show them: at most `cap`, each with one https URL or one safe path. */
export function mediaOf(raw: unknown, cap: number): AskMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRow)
    .flatMap((entry): AskMedia[] => {
      const kind = entry.kind as MediaKind;
      if (!MEDIA_KINDS.includes(kind)) return [];
      const path = typeof entry.path === "string" ? entry.path.trim() : null;
      const url = typeof entry.url === "string" ? entry.url.trim() : null;
      if ((path === null) === (url === null)) return [];
      if (url !== null && !isHttps(url)) return [];
      if (path !== null && (!safeRelative(path) || !MEDIA_EXTENSIONS[kind].includes(extensionOf(path)))) return [];
      return [{ kind, path, url, caption: words(entry.caption, CAPTION_MAX) }];
    })
    .slice(0, cap);
}

function sourcesOf(raw: unknown): AskSource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRow)
    .flatMap((entry): AskSource[] => {
      const kind = entry.kind as SourceKind;
      const ref = typeof entry.ref === "string" ? entry.ref.trim() : "";
      if (!SOURCE_KINDS.includes(kind) || !sourceShape(kind, ref)) return [];
      return [{ kind, ref, label: words(entry.label, 80) }];
    })
    .slice(0, SOURCES_MAX);
}

function tradeoffsOf(raw: unknown, optionIds: ReadonlySet<string>): TradeoffRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRow)
    .flatMap((entry): TradeoffRow[] => {
      const option = typeof entry.option === "string" || typeof entry.option === "number" ? String(entry.option) : null;
      const label = words(entry.label, 60);
      if ((option === null) === (label === null)) return [];
      if (option !== null && !optionIds.has(option)) return [];
      const cells = Object.fromEntries(TRADEOFF_AXES.map((axis) => [axis, words(entry[axis], CELL_MAX)])) as Record<
        (typeof TRADEOFF_AXES)[number],
        string | null
      >;
      if (TRADEOFF_AXES.every((axis) => cells[axis] === null)) return [];
      return [{ option, label, ...cells }];
    })
    .slice(0, TRADEOFF_ROWS_MAX);
}

/** An ask's v2 fields, or null when it carries none (an option's media alone rides on the option). */
export function richOf(row: Row, optionIds: ReadonlySet<string>): RichAsk | null {
  const rich: RichAsk = {
    summary: words(row.summary, SUMMARY_MAX),
    tradeoffs: tradeoffsOf(row.tradeoffs, optionIds),
    sources: sourcesOf(row.sources),
    media: mediaOf(row.media, MEDIA_ASK_MAX),
    details: typeof row.details === "string" && row.details.trim() ? row.details.slice(0, DETAILS_MAX) : null,
  };
  const empty = !rich.summary && !rich.details && !rich.tradeoffs.length && !rich.sources.length && !rich.media.length;
  return empty ? null : rich;
}

// ── Reading a file an ask names ──────────────────────────────────────────────

/** What the ask names at `ref`: a media entry or a local source, else a refusal in words. */
export function attachmentOf(
  ask: Pick<DecisionAsk, "id" | "rich" | "options">,
  ref: AttachmentRef,
): { path: string; kind: MediaKind | "doc" } {
  if (ref.list === "media") {
    const list = ref.option === null ? (ask.rich?.media ?? []) : ask.options.find((o) => o.id === ref.option)?.media;
    const media = list?.[ref.index];
    if (!media) throw new UserError(`The ask ${ask.id} has no such picture or video any more. Look at it again.`);
    if (!media.path) throw new UserError("That media is a web address; it opens in your browser.");
    return { path: media.path, kind: media.kind };
  }
  if (ref.option !== null) throw new UserError("Sources belong to the ask, not to an option.");
  const source = ask.rich?.sources[ref.index];
  if (!source) throw new UserError(`The ask ${ask.id} has no such source any more. Look at it again.`);
  if (!isLocalSource(source)) throw new UserError("That source is a link, not a file; it opens in your browser.");
  return { path: source.ref.split("#", 1)[0] ?? source.ref, kind: "doc" };
}

/** The folder a home's repo-relative paths start from: a checkout or main's repo, or a fleet root's `<dir>/.control/asks` parent's parent. */
export function baseOf(home: AskHome): string {
  return home.kind === "root" ? dirname(dirname(home.path)) : home.path;
}

const capOf = (kind: MediaKind | "doc") => (kind === "doc" ? SOURCE_TEXT_MAX_BYTES : MEDIA_MAX_BYTES[kind]);
const tooBig = (path: string, size: number, cap: number) =>
  new UserError(`${path} is ${Math.round(size / 1024)} KB, over the ${Math.round(cap / 1024)} KB Maestro shows.`);

/** A file's bytes from a checkout or a fleet root: a regular file, its real path inside the base's. */
export async function readInside(base: string, path: string, cap: number): Promise<Buffer> {
  if (!safeRelative(path)) throw new UserError(`${path} is not a path inside the repo.`);
  const root = await realpath(base).catch(() => null);
  if (!root) throw new UserError(`The ask's home ${base} is gone.`);
  const full = join(root, path);
  const real = await realpath(full).catch(() => null);
  if (!real) throw new UserError(`${path} is not in ${base}.`);
  if (real !== root && !real.startsWith(root + sep)) throw new UserError(`${path} leads outside ${base}; not shown.`);
  const info = await lstat(real);
  if (!info.isFile()) throw new UserError(`${path} is not a file.`);
  if (info.size > cap) throw tooBig(path, info.size, cap);
  return readFile(real);
}

/** A file's bytes from origin/main: the blob at that ref, size-checked first. */
export async function readOnMain(repo: string, path: string, cap: number): Promise<Buffer> {
  if (!safeRelative(path)) throw new UserError(`${path} is not a path inside the repo.`);
  const spec = `${MAIN_REF}:${path}`;
  const size = Number((await git(repo, ["cat-file", "-s", spec]).catch(() => "")).trim());
  if (!Number.isFinite(size) || size <= 0) throw new UserError(`${path} is not on ${MAIN_REF}.`);
  if (size > cap) throw tooBig(path, size, cap);
  const bytes = (await catFiles(repo, [spec])).get(spec);
  if (!bytes) throw new UserError(`${path} is not on ${MAIN_REF}.`);
  return bytes;
}

/** A GitHub web address for a file on origin/main, when origin is GitHub; else null. */
export async function webUrlOf(repo: string, path: string): Promise<string | null> {
  const origin = (await git(repo, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  const slug = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)?.[1];
  return slug ? `https://github.com/${slug}/blob/main/${path.split("/").map(encodeURIComponent).join("/")}` : null;
}

/**
 * An HTML file made safe to draw in a sandboxed frame: a policy that loads nothing from anywhere (no script, no
 * network) except inline styles and inline images. The frame's own sandbox also refuses scripts; this is the
 * second lock, and it stops a remote image from telling anyone you looked.
 */
export function lockedHtml(html: string): string {
  const policy =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">";
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${policy}`) : `${policy}${html}`;
}

/** The file an ask names at `ref`, read from its home. */
export async function readAttachment(
  ask: Pick<DecisionAsk, "id" | "rich" | "options" | "home">,
  ref: AttachmentRef,
): Promise<AskAttachment> {
  const { path, kind } = attachmentOf(ask, ref);
  const cap = capOf(kind);
  const bytes =
    ask.home.kind === "main"
      ? await readOnMain(ask.home.path, path, cap)
      : await readInside(baseOf(ask.home), path, cap);
  const mime = mimeOf(path);
  const webUrl = ask.home.kind === "main" ? await webUrlOf(ask.home.path, path) : null;
  if (kind === "image" || kind === "svg" || kind === "video") {
    return { mime, dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, text: null, webUrl };
  }
  const text = bytes.toString("utf8");
  return { mime, dataUrl: null, text: mime === "text/html" ? lockedHtml(text) : text, webUrl };
}
