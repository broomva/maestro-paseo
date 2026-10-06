// The cockpit's words (BRO-2837): what the fleet's records say, said plainly
// for the owner. Cut at a word, never mid-word; a name that repeats itself
// said once; ages with a space; an ask as a title and a body; the fleet's
// jargon ("no fleet key", "report only", "carry the ask forward") in words;
// and a resume command that is safe to paste. Pure, so every rule is tested.

import type { FleetAsk, FleetDetail, FleetTick } from "../shared/fleet";
import { ago, plural } from "./format";
import { timeText } from "./history-model";

// ── Words ────────────────────────────────────────────────────────────────────

/**
 * Cut at a word boundary (a space, a hyphen or a slash) at or before `max`, with an
 * ellipsis: never mid-word. A text that fits comes back as given.
 */
export function cutWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf(" "), head.lastIndexOf("-"), head.lastIndexOf("/"));
  // A cut never leaves a dangling separator ("name ·…").
  return `${(at > max * 0.4 ? head.slice(0, at) : head).replace(/[\s,;:.·-]+$/, "")}…`;
}

/**
 * A session name that repeats a run of itself (a worktree's slug, then the
 * session's own name that starts the same way) said once:
 * `sri-sti-2761-next-1633-sti-2761-next-1633-rce` → `sri-sti-2761-next-1633 · rce`.
 */
export function displayName(name: string): string {
  const tokens = name.split("-");
  let best: { j: number; k: number } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      let k = 0;
      while (j + k < tokens.length && i + k < j && tokens[i + k] === tokens[j + k]) k += 1;
      if (k >= 2 && (!best || k > best.k)) best = { j, k };
    }
  }
  if (!best) return name;
  const head = tokens.slice(0, best.j).join("-");
  const tail = tokens.slice(best.j + best.k).join("-");
  return tail ? `${head} · ${tail}` : head;
}

/** An age with a space, as the cockpit says it: `27 d`, `4 h`, `12 m`, `now`. */
export function ageWords(iso: string | null, now: number = Date.now()): string | null {
  const short = iso ? ago(iso, now) : "";
  if (!short) return null;
  return short === "now" ? "now" : short.replace(/(\d+)([mhd])$/, "$1 $2");
}

/** An ask's question as a one-line title (its first sentence, cut at a word) and the rest as its body. */
export function askLines(question: string, max = 110): { title: string; body: string | null } {
  const text = question.trim();
  // The fleet's blocked-session preamble: the session is the subject, the request is the body.
  const blocked =
    /^Session (\S+) \(([0-9a-f]{6,})\) is blocked on you:\s*(?:job file:\s*)?(?:blocked on a question to its user\s*)?(.*)$/is.exec(
      text,
    );
  if (blocked?.[1]) {
    const request = (blocked[3] ?? "")
      .replace(/^\(\s*/, "")
      .replace(/\s*\)\.?$/, "")
      .trim();
    return {
      title: `${blocked[1]} is waiting on you`,
      body: request ? `${request.charAt(0).toUpperCase()}${request.slice(1)}` : null,
    };
  }
  const end = /[.?!](\s|$)/.exec(text);
  const first = end ? text.slice(0, end.index + 1) : text;
  const sentence = first.replace(/[.:]$/, "");
  if (sentence.length <= max) return { title: sentence, body: text.slice(first.length).trim() || null };
  // Too long for a title: cut at the last clause boundary (`; `, `, `, `: `) within the limit, else a
  // word, with "…". The fleet's words are never rewritten: the body is the rest as written, from the cut,
  // never an ellipsis fragment.
  const head = sentence.slice(0, max);
  const clause = Math.max(head.lastIndexOf("; "), head.lastIndexOf(", "), head.lastIndexOf(": "));
  const kept = clause > max * 0.4 ? sentence.slice(0, clause) : cutWords(sentence, max).slice(0, -1);
  const rest = text
    .slice(kept.length)
    .replace(/^[\s,;:.-]+/, "")
    .trim();
  return { title: `${kept}…`, body: rest || null };
}

/** An ask's tag, in the owner's words: blocked on you, repo setup, an owner step. */
export function askTag(ask: Pick<FleetAsk, "class" | "className">): string {
  switch (ask.class) {
    case "7":
      return "Blocked on you";
    case "github":
      return "Repo setup";
    case "observe":
      return "Owner step";
    case "count":
      return "Count check";
    default:
      return ask.className ? ask.className.charAt(0).toUpperCase() + ask.className.slice(1) : "Fleet ask";
  }
}

/** How long an ask has waited, from the tick that raised it when that tick was read; null when it was not. */
export function askAge(ask: Pick<FleetAsk, "firstTick">, ticks: readonly FleetTick[], now: number = Date.now()) {
  const raised = ticks.find((tick) => tick.tick === ask.firstTick);
  return ageWords(raised?.at ?? null, now);
}

/** When the next tick is due, as a time: the last tick's start plus the interval; null when not scheduled. */
export function nextTickAt(schedule: FleetDetail["schedule"] | null, lastAt: string | null): number | null {
  if (!schedule?.scheduled || !schedule.intervalMinutes || !lastAt) return null;
  const last = Date.parse(lastAt);
  return Number.isFinite(last) ? last + schedule.intervalMinutes * 60_000 : null;
}

/**
 * Where an ask is in Maestro, and when it will be: the work the fleet raised,
 * or the tick that will raise it (`raised at the next tick, ~20:25`).
 */
export function askWhen(ask: Pick<FleetAsk, "item" | "batch">, next: number | null, now: number = Date.now()): string {
  if (ask.item) return ask.item.needsYou ? "In Needs you as Maestro work" : "Raised as Maestro work";
  const at = next === null ? null : next <= now ? "now due" : `~${timeText(new Date(next).toISOString())}`;
  if (ask.batch)
    return at ? `Not in Maestro yet: raised at the next tick, ${at}.` : "Not in Maestro yet: raised when a tick runs.";
  return at
    ? `Not in Maestro yet: raised once it lasts; the next tick is ${at}.`
    : "Not in Maestro yet: raised once it lasts, when a tick runs.";
}

/** A canonical session UUID (8-4-4-4-12 hex): nothing else is ever put in a command. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A word for a POSIX shell, single-quoted: nothing in it is expanded; a `'` is closed, escaped and reopened. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * The command that resumes a Claude session where it ran, safe to paste: the
 * folder is always single-quoted, and only a leading `~/` (or a bare `~`) is
 * written as "$HOME" outside the quotes. Null without a canonical UUID or a
 * folder.
 */
export function resumeCommand(sessionId: string | null, cwd: string | null): string | null {
  if (!sessionId || !cwd || !UUID.test(sessionId)) return null;
  const folder =
    cwd === "~" ? '"$HOME"' : cwd.startsWith("~/") ? `"$HOME"/${shellQuote(cwd.slice(2))}` : shellQuote(cwd);
  return `cd ${folder} && claude --resume ${sessionId.toLowerCase()}`;
}

/**
 * A path in a narrow column: whole when it fits, else its head (`~` or the
 * first folder), an ellipsis and its last folder, the last cut at a word if
 * it alone is too long. The end of a path is the part that tells two apart.
 */
export function middlePath(path: string | null, max: number): string | null {
  if (!path) return null;
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? path;
  const head = path.startsWith("~") ? "~" : path.startsWith("/") ? "" : (parts[0] ?? "");
  const lead = `${head}/…/`;
  return last.length + lead.length <= max ? `${lead}${last}` : `…/${cutWords(last, Math.max(8, max - 2))}`;
}

/**
 * The fleet's evidence, said plainly: "no fleet key, not adopted" is "not
 * managed by the fleet". Anything else is the fleet's own words.
 */
export function plainEvidence(evidence: string | null): string | null {
  if (!evidence) return null;
  return evidence
    .replace(/no fleet key, not adopted \(Paseo agent\)/g, "not managed by the fleet (a Paseo agent)")
    .replace(/no fleet key, not adopted/g, "not managed by the fleet");
}

/** "Report", once: what the fleet does when it reports a session. */
export const REPORT_MEANS = "Report: the fleet lists the session in its tick report; nothing is done to it.";

/**
 * What the fleet would do, plainly: `report only` and `report` list it in the
 * report, the limit-reset rule and carrying an ask said in words.
 */
export function plainAction(action: string | null): string {
  if (!action || action === "nothing") return "Nothing";
  if (action === "report only" || action === "report") return "List it in the report";
  if (/^report; no spawns in the scope until the reset/.test(action)) {
    return "List it; no new sessions until the usage limit resets";
  }
  if (action === "carry the ask forward") return "Keep asking you";
  return action.charAt(0).toUpperCase() + action.slice(1);
}

/**
 * A step's words from tick.log, plain: `0 answer(s) read back from Maestro,
 * 0 batch(es) raised, …` → `no answers to read, nothing raised`.
 */
export function plainStep(name: string, words: string): string {
  const n = (pattern: RegExp) => Number(pattern.exec(words)?.[1] ?? Number.NaN);
  if (name === "recover") {
    const closed = n(/(\d+) open intent/);
    if (Number.isFinite(closed)) return closed === 0 ? "nothing to recover" : `${plural(closed, "open intent")} closed`;
  }
  if (name === "ask") {
    const answers = n(/(\d+) answer/);
    const raised = n(/(\d+) batch/);
    const open = n(/(\d+) open ask/);
    if (Number.isFinite(answers) && Number.isFinite(raised)) {
      const parts = [
        answers === 0 ? "no answers to read" : `${plural(answers, "answer")} read`,
        raised === 0 ? "nothing raised" : `${plural(raised, "ask")} raised`,
        Number.isFinite(open) && open > 0 ? `${open} open` : null,
      ];
      return parts.filter(Boolean).join(", ");
    }
  }
  if (/^not run\b/.test(words)) return cutWords(words.split(":")[0] ?? words, 60);
  // Anything else: the fleet's `(s)` and `(es)` plurals said plainly.
  return words
    .replace(/\b(\d+) (\w+)\((e?s)\)/g, (_, count: string, word: string, end: string) =>
      count === "1" ? `1 ${word}` : count === "0" ? `no ${word}${end}` : `${count} ${word}${end}`,
    )
    .trim();
}

/** How the fleet placed a session in a scope, in words. */
export function placedWords(placement: string | null): string | null {
  switch (placement) {
    case null:
      return null;
    case "cwd":
      return "by its folder";
    case "worktree-parent":
      return "by its worktree's parent";
    case "board":
      return "by the board";
    case "unplaced":
      return "not placed";
    default:
      return placement;
  }
}

/** A session's last activity: its date and age, "active now" while it runs with none recorded, else null. */
export function activeWords(activeAt: string | null, running: boolean, now: number = Date.now()): string | null {
  if (activeAt) return `${activeAt.slice(0, 10)} · ${ago(activeAt, now)} ago`;
  return running ? "active now" : null;
}

/**
 * The report's evidence for a session as a sentence a person reads; the raw
 * text stays in the inspector's Details.
 */
export function evidenceSentence(evidence: string | null): string {
  if (!evidence) return "The report gives no evidence for it.";
  const text = evidence.trim();
  const listing = /^listing: state (\w+)/.exec(text);
  if (listing?.[1]) return `Its session listing says it ${listing[1] === "failed" ? "failed" : `is ${listing[1]}`}.`;
  const job = /^job file:\s*(.+)$/s.exec(text);
  if (job?.[1]) return `Its job file says: ${job[1].replace(/\.?$/, ".")}`;
  const busy = /^busy; last activity (\d+)s ago/.exec(text);
  if (busy?.[1]) return `It was working, last active ${busy[1]} s before the report.`;
  if (/^no fleet key, not adopted/.test(text)) {
    return `The fleet does not manage it${/Paseo agent/.test(text) ? "; it is a Paseo agent" : ""}.`;
  }
  const placed = /^placed in scope (\S+) by (\S+)/.exec(text);
  if (placed?.[1]) return `Placed in ${placed[1]} ${placedWords(placed[2] ?? null) ?? ""}.`.replace(" .", ".");
  if (/^cwd gone/.test(text)) return "Its folder is gone, and nothing places it in a scope.";
  return (plainEvidence(text) ?? text).replace(/^./, (c) => c.toUpperCase());
}
