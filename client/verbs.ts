// Every verb J1 and its inspector invoke goes through this one module (BRO-3035): allow, deny,
// answer, skip, done and not now on a hold; open, unblock and cancel on watched work; file and
// dismiss on a proposal. `planVerb` decides, purely, which call a verb makes for its target, so
// each mapping is tested (client/verbs.test.ts); `useVerbs` makes the call and says what it did.
//
// BRO-2999 retires Approve and adds approval.decide and session.prompt at the same time as this
// module lands. Its two seams are marked "BRO-2999": every approval goes through
// `decideApproval`, and Continue and Change course through `promptSession`. Until then they call
// what exists today: the session's permission prompt (Paseo's respondToPermission) for a prompt,
// work.verdict for a hold at Maestro's own gate, and nothing for a prompt to a session.
//
// A verb that leaves a receipt carries an undo, inside UNDO_MS (B4): the toast's receipt is
// `<channel>:<value>`, which `undoVerb` reads back. A verb whose call has no undo yet (an answer,
// a permission prompt) says what it did and leaves the toast's Undo out.

import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { decideConductor, undoConductor } from "../shared/answers";
import { cancelWork, decideWork, dispatchWork, unblockWork, undoWork, type WorkItem } from "../shared/contracts";
import { answerAsk, type DecisionAsk } from "../shared/fleet";
import { holdOf, type NeedRow } from "../shared/needs";
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
}

/** The call a verb makes. Pure data: `useVerbs` runs it. */
export type VerbPlan =
  | { call: "permission"; agentId: string; requestId: string; allow: boolean; done: string }
  | { call: "verdict"; id: string; verdict: "approve" | "revise"; note: string; done: string }
  | {
      call: "answer";
      ask: DecisionAsk;
      option: string;
      done: string;
    }
  | { call: "dispatch"; id: string; done: string }
  | { call: "unblock"; id: string; done: string }
  | { call: "cancel"; id: string; done: string }
  | { call: "conductor"; key: string; verb: "file" | "dismiss"; done: string }
  | { call: "url"; url: string; done: string }
  | { call: "session"; agentId: string; done: string }
  /** Somewhere else in Maestro does it (Decisions, Initiatives, the item): nothing changes here. */
  | { call: "go"; intent: MaestroIntent; done: string }
  /** Nothing changes: it stays where it is (Skip, Not now). */
  | { call: "stay"; done: string }
  /** No call exists for it yet; `why` says which ticket brings one. */
  | { call: "unavailable"; why: string };

/** A hold's PR or path, when its owner step names a link. */
function urlOf(where: string): string | null {
  return /^https?:\/\//.test(where) ? where : null;
}

/**
 * BRO-2999: every approval is decided here. Today a session's permission prompt is answered on the
 * session (Paseo's respondToPermission) and a hold at Maestro's own gate is a verdict (Allow closes it
 * as done, Deny sends it back with a note); BRO-2999 makes both approval.decide against the exact
 * action, with its receipt and undo.
 */
export function decideApproval(
  row: Extract<NeedRow, { kind: "approval" }>,
  item: WorkItem | null,
  allow: boolean,
): VerbPlan {
  const hold = holdOf(row.key);
  if (hold?.kind !== "work") return { call: "unavailable", why: "Only work holds an approval today." };
  if (row.body.heldBy === "permission") {
    const agentId = item?.worker?.agentId ?? row.session?.agentId ?? null;
    const requestId = item?.permission?.requestId ?? null;
    if (!agentId || !requestId)
      return {
        call: "go",
        intent: { kind: "select", id: hold.id },
        done: "Opened the item: its prompt is not read yet",
      };
    return { call: "permission", agentId, requestId, allow, done: allow ? "Allowed" : "Denied" };
  }
  return allow
    ? { call: "verdict", id: hold.id, verdict: "approve", note: "", done: "Allowed: closes as done" }
    : { call: "verdict", id: hold.id, verdict: "revise", note: "Denied from Maestro.", done: "Denied: goes back" };
}

/** BRO-2999: Continue and Change course prompt the session (session.prompt). No such call exists yet. */
export function promptSession(_key: string, _prompt: string): VerbPlan {
  return { call: "unavailable", why: "Prompting a session lands with BRO-2999 (session.prompt)." };
}

/**
 * The call `verb` makes on `target`. `choice` is the option an ask's or a
 * review's inspector holds. Pure.
 */
export function planVerb(verb: VerbId, target: VerbTarget, choice?: string): VerbPlan {
  const { row = null, item = null, ask = null } = target;
  const hold = row ? holdOf(row.key) : null;
  switch (verb) {
    case "allow":
    case "deny":
      if (row?.kind !== "approval") return { call: "unavailable", why: "Only an approval is allowed or denied." };
      return decideApproval(row, item, verb === "allow");
    case "answer": {
      if (hold?.kind === "review") return { call: "go", intent: { kind: "initiatives" }, done: "Opened Initiatives" };
      if (hold?.kind === "answers") return { call: "go", intent: { kind: "decisions" }, done: "Opened Decisions" };
      if (row?.kind !== "ask") return { call: "unavailable", why: "Only an ask is answered." };
      const decisions: MaestroIntent = ask
        ? { kind: "decisions", ledger: null, id: ask.id, key: hold?.kind === "ask" ? hold.askKey : null }
        : { kind: "decisions" };
      const option = ask?.options.find((entry) => entry.id === choice) ?? null;
      // An answer that cannot be undone takes Decisions' deliberate confirm; so does one this client cannot send.
      if (!ask || !option || option.reversible === false)
        return { call: "go", intent: decisions, done: "Opened it in Decisions" };
      return { call: "answer", ask, option: option.id, done: `Answered: ${option.label}` };
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
      return { call: "unavailable", why: "Snooze lands with notices.list (BRO-3036)." };
    case "open": {
      const agentId = item?.worker?.agentId ?? row?.session?.agentId ?? null;
      if (agentId) return { call: "session", agentId, done: "Opened the session" };
      if (item) return { call: "go", intent: { kind: "select", id: item.id }, done: "Opened the item" };
      return { call: "unavailable", why: "It has no session." };
    }
    case "unblock":
      if (!item || item.state !== "blocked") return { call: "unavailable", why: "Only stuck work is unblocked." };
      return { call: "unblock", id: item.id, done: "Unblocked" };
    case "cancel":
      if (!item) return { call: "unavailable", why: "Only work is canceled." };
      return { call: "cancel", id: item.id, done: "Canceled" };
    case "file":
    case "dismiss":
      if (!target.proposal) return { call: "unavailable", why: "Only a proposal is filed or dismissed." };
      return { call: "conductor", key: target.proposal, verb, done: verb === "file" ? "Filed as work" : "Dismissed" };
    case "continue":
      return promptSession(row?.key ?? (item ? `work:${item.id}` : ""), "Continue");
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
}

/** What a plan may need from the screen: a link opened, a session opened (the host's navigation). */
export interface VerbEnv {
  openUrl(url: string): void;
  openAgent(agentId: string): void;
}

/** A receipt the toast hands back: which undo it takes, and its value. */
export function receiptOf(value: string): { channel: "work" | "conductor"; value: string } | null {
  const at = value.indexOf(":");
  const channel = value.slice(0, at);
  const rest = value.slice(at + 1);
  if (at < 0 || !rest) return null;
  return channel === "work" || channel === "conductor" ? { channel, value: rest } : null;
}

/** Runs a plan: one hook for the screen, every verb's call in one place. */
export function useVerbs() {
  const paseo = usePaseo();
  const client = useQueryClient();
  const refresh = useRefresh();
  const rpc = {
    verdict: useRpc(decideWork),
    dispatch: useRpc(dispatchWork),
    unblock: useRpc(unblockWork),
    cancel: useRpc(cancelWork),
    undo: useRpc(undoWork),
    answer: useRpc(answerAsk),
    conductor: useRpc(decideConductor),
    conductorUndo: useRpc(undoConductor),
  };
  // Every call settles by reading again: needs.list and handled.list at once, and every Maestro read.
  const settle = () => {
    invalidateNeeds(client);
    void refresh();
  };
  return {
    /** Make the plan's call. Rejects with the call's error; `unavailable` rejects with its reason. */
    async run(plan: VerbPlan, env: VerbEnv): Promise<VerbOutcome> {
      try {
        switch (plan.call) {
          case "permission":
            await paseo.agents.ref(plan.agentId).respondToPermission({
              requestId: plan.requestId,
              response: plan.allow ? { behavior: "allow" } : { behavior: "deny", message: "Declined from Maestro" },
            });
            return { done: plan.done };
          case "verdict": {
            const { item } = await rpc.verdict({ id: plan.id, verdict: plan.verdict, note: plan.note });
            return { done: plan.done, receipt: `work:${plan.id}`, appliesAt: item.pending?.effectiveAt };
          }
          case "answer": {
            const { warning } = await rpc.answer({
              where: whereOf(plan.ask),
              ledger: plan.ask.ledger,
              uid: plan.ask.uid,
              id: plan.ask.id,
              hash: plan.ask.hash,
              option: plan.option,
              note: "",
            });
            return { done: warning ? `${plan.done} · ${warning}` : plan.done };
          }
          case "dispatch":
            await rpc.dispatch({ id: plan.id });
            return { done: plan.done };
          case "unblock":
            await rpc.unblock({ id: plan.id, note: "" });
            return { done: plan.done };
          case "cancel":
            await rpc.cancel({ id: plan.id });
            return { done: plan.done };
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
            return { done: plan.done, go: plan.intent };
          case "stay":
            return { done: plan.done };
          case "unavailable":
            throw new Error(plan.why);
        }
      } finally {
        if (plan.call !== "go" && plan.call !== "stay" && plan.call !== "url" && plan.call !== "session") settle();
      }
    },
    /** Take a verb back by its receipt, inside its window. */
    async undo(receipt: string): Promise<void> {
      const read = receiptOf(receipt);
      if (!read) return;
      try {
        if (read.channel === "work") await rpc.undo({ id: read.value });
        else await rpc.conductorUndo({ receipt: read.value });
      } finally {
        settle();
      }
    },
  };
}
