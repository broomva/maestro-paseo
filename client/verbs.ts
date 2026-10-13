// Every verb J1 and its inspector invoke goes through this one module (BRO-3035): allow, deny,
// answer, skip, done and not now on a hold; open, unblock and cancel on watched work; file and
// dismiss on a proposal. `planVerb` decides, purely, which call a verb makes for its target, so
// each mapping is tested (client/verbs.test.ts); `useVerbs` makes the call and says what it did.
//
// BRO-2999: every approval is `approval.decide` against the exact action the row shows (and, for a
// permission prompt, the request id it names): recorded, applied 8 s later by the server, receipted. Continue
// is `session.prompt`. Nothing here answers a prompt on Paseo itself (client/no-direct-permission.test.ts).
// work.verdict approve is refused by the server; Change course is the item's own form (a send back with a note).
//
// Every verb that changes state leaves a receipt and an undo, inside UNDO_MS (B4): the toast's receipt is
// `<channel>:<value>`, which `undo` reads back. `verb:<receipt>` is the server's ledger (and a decision at the
// gate); `work:` and `conductor:` read as before. A verb that changes nothing (Open, Skip) says what it did.

import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { decideConductor, undoConductor } from "../shared/answers";
import { cancelWork, dispatchWork, stopWork, unblockWork, undoWork, type WorkItem } from "../shared/contracts";
import { type AnswerInput, answerAsk, type DecisionAsk } from "../shared/fleet";
import { REVIEW_ANSWERS, type ReviewAnswer, reviewInitiative } from "../shared/initiatives";
import { holdOf, type NeedRow } from "../shared/needs";
import { SNOOZE_HOURS, snoozeNotice } from "../shared/notices";
import { decideApproval as decideApprovalRpc, promptSession as promptSessionRpc, undoVerb } from "../shared/verbs";
import { whereOf } from "./decisions-model";
import { invalidateNeeds, useRefresh } from "./hooks";
import type { MaestroIntent } from "./intent";

export const VERB_IDS = [
  "allow",
  "deny",
  "answer",
  "skip",
  "done",
  "later",
  "snooze",
  "open",
  "unblock",
  "cancel",
  "file",
  "dismiss",
  "continue",
  "course",
  "prompt",
  "stop",
] as const;
export type VerbId = (typeof VERB_IDS)[number];

/** What a verb acts on: a hold (needs.list's row), watched work, or a proposal (an answer for the conductor). */
export interface VerbTarget {
  row?: NeedRow | null;
  /** The work item the hold or row is, when this client has it. */
  item?: WorkItem | null;
  /** The decision ask the hold is, when this client has it. */
  ask?: DecisionAsk | null;
  /** A proposal's conductor key (DecisionAsk.fate.key). */
  proposal?: string | null;
  /** A notice (notices.list's row): what Snooze quiets. */
  notice?: { key: string } | null;
  /** A session with no work or hold of its own to name it: the session page's prompt box (K2). */
  agentId?: string | null;
}

/** The call a verb makes. Pure data: `useVerbs` runs it. */
export type VerbPlan =
  /** Allow or Deny one held action: approval.decide, bound to the exact action (and prompt) the row shows. */
  | { call: "decide"; key: string; allow: boolean; action: string; requestId?: string; done: string }
  /** The prompt the card showed is not the session's prompt now: nothing is answered, and everything is read again. */
  | { call: "stale"; done: string }
  /** Send a prompt to an existing session (session.prompt): Continue. Never creates one (A8). */
  | { call: "prompt"; agentId: string; prompt: string; key: string; done: string }
  | {
      call: "answer";
      ask: DecisionAsk;
      /** The option taken; null when you answered in your own words alone. */
      option: string | null;
      /** Your words, with or without an option. */
      note: string;
      done: string;
    }
  | { call: "dispatch"; id: string; done: string }
  | { call: "unblock"; id: string; note: string; done: string }
  | { call: "cancel"; id: string; done: string }
  /** Stop a run: its session is archived and the work is stuck, with the branch kept. Refused while it holds uncommitted work. */
  | { call: "stop"; id: string; done: string }
  | { call: "conductor"; key: string; verb: "file" | "dismiss"; done: string }
  | { call: "snooze"; key: string; done: string }
  /** Your answer to a due initiative review (B2, J8): keep, park or close, recorded as a receipt after the window. */
  | { call: "review"; id: string; date: string; answer: ReviewAnswer; note: string; done: string }
  | { call: "url"; url: string; done: string }
  | { call: "session"; agentId: string; done: string }
  /**
   * Somewhere else in Maestro does it (Decisions, Initiatives, the item): nothing changes here. `draft` is what you
   * had chosen and typed, carried there so the deliberate confirm starts from it instead of from nothing.
   */
  | { call: "go"; intent: MaestroIntent; done: string; draft?: { chosen: string | null; note: string } }
  /** Nothing changes: it stays where it is (Skip, Not now). */
  | { call: "stay"; done: string }
  /** No call exists for it yet; `why` says which ticket brings one. */
  | { call: "unavailable"; why: string };

/** A hold's PR or path, when its owner step names a link. */
function urlOf(where: string): string | null {
  return /^https?:\/\//.test(where) ? where : null;
}

/**
 * Every approval is decided here (BRO-2999): `approval.decide` against the exact action the row shows. A permission
 * prompt also names its request id, taken from the same read as its action, never from work.list's: a session that
 * raised another prompt between the two reads is not approved (the plan is `stale`, and everything is read again).
 */
export function decideApproval(
  row: Extract<NeedRow, { kind: "approval" }>,
  item: WorkItem | null,
  allow: boolean,
): VerbPlan {
  const hold = holdOf(row.key);
  const done = allow ? "Allowed" : "Denied";
  if (hold?.kind === "approval") return { call: "decide", key: row.key, allow, action: row.body.action, done };
  if (hold?.kind !== "work") return { call: "unavailable", why: "Only a held action is allowed or denied." };
  const requestId = row.body.requestId ?? null;
  if (!requestId) {
    return {
      call: "go",
      intent: { kind: "select", id: hold.id },
      done: "Opened the item: its prompt is not read yet",
    };
  }
  if (item && item.permission?.requestId !== requestId) {
    return { call: "stale", done: "That prompt changed: reading it again" };
  }
  return { call: "decide", key: row.key, allow, action: row.body.action, requestId, done };
}

/** Continue prompts the session (session.prompt); a session that is gone, or none, has nothing to prompt. */
export function promptSession(agentId: string | null, key: string, prompt: string, done = "Sent: continue"): VerbPlan {
  if (!agentId) return { call: "unavailable", why: "It has no session to prompt." };
  if (!prompt) return { call: "unavailable", why: "Say what to send." };
  return { call: "prompt", agentId, prompt, key, done };
}

/**
 * The call `verb` makes on `target`. `choice` is the option an ask's or a review's inspector holds, and
 * `words` what you typed beside it (an answer's words, a prompt sent with Unblock). `confirmed` is a screen that has
 * asked twice (the phone's deck, which has no Decisions card beside it): an answer that cannot be undone is then sent. Pure.
 */
export function planVerb(verb: VerbId, target: VerbTarget, choice?: string, words = "", confirmed = false): VerbPlan {
  const { row = null, item = null, ask = null } = target;
  const hold = row ? holdOf(row.key) : null;
  switch (verb) {
    case "allow":
    case "deny":
      if (row?.kind !== "approval") return { call: "unavailable", why: "Only an approval is allowed or denied." };
      return decideApproval(row, item, verb === "allow");
    case "answer": {
      if (hold?.kind === "review") {
        const answer = REVIEW_ANSWERS.find((one) => one === choice);
        // With no answer chosen, it opens where the review is handled; chosen, it is the review's answer.
        if (!answer || row?.kind !== "ask" || !("initiative" in row.body))
          return { call: "go", intent: { kind: "initiatives" }, done: "Opened Initiatives" };
        return {
          call: "review",
          id: row.body.initiative,
          date: row.body.date,
          answer,
          note: words.trim(),
          done: `Review of ${row.body.initiative}: ${answer}`,
        };
      }
      if (hold?.kind === "answers") return { call: "go", intent: { kind: "decisions" }, done: "Opened Decisions" };
      if (row?.kind !== "ask") return { call: "unavailable", why: "Only an ask is answered." };
      const decisions: MaestroIntent = ask
        ? { kind: "decisions", ledger: null, id: ask.id, key: hold?.kind === "ask" ? hold.askKey : null }
        : { kind: "decisions" };
      const option = ask?.options.find((entry) => entry.id === choice) ?? null;
      const note = words.trim();
      // An answer that cannot be undone takes Decisions' deliberate confirm; so does one this client cannot send,
      // and an answer with nothing chosen and nothing said.
      if (!ask || (option?.reversible === false && !confirmed) || (!option && !note))
        return {
          call: "go",
          intent: decisions,
          done: "Opened it in Decisions",
          ...(ask && (option || note) ? { draft: { chosen: option?.id ?? null, note } } : {}),
        };
      return {
        call: "answer",
        ask,
        option: option?.id ?? null,
        note,
        done: option ? `Answered: ${option.label}` : "Answered in your words",
      };
    }
    case "done": {
      if (row?.kind !== "owner_step") return { call: "unavailable", why: "Only an owner step is done." };
      if (hold?.kind === "work") return { call: "dispatch", id: hold.id, done: "Started" };
      const url = urlOf(row.body.where);
      if (url) return { call: "url", url, done: "Opened its PR" };
      return { call: "go", intent: { kind: "decisions" }, done: "Opened Decisions" };
    }
    case "skip":
    case "later":
      return { call: "stay", done: "Left in Needs you" };
    case "snooze":
      if (!target.notice) return { call: "unavailable", why: "Only a notice is snoozed." };
      return { call: "snooze", key: target.notice.key, done: `Snoozed for ${SNOOZE_HOURS} h` };
    case "open": {
      const agentId = item?.worker?.agentId ?? row?.session?.agentId ?? null;
      if (agentId) return { call: "session", agentId, done: "Opened the session" };
      if (item) return { call: "go", intent: { kind: "select", id: item.id }, done: "Opened the item" };
      return { call: "unavailable", why: "It has no session." };
    }
    case "unblock":
      if (item?.state !== "blocked") return { call: "unavailable", why: "Only stuck work is unblocked." };
      return { call: "unblock", id: item.id, note: words.trim(), done: "Unblocked" };
    case "cancel":
      if (!item) return { call: "unavailable", why: "Only work is canceled." };
      return { call: "cancel", id: item.id, done: "Canceled" };
    case "stop":
      if (item?.state !== "running" && item?.state !== "review")
        return { call: "unavailable", why: "Only a run that is going is stopped." };
      return { call: "stop", id: item.id, done: "Stopped the run" };
    case "file":
    case "dismiss":
      if (!target.proposal) return { call: "unavailable", why: "Only a proposal is filed or dismissed." };
      return { call: "conductor", key: target.proposal, verb, done: verb === "file" ? "Filed as work" : "Dismissed" };
    case "course": {
      // Finished work at your gate: your note goes to its session as a prompt, which reopens it (session.prompt, with
      // its 8 s window). The work's own revise verdict is retired (A8): nothing here decides on the work.
      if (item?.state !== "review") return { call: "unavailable", why: "Only work at your gate changes course." };
      if (!words.trim()) return { call: "unavailable", why: "Say what should change." };
      return promptSession(
        item.worker?.agentId ?? null,
        `work:${item.id}`,
        `Change of course: ${words.trim()}`,
        "Changed course",
      );
    }
    case "prompt":
      // Your own words to a session; the key (when it has one) is what the receipt belongs to.
      return promptSession(
        target.agentId ?? item?.worker?.agentId ?? row?.session?.agentId ?? null,
        row?.key ?? (item ? `work:${item.id}` : `session:${target.agentId ?? ""}`),
        words.trim(),
        "Sent",
      );
    case "continue":
      return promptSession(
        item?.worker?.agentId ?? row?.session?.agentId ?? null,
        row?.key ?? (item ? `work:${item.id}` : ""),
        "Continue where you stopped. End with the Decided and Ask sections.",
      );
  }
}

/** What a verb did: its words, and the receipt Undo takes while `appliesAt` has not passed. */
export interface VerbOutcome {
  done: string;
  /** `<channel>:<value>` (undoVerb reads it); absent when the call has no undo. */
  receipt?: string;
  appliesAt?: string;
  /** Somewhere the screen should go (Decisions, the item). */
  go?: MaestroIntent;
  /** What you had chosen and typed, for the place `go` names to start from. */
  draft?: { chosen: string | null; note: string };
  /** Resolves once needs.list and every Maestro read have been read again after the call. */
  settled: Promise<void>;
}

/** What a plan may need from the screen: a link opened, a session opened (the host's navigation). */
export interface VerbEnv {
  openUrl(url: string): void;
  openAgent(agentId: string): void;
}

/**
 * How long after a verb answers its effect can be read: the verb takes effect when its window closes (8 s, B4),
 * so what the screen shows (Needs you, the work's state) changes then, not when the call returned. A beat past
 * `appliesAt`, so the server has applied it. Pure.
 */
export function settleDelay(appliesAt: string | undefined, now: number): number | null {
  const at = appliesAt ? Date.parse(appliesAt) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, at - now) + 700 : null;
}

/** A receipt the toast hands back: which undo it takes, and its value. */
export function receiptOf(value: string): { channel: "work" | "conductor" | "verb"; value: string } | null {
  const at = value.indexOf(":");
  const channel = value.slice(0, at);
  const rest = value.slice(at + 1);
  if (at < 0 || !rest) return null;
  return channel === "work" || channel === "conductor" || channel === "verb" ? { channel, value: rest } : null;
}

/** Runs a plan: one hook for the screen, every verb's call in one place. */
export function useVerbs() {
  const client = useQueryClient();
  const refresh = useRefresh();
  const rpc = {
    approval: useRpc(decideApprovalRpc),
    prompt: useRpc(promptSessionRpc),
    undoVerb: useRpc(undoVerb),
    dispatch: useRpc(dispatchWork),
    unblock: useRpc(unblockWork),
    cancel: useRpc(cancelWork),
    stop: useRpc(stopWork),
    undo: useRpc(undoWork),
    answer: useRpc(answerAsk),
    snooze: useRpc(snoozeNotice),
    review: useRpc(reviewInitiative),
    conductor: useRpc(decideConductor),
    conductorUndo: useRpc(undoConductor),
  };
  // Every call settles by reading again: needs.list and handled.list at once, and every Maestro read.
  const settle = (): Promise<void> => {
    invalidateNeeds(client);
    return refresh().then(() => undefined);
  };
  const perform = async (plan: VerbPlan, env: VerbEnv): Promise<Omit<VerbOutcome, "settled">> => {
    switch (plan.call) {
      case "decide": {
        const { receipt, appliesAt } = await rpc.approval({
          key: plan.key,
          allow: plan.allow,
          action: plan.action,
          ...(plan.requestId ? { requestId: plan.requestId } : {}),
        });
        return { done: plan.done, receipt: `verb:${receipt}`, appliesAt };
      }
      case "prompt": {
        const { receipt, appliesAt } = await rpc.prompt({ agentId: plan.agentId, prompt: plan.prompt, key: plan.key });
        return { done: plan.done, receipt: `verb:${receipt}`, appliesAt };
      }
      case "answer": {
        const { warning, receipt, appliesAt } = await rpc.answer({
          where: whereOf(plan.ask),
          ledger: plan.ask.ledger,
          uid: plan.ask.uid,
          id: plan.ask.id,
          hash: plan.ask.hash,
          option: plan.option,
          note: plan.note,
        });
        const done = warning ? `${plan.done} · ${warning}` : plan.done;
        return receipt ? { done, receipt: `verb:${receipt}`, appliesAt } : { done };
      }
      case "dispatch":
        await rpc.dispatch({ id: plan.id });
        return { done: plan.done };
      case "unblock": {
        const { receipt, appliesAt } = await rpc.unblock({ id: plan.id, note: plan.note });
        return receipt ? { done: plan.done, receipt: `verb:${receipt}`, appliesAt } : { done: plan.done };
      }
      case "cancel": {
        // Every cancel waits its 8 s: at your gate on the work's own decision, elsewhere in the ledger.
        const { receipt, appliesAt } = await rpc.cancel({ id: plan.id });
        return receipt ? { done: plan.done, receipt: `verb:${receipt}`, appliesAt } : { done: plan.done };
      }
      case "snooze": {
        const { receipt, appliesAt } = await rpc.snooze({ key: plan.key, hours: SNOOZE_HOURS });
        return { done: plan.done, receipt: `verb:${receipt}`, appliesAt };
      }
      case "review": {
        const { receipt, appliesAt } = await rpc.review({
          id: plan.id,
          date: plan.date,
          answer: plan.answer,
          note: plan.note,
        });
        return { done: plan.done, receipt: `verb:${receipt}`, appliesAt };
      }
      case "stop": {
        const { receipt, appliesAt } = await rpc.stop({ id: plan.id });
        return receipt ? { done: plan.done, receipt: `verb:${receipt}`, appliesAt } : { done: plan.done };
      }
      case "conductor": {
        const { receipt, appliesAt } = await rpc.conductor({ key: plan.key, verb: plan.verb });
        return { done: plan.done, receipt: `conductor:${receipt}`, appliesAt };
      }
      case "url":
        env.openUrl(plan.url);
        return { done: plan.done };
      case "session":
        env.openAgent(plan.agentId);
        return { done: plan.done };
      case "go":
        return { done: plan.done, go: plan.intent, ...(plan.draft ? { draft: plan.draft } : {}) };
      case "stay":
        return { done: plan.done };
      case "stale":
        return { done: plan.done };
      case "unavailable":
        throw new Error(plan.why);
    }
  };
  return {
    /**
     * Your answer to a decision ask, as the Decisions tab sends it (the card keeps its own in-flight, confirm and
     * draft): the one place the call is made, so every answer is the adapter's. Its reply is the ask as it stands
     * and, with a receipt, when it is written (B4).
     */
    answer: (input: AnswerInput) => rpc.answer(input),
    /**
     * Make the plan's call. Rejects with the call's error; `unavailable` rejects with its reason. The outcome's
     * `settled` resolves once everything has been read again, so a screen can hold a hold still until then.
     */
    async run(plan: VerbPlan, env: VerbEnv): Promise<VerbOutcome> {
      const reads = plan.call !== "go" && plan.call !== "stay" && plan.call !== "url" && plan.call !== "session";
      let outcome: Omit<VerbOutcome, "settled">;
      try {
        outcome = await perform(plan, env);
      } catch (error) {
        if (reads) void settle();
        throw error;
      }
      // It takes effect when its window closes: read everything again then, so the hold leaves Needs you on time.
      const later = settleDelay(outcome.appliesAt, Date.now());
      if (later !== null) setTimeout(() => void settle(), later);
      return { ...outcome, settled: reads ? settle() : Promise.resolve() };
    },
    /** Take a verb back by its receipt, inside its window. */
    async undo(receipt: string): Promise<void> {
      const read = receiptOf(receipt);
      if (!read) return;
      try {
        if (read.channel === "work") await rpc.undo({ id: read.value });
        else if (read.channel === "verb") await rpc.undoVerb({ receipt: read.value });
        else await rpc.conductorUndo({ receipt: read.value });
      } finally {
        void settle();
      }
    },
  };
}
