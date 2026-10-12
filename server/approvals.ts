// The actions agents asked leave for (A1, BRO-2999). An approval is one exact action that a policy layer held,
// "gh pr merge 933 --squash @ ce73104": a session raises it with `approval.request` (the agent contract, frame C1)
// and it waits here as a hold in Needs you, with Allow and Deny. Your decision binds to that exact action: it is
// recorded when you make it (approval.decide, server/owner-verbs.ts), takes effect after the undo window, and
// tells the session. Maestro runs nothing itself (A8): the session, or the conductor, does what was allowed.
//
// One append-only file (`approvals.jsonl`): `approval.requested`, then `approval.decided` or
// `approval.withdrawn`. A request names its session by the id the agent socket verified against Paseo's registry
// (BRO-2996, server/callers.ts): the cap, the withdrawal and the message an Allow sends back are all that live
// session's. A request is still only a question put to you: the decision is yours, and never on the agent socket.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { EvidenceSchema } from "../shared/needs";
import { TICKET } from "../shared/text";
import { UserError } from "./engine";
import { appendJsonLine } from "./jsonl";
import type { OpenApproval } from "./needs";

/** What an agent sends with `approval.request`. */
export const ApprovalRequestSchema = z.object({
  /** The exact action held, as the policy layer shows it: "gh pr merge 933 --squash". */
  action: z.string().trim().min(1, "Name the exact action that is held").max(500),
  /** What the action is bound to, so a changed target is a different request: a head SHA, a version. */
  ref: z.string().trim().min(1).max(120).optional(),
  /** The layer that held it: `gate`, `policy`, a permission prompt's name. */
  heldBy: z.string().trim().min(1).max(40).default("policy"),
  title: z.string().trim().min(1).max(200).optional(),
  scope: z.string().trim().min(1).max(60).default("maestro"),
  ticket: z.string().regex(TICKET, "A ticket is a team key and a number, like BRO-2999").optional(),
  /** What the gates already checked, one fact each. */
  evidence: z
    .array(EvidenceSchema.extend({ label: z.string().max(40), value: z.string().max(300) }))
    .max(8)
    .default([]),
  /** What happens after you allow it. */
  after: z.array(z.string().max(200)).max(6).default([]),
});
export type ApprovalRequestInput = z.input<typeof ApprovalRequestSchema>;

interface Requested extends OpenApproval {
  kind: "approval.requested";
  /** The request's own action and ref, as sent. */
  said: { action: string; ref: string | null };
}

type Line =
  | Requested
  | { kind: "approval.decided"; id: string; at: string; allow: boolean; note: string; receipt: string }
  | { kind: "approval.withdrawn"; id: string; at: string };

export interface ApprovalsOptions {
  path: string;
  now?: () => Date;
}

/** The id of a request: the same session asking for the same action at the same ref is one request. */
export function requestId(agentId: string, action: string, ref: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify([agentId, action, ref]))
    .digest("hex")
    .slice(0, 16);
}

/** How many requests one verified session may have waiting, so a loop in one session cannot flood Needs you. */
export const MAX_OPEN_PER_SESSION = 20;

export class Approvals {
  private readonly path: string;
  private readonly now: () => Date;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: ApprovalsOptions) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<{ requests: Map<string, Requested>; settled: Map<string, "decided" | "withdrawn"> }> {
    const requests = new Map<string, Requested>();
    const settled = new Map<string, "decided" | "withdrawn">();
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (line.kind === "approval.requested") {
        // A session that asks again, after the first was settled, asks anew.
        requests.set(line.id, line);
        settled.delete(line.id);
      } else if (requests.has(line.id) && !settled.has(line.id)) {
        settled.set(line.id, line.kind === "approval.decided" ? "decided" : "withdrawn");
      }
    }
    return { requests, settled };
  }

  private async write(line: Line): Promise<void> {
    await appendJsonLine(this.path, line);
  }

  /**
   * Raise a request for `agentId`, a session the socket verified. The same session asking for the same action
   * at the same ref while it waits is the one request, so asking again changes
   * nothing: the card keeps its place and its time.
   */
  async request(agentId: string, input: unknown): Promise<{ id: string; key: string }> {
    const parsed = ApprovalRequestSchema.safeParse(input ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
      throw new UserError(`Invalid input. ${issues.join("; ")}`);
    }
    const { action, ref, heldBy, title, scope, ticket, evidence, after } = parsed.data;
    const id = requestId(agentId, action, ref ?? null);
    return this.serial(async () => {
      const { requests, settled } = await this.read();
      if (!requests.has(id) || settled.has(id)) {
        const waiting = [...requests.values()].filter((entry) => entry.agentId === agentId && !settled.has(entry.id));
        if (waiting.length >= MAX_OPEN_PER_SESSION) {
          throw new UserError(
            `This session already has ${waiting.length} requests waiting on you. Withdraw some, or wait for an answer.`,
          );
        }
        await this.write({
          kind: "approval.requested",
          id,
          at: this.now().toISOString(),
          agentId,
          action: ref ? `${action} @ ${ref}` : action,
          said: { action, ref: ref ?? null },
          heldBy,
          title: title ?? action,
          scope,
          ...(ticket ? { ticket } : {}),
          evidence,
          after,
        });
      }
      return { id, key: `approval:${id}` };
    });
  }

  /** The requests nothing has decided or withdrawn, oldest first. */
  async open(): Promise<OpenApproval[]> {
    const { requests, settled } = await this.read();
    return [...requests.values()]
      .filter((request) => !settled.has(request.id))
      .map(({ kind: _kind, said: _said, ...open }) => open)
      .sort((a, b) => a.at.localeCompare(b.at) || (a.id < b.id ? -1 : 1));
  }

  /** One open request, or null: decided, withdrawn or never asked. */
  async get(id: string): Promise<OpenApproval | null> {
    return (await this.open()).find((request) => request.id === id) ?? null;
  }

  /** Record how a request ended: your decision, once it took effect. */
  async decided(id: string, outcome: { allow: boolean; note: string; receipt: string }): Promise<void> {
    await this.serial(() => this.write({ kind: "approval.decided", id, at: this.now().toISOString(), ...outcome }));
  }

  /** The session took its request back: nothing waits on you any more. Only the session that asked may. */
  async withdraw(agentId: string, id: string): Promise<{ withdrawn: boolean }> {
    return this.serial(async () => {
      const { requests, settled } = await this.read();
      const request = requests.get(id);
      if (!request || settled.has(id)) return { withdrawn: false };
      if (request.agentId !== agentId) throw new UserError("Only the session that asked can withdraw its request.");
      await this.write({ kind: "approval.withdrawn", id, at: this.now().toISOString() });
      return { withdrawn: true };
    });
  }
}
