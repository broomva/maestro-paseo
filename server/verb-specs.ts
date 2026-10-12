// What each of the owner's verbs does when its undo window closes (server/owner-verbs.ts holds the window, the
// receipt and the undo). Each verb says what it acts on at the call (`check`, so a refusal is immediate) and
// re-checks it when it applies (`apply`, so a decision about something that moved is dropped, never applied to
// something else).

import { holdOf, workKey } from "../shared/needs";
import type { VerbReceipt } from "../shared/verbs";
import type { Approvals } from "./approvals";
import { type Engine, UserError } from "./engine";
import type { OwnerVerbs } from "./owner-verbs";
import type { Paseo } from "./runs";

export interface VerbDeps {
  verbs: OwnerVerbs;
  engine: Engine;
  approvals: Approvals;
}

/** What approval.decide records: the hold, and the exact action you saw. */
type ApprovalArgs =
  | { target: "work"; id: string; requestId: string; action: string; allow: boolean; note: string }
  | { target: "request"; id: string; agentId: string; action: string; allow: boolean; note: string };

/** The words a session gets when its request is decided. */
export function decisionText(action: string, allow: boolean, note: string): string {
  const said = note.trim();
  return allow
    ? `Maestro: the owner allowed this exact action: ${action}. Go ahead with it. If its target has changed since (a new head, a new version), ask again instead.`
    : `Maestro: the owner denied this action: ${action}.${said ? ` ${said}` : ""} Do not take it, and do not retry it unasked.`;
}

/** A live session, or why not: the one a prompt or an answer is sent to. */
async function liveSession(paseo: Paseo, agentId: string): Promise<void> {
  const snapshot = await paseo.agents
    .ref(agentId)
    .refresh()
    .catch(() => null);
  if (!snapshot || snapshot.agent.archivedAt || snapshot.agent.status === "closed") {
    throw new UserError("The session is gone, so it could not be told.");
  }
}

/** The short form of a prompt, for a receipt's label. */
const gist = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

/** Register approval.decide and session.prompt on the ledger. */
export function registerApprovalVerbs({ verbs, engine, approvals }: VerbDeps): void {
  verbs.register<ApprovalArgs>("approval.decide", {
    client: true,
    apply: async (args, paseo, receipt) => {
      if (!paseo) throw new UserError("Maestro has no connection to Paseo yet.");
      if (args.target === "work") {
        return engine.answerPermission(paseo, args.id, args);
      }
      const request = await approvals.get(args.id);
      if (!request) throw new UserError("The request was withdrawn before your decision took effect.");
      if (request.action !== args.action) {
        throw new UserError("The session asks for something else now, so your decision was not sent.");
      }
      await liveSession(paseo, request.agentId);
      await paseo.agents.ref(request.agentId).send(decisionText(request.action, args.allow, args.note));
      await approvals.decided(args.id, { allow: args.allow, note: args.note, receipt });
      return `${args.allow ? "Allowed" : "Denied"}: ${request.action}`;
    },
  });
  verbs.register<{ agentId: string; prompt: string }>("session.prompt", {
    client: true,
    check: async ({ agentId }, paseo) => {
      if (paseo) await liveSession(paseo, agentId);
    },
    apply: async ({ agentId, prompt }, paseo) => {
      if (!paseo) throw new UserError("Maestro has no connection to Paseo yet.");
      await liveSession(paseo, agentId);
      await paseo.agents.ref(agentId).send(prompt);
      return `Sent: ${gist(prompt)}`;
    },
  });
}

/** approval.decide: Allow or Deny the exact action `action` on the hold `key`, after the undo window. */
export function decideApprovalHandler({ verbs, engine, approvals }: VerbDeps) {
  return async (input: { key: string; allow: boolean; action: string; note?: string }): Promise<VerbReceipt> => {
    const hold = holdOf(input.key);
    const note = input.note?.trim() ?? "";
    const word = input.allow ? "Allowed" : "Denied";
    if (hold?.kind === "work") {
      const { requestId } = await engine.permissionHold(hold.id, input.action);
      return verbs.schedule<ApprovalArgs>("approval.decide", {
        key: input.key,
        label: `${word} ${input.action}`,
        args: { target: "work", id: hold.id, requestId, action: input.action, allow: input.allow, note },
      });
    }
    if (hold?.kind === "approval") {
      const request = await approvals.get(hold.id);
      if (!request) throw new UserError("That request is no longer waiting on you.");
      if (request.action !== input.action) {
        throw new UserError("The session now asks for something else. Read what it asks, then decide again.");
      }
      return verbs.schedule<ApprovalArgs>("approval.decide", {
        key: input.key,
        label: `${word} ${input.action}`,
        args: {
          target: "request",
          id: hold.id,
          agentId: request.agentId,
          action: input.action,
          allow: input.allow,
          note,
        },
      });
    }
    throw new UserError("Only a held action is allowed or denied: a session's permission prompt, or a request.");
  };
}

/** session.prompt: send `prompt` to an existing session after the undo window. Never creates one (A8). */
export function promptSessionHandler({ verbs }: Pick<VerbDeps, "verbs">) {
  return (input: { agentId: string; prompt: string; key?: string }): Promise<VerbReceipt> =>
    verbs.schedule("session.prompt", {
      key: input.key ?? `session:${input.agentId}`,
      label: `Sent to ${input.agentId.slice(0, 8)}: ${gist(input.prompt)}`,
      args: { agentId: input.agentId, prompt: input.prompt },
    });
}

/** What a verb on one work item records: the item, in a receipt's words. */
const titled = (title: string) => (title.length > 50 ? `${title.slice(0, 47)}...` : title);

/**
 * work.cancel, work.stop, work.unblock and work.leave-running on the ledger. At your gate Cancel keeps its own
 * window on the work (Engine.verdict); everything else waits here, 8 s, and is checked again when it applies.
 */
export function registerWorkVerbs({ verbs, engine }: Pick<VerbDeps, "verbs" | "engine">): void {
  verbs.register<{ id: string }>("work.cancel", {
    check: async ({ id }) => engine.cancelRefusal(id),
    apply: async ({ id }, paseo) => {
      const { item } = await engine.get(id);
      // It reached your gate during the window: canceling there is a decision of its own, with its own window.
      if (item.state === "review")
        throw new UserError("It reached your gate while the window ran, so it was not canceled.");
      await engine.cancel(id, paseo);
      return "Canceled the work.";
    },
  });
  verbs.register<{ id: string; discard: boolean }>("work.stop", {
    client: true,
    check: async ({ id, discard }, paseo) => engine.stopPreflight(paseo, id, { discard }),
    apply: async ({ id, discard }, paseo) => {
      if (!paseo) throw new UserError("Maestro has no connection to Paseo yet.");
      await engine.stopRun(paseo, id, { discard });
      return discard
        ? "Stopped the run and discarded what it had not committed."
        : "Stopped the run; its branch stays.";
    },
  });
  verbs.register<{ id: string; note: string }>("work.unblock", {
    client: true,
    check: async ({ id }) => engine.unblockRefusal(id),
    apply: async ({ id, note }, paseo) => {
      if (!paseo) throw new UserError("Maestro has no connection to Paseo yet.");
      await engine.unblock(paseo, id, note);
      return "Unblocked: the session is going on.";
    },
  });
  verbs.register<{ id: string }>("work.leave-running", {
    check: async ({ id }) => engine.leaveRunningRefusal(id),
    apply: async ({ id }) => {
      await engine.leaveRunning(id);
      return "Left it running.";
    },
  });
}

/** The handlers for those four, each answering with its receipt and the work as it stands. */
export function workVerbHandlers({ verbs, engine }: Pick<VerbDeps, "verbs" | "engine">) {
  const done = async (verb: Parameters<OwnerVerbs["schedule"]>[0], id: string, label: string, args: unknown) => {
    const made = await verbs.schedule(verb, { key: workKey(id), label, args });
    return { item: (await engine.get(id)).item, ...made };
  };
  const named = async (id: string) => titled((await engine.get(id)).item.title);
  return {
    /** Work at your gate is canceled there (its own window); everything else here. */
    cancel: async (id: string) => {
      const { item } = await engine.get(id);
      if (item.state === "review") return null;
      return done("work.cancel", id, `Canceled ${await named(id)}`, { id });
    },
    stop: async (id: string, discard: boolean) => {
      return done("work.stop", id, `Stopped ${await named(id)}`, { id, discard });
    },
    unblock: async (id: string, note: string) => done("work.unblock", id, `Unblocked ${await named(id)}`, { id, note }),
    leaveRunning: async (id: string) => done("work.leave-running", id, `Left ${await named(id)} running`, { id }),
  };
}
