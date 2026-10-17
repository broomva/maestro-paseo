// An answer the link swallowed, as pure rules (BRO-3180 C; spec docs/specs/2026-10-17-maestro-persistence-offline.md,
// "Part C"). A send that got no reply is kept on the ask's draft (client/phone/resume.ts) as `unsent`; after the
// link is back, its fate is read from verbs.list and the ask itself. Nothing here sends: Send again is a tap.

import { z } from "zod";
import type { DecisionAsk } from "../../shared/fleet";
import type { PendingVerb, SettledVerb } from "../../shared/verbs";

/** How far before the phone's send time a verb may be stamped and still be that send's: clock skew to the Mac. */
export const SKEW_MS = 60_000;

export const UnsentSchema = z.object({
  /** The phone's clock when it was sent. */
  at: z.number(),
  /** The revision it was sent against. */
  hash: z.string(),
  /** The hold key the server files the verb under (askHoldKey), as it was when sent. */
  key: z.string(),
  error: z.string(),
});
export type Unsent = z.infer<typeof UnsentSchema>;

/**
 * Whether a failed call got no reply. Every error a server handler throws comes back as an rpc_error, which the
 * Paseo client raises with `requestType=…` on its message; one without it never reached a reply (the transport was
 * down, the send timed out, the link dropped before it went).
 */
export function gotNoReply(error: unknown): boolean {
  if (error && typeof error === "object") {
    // The Paseo client's DaemonRpcError carries the request it failed on: the server answered.
    if (typeof (error as { requestType?: unknown }).requestType === "string") return false;
    // An input or output this client could not parse is no dropped link either.
    if ((error as { name?: unknown }).name === "ZodError") return false;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return !/\brequestType=\S+/.test(message);
}

export type UnsentFate =
  /** The server holds it, waiting out its undo window. */
  | { kind: "pending"; remainingMs: number }
  /** It went through. */
  | { kind: "applied" }
  /** An answer to it reached the server and was undone or dropped there: offered again. */
  | { kind: "undone" }
  /** The ask was answered (or archived) by something else meanwhile. */
  | { kind: "closed" }
  /** Not sent: fresh reads show no answer, and the ask is as it was. */
  | { kind: "not-sent" }
  /** Not sent, and the ask changed since: the next tap only says so. */
  | { kind: "changed" }
  /** Nothing to conclude from (no fresh reads, or the ask is not in them). */
  | { kind: "unknown" };

type Ask = Pick<DecisionAsk, "ledger" | "uid" | "id" | "hash" | "state" | "home">;

/**
 * What became of an unsent answer, from fresh reads only. `verbs` is verbs.list's read (null when there is no
 * fresh one); `ask` is the ask as a trusted asks.workspace read has it (undefined when the read does not list it, or
 * is not trusted).
 */
export function fateOf(
  unsent: Unsent,
  ask: Ask | undefined,
  verbs: { pending: readonly PendingVerb[]; recent: readonly SettledVerb[] } | null,
): UnsentFate {
  if (!verbs) return { kind: "unknown" };
  // By the key the server filed it under when sent; verbs.list carries no sender, so a match is "an answer", which
  // may have come from another screen.
  const since = unsent.at - SKEW_MS;
  const ours = (verb: { verb: string; key: string; at: string }) =>
    verb.verb === "ask.answer" && verb.key === unsent.key && Date.parse(verb.at) >= since;
  const waiting = verbs.pending.filter(ours).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (waiting) return { kind: "pending", remainingMs: waiting.remainingMs };
  const settled = verbs.recent.filter(ours).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (settled?.outcome === "applied") return { kind: "applied" };
  if (!ask) return settled ? { kind: "undone" } : { kind: "unknown" };
  if (ask.state !== "open") return { kind: "closed" };
  // An ask that changed takes the two taps whichever way it got here, an undone or dropped answer included.
  if (ask.hash !== unsent.hash) return { kind: "changed" };
  return settled ? { kind: "undone" } : { kind: "not-sent" };
}

/** The card's line for an unsent answer still to send; null when the record is spent (a toast says that). */
export function unsentLine(fate: UnsentFate): string | null {
  switch (fate.kind) {
    case "undone":
      return "Not sent from here: an answer to this ask was undone. Send again when you are ready.";
    case "changed":
      return "Not sent, and this ask changed after you answered. Read it again before you send.";
    case "not-sent":
      return "Not sent: your Mac has no answer to this ask. Send again when you are ready.";
    case "unknown":
      return "Not confirmed: the link dropped before your Mac answered, so this may not have been sent. Send again when you are ready.";
    default:
      return null;
  }
}

/** What is said once when a record is spent, by the ask's title; null while it is still to send. */
export function settledText(fate: UnsentFate, title: string): string | null {
  switch (fate.kind) {
    case "pending":
      return `An answer to "${title}" reached your Mac: it applies in ${Math.max(1, Math.ceil(fate.remainingMs / 1000))} s.`;
    case "applied":
      return `An answer to "${title}" went through.`;
    case "closed":
      return `"${title}" is no longer open: nothing more was sent from this phone.`;
    default:
      return null;
  }
}

/** Whether the record is spent: the server has it, or the ask no longer needs it. */
export function isSettled(fate: UnsentFate): boolean {
  return fate.kind === "pending" || fate.kind === "applied" || fate.kind === "closed";
}
