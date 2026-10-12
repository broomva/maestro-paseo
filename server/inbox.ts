// Maestro's inbox: the one session that tells you, through Paseo's own
// notification, that work needs you.
//
// Paseo pushes when a top-level session finishes a turn (its agent attention,
// "finished") and never for a session another session started
// (isDelegatedAgent), which every orchestrated arc is; a plugin has no other
// way to reach your phone. So Maestro registers a provider of its own and
// keeps one session on it. Each landing at your gate is a turn there: its one
// message is the notice, which Paseo's push shows (its first 220 characters,
// under "Agent finished"), and the gate card under it answers the work in
// place. Paseo raises a session's attention once until you open it; an inbox
// still unread when the next landing comes is archived and a fresh one pushes
// (Inbox.session), so the channel never goes quiet on its own.

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { GATE_CARD_KIND, GATE_CARD_VERSION, type GateCardData, GateCardSchema } from "../shared/gate-card";
import { needsWords } from "../shared/needs";
import { lookOf, onItsOwnArc, workerOf } from "./events";
import { landingOf } from "./gate-card";
import { configPath } from "./paths";
import type { Paseo } from "./runs";
import type { StoredWork } from "./store";

export const INBOX_PROVIDER = "maestro-inbox";
const MODEL = "inbox";
const PLUGIN_ID = "maestro";
export const INBOX_TITLE = "Maestro · Needs you";

/** What Maestro sends its inbox: one landing, as the prompt's text (encodeNotice). */
const NoticeSchema = z.object({
  title: z.string(),
  ask: z.string(),
  // A notice is always for one landing in one worker's session: the card's optional fields are required here.
  card: GateCardSchema.extend({ landing: z.number().int().nonnegative(), agentId: z.string() }),
  /** How many holds need you as it is sent: needs.list's total, the header's number (BRO-3001). */
  needs: z.number().int().nonnegative().optional(),
});
export type InboxNotice = z.infer<typeof NoticeSchema>;
const PREFIX = "maestro-inbox:";
/** The title of the attachment a notice rides in (Inbox.send); the provider reads a notice from nothing else. */
const NOTICE_ATTACHMENT = "Maestro notice";

export const encodeNotice = (notice: InboxNotice): string => PREFIX + JSON.stringify(notice);

export function decodeNotice(text: string): InboxNotice | null {
  if (!text.startsWith(PREFIX)) return null;
  try {
    const parsed = NoticeSchema.safeParse(JSON.parse(text.slice(PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The notice as the inbox says it, and as the push reads it: how many need you
 * (needs.list's total, the header's number) first, then this one and what it asks.
 */
export const noticeText = (notice: InboxNotice): string => {
  const head = notice.needs ? `**${needsWords(notice.needs)}** · ${notice.title}` : `**Needs you** · ${notice.title}`;
  return notice.ask ? `${head}\n\n${notice.ask}` : head;
};

/**
 * The notice for a change, when it is a landing at your gate (landingOf), else
 * null. The ask is the session's own (lookOf); when it asked nothing, the
 * notice names the work and the card under it carries its last words.
 */
/**
 * How long a landing of an orchestrator's own arc waits before it pushes: the
 * landing is the orchestrator's to read first (it takes the handback, raises
 * what needs you as an ask, and archives the session, which closes the work:
 * BRO-2903). One still at your gate after this pushes. Observed: the SRI
 * orchestrator archives 14 s to 12 min after a landing.
 */
export const ORCHESTRATOR_GRACE_MS = 15 * 60_000;

/** Whether the latest landing is an orchestrator's own arc's: adopted by an agent, not answering a task of yours. */
export function orchestratorsLanding(events: readonly StoredWork["events"][number][]): boolean {
  const bind = events.findLast((e) => e.type === "dispatched" || e.type === "adopted");
  if (bind?.type !== "adopted" || bind.actor !== "agent") return false;
  const turn = events.findLastIndex((e) => e.type === "turn.ended");
  return turn >= 0 && onItsOwnArc(events.slice(0, turn));
}

export function noticeOf(before: Pick<StoredWork, "events">, after: StoredWork, now: number): InboxNotice | null {
  const landing = landingOf(before, after);
  const agentId = workerOf(after.events)?.agentId;
  if (landing === null || !agentId) return null;
  const look = lookOf("review", after.events, now);
  return { title: after.title, ask: look?.ask ?? "", card: { workId: after.contract.id, landing, agentId } };
}

// ── The provider ─────────────────────────────────────────────────────────────

/** A session that only ever says what Maestro sends it: no model, no tools, nothing to configure. */
export function createInboxProvider(): ProviderRegistration {
  return {
    id: INBOX_PROVIDER,
    label: "Maestro",
    description: "Where Maestro tells you that work needs you",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return inboxConnection();
    },
  };
}

const CAPABILITIES = ["prompt.message", "session.persistence", "timeline.plugin"] as const;

function inboxConnection(): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const open = new Set<string>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };
  return {
    version: 1,
    capabilities: CAPABILITIES,
    async send(input) {
      if (closed) throw new Error("The inbox provider is closed");
      queueMicrotask(() => answer(input, open, emit));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      open.clear();
      listeners.clear();
    },
  };
}

function answer(input: ProviderInput, open: Set<string>, emit: (event: ProviderEvent) => void) {
  switch (input.type) {
    case "catalog":
      emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: { models: [{ id: MODEL, label: "Inbox" }], modes: [], defaultModel: MODEL },
      });
      return;
    case "sessions":
      emit({ type: "sessions", requestId: input.requestId, sessions: [] });
      return;
    case "session.open": {
      open.add(input.sessionId);
      // Nothing of its own to restore: Paseo keeps the timeline, and a notice is never replayed.
      const persistence = input.persistence ?? { version: 1, data: { inbox: input.sessionId } };
      emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        capabilities: CAPABILITIES,
        restoration: "core",
        persistence,
        title: input.config.title ?? INBOX_TITLE,
        cwd: input.config.cwd,
      });
      emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      return;
    }
    case "session.prompt": {
      const { prompt } = input;
      if (!open.has(input.sessionId)) {
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: prompt.clientMessageId,
          result: { type: "failed", error: { message: "The inbox session is not open" } },
        });
        return;
      }
      const parts = prompt.input.type === "message" ? prompt.input.content : [];
      // Only Maestro's own attachment carries a notice: what you (or a work's title) typed never does.
      const attached = parts.flatMap((part) =>
        part.type === "text" && "mimeType" in part && part.title === NOTICE_ATTACHMENT ? [part.text] : [],
      );
      const text = parts
        .flatMap((part) => (part.type === "text" && !("mimeType" in part) ? [part.text] : []))
        .join("\n");
      // The prompt's own id, never a count: the inbox session persists, and a count restarts when Paseo
      // reopens it, so a later notice would reuse an earlier turn's and card's ids. A redelivered prompt keeps its id.
      const turnId = `inbox-${prompt.clientMessageId || randomUUID()}`;
      const sessionId = input.sessionId;
      emit({
        type: "session.prompt_result",
        sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "turn", turnId },
      });
      emit({ type: "session.turn", sessionId, turnId, state: "started" });
      // The notice rides as an attachment (Inbox.send), so your side of the inbox shows its title, not its code.
      const notice = attached.map(decodeNotice).find((found) => found !== null) ?? null;
      if (notice) {
        emit({
          type: "timeline.item",
          sessionId,
          item: { type: "assistant_message", id: `${turnId}-notice`, text: noticeText(notice) },
        });
        emit({
          type: "timeline.item",
          sessionId,
          item: {
            type: "plugin",
            id: `${turnId}-card`,
            pluginId: PLUGIN_ID,
            kind: GATE_CARD_KIND,
            version: GATE_CARD_VERSION,
            data: notice.card satisfies GateCardData,
          },
        });
      } else {
        // You wrote here: the inbox has nothing to say back but where to answer.
        emit({
          type: "timeline.item",
          sessionId,
          item: { type: "user_message", id: `${turnId}-you`, text, clientMessageId: prompt.clientMessageId },
        });
        emit({
          type: "timeline.item",
          sessionId,
          item: {
            type: "assistant_message",
            id: `${turnId}-reply`,
            text: "This is Maestro's inbox. Answer from a card above, or open Maestro.",
          },
        });
      }
      emit({ type: "session.turn", sessionId, turnId, state: "completed" });
      return;
    }
    case "session.close":
      open.delete(input.sessionId);
      emit({ type: "session.closed", sessionId: input.sessionId });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.interrupt":
    case "session.configure":
    case "session.revert":
    case "session.archive":
    case "session.unarchive":
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.permission":
      return;
  }
}

// ── The inbox session ────────────────────────────────────────────────────────

/** Where the inbox session's id is kept: beside the config, like the socket. */
export const inboxPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.MAESTRO_PASEO_INBOX ?? join(dirname(configPath(env)), "inbox.json");

/** How long an unread inbox takes more notices without a push of their own (Inbox.session). */
export const BURST_MS = 10 * 60_000;

/**
 * How long the inbox waits on one notice before it stops waiting and goes on
 * to the next, so a daemon that never answers jams nothing. A send cannot be
 * recalled: one Paseo answers late may still arrive, after a newer notice.
 * Its card reads the work live, so it shows the work as it stands.
 */
export const NOTICE_MS = 30_000;

/** How long a push waits for needs.list's total before it goes without it. */
export const COUNT_MS = 3_000;

/** `work`'s answer, or null once `ms` passes first. */
function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class Inbox {
  /** One notice at a time, so two landings at once open one session, not two. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The inbox session in use, once known: a failed write of inbox.json never opens another. */
  private kept: string | null = null;
  /** The inbox being opened, if one is. */
  private creating: Promise<string> | null = null;
  /** Per work id, the latest landing this process has told, as GateCards keeps it: a repeated report pushes once. */
  private readonly told = new Map<string, number>();

  constructor(
    private readonly paseo: () => Paseo | null,
    private readonly cwd: () => Promise<string>,
    private readonly log: (message: string) => void,
    private readonly path: string = inboxPath(),
    private readonly now: () => number = Date.now,
    private readonly limitMs: number = NOTICE_MS,
    /** Whether the work is still at your gate on this landing: an orchestrator's landing pushes only then. */
    private readonly stillWaiting: (workId: string, landing: number) => Promise<boolean> = async () => true,
    private readonly graceMs: number = ORCHESTRATOR_GRACE_MS,
    /** needs.list's total as the notice goes out, so the push says the header's number; null when unread. */
    private readonly count: () => Promise<number | null> = async () => null,
  ) {}

  /**
   * Tells the inbox about a landing. Always settles and never rejects: a
   * notice that fails is logged and dropped; one Paseo is slow to take is
   * logged and no longer waited on (NOTICE_MS), and the next one goes on.
   */
  landed(before: Pick<StoredWork, "events">, after: StoredWork): Promise<void> {
    const notice = noticeOf(before, after, this.now());
    if (!notice || notice.card.landing <= (this.told.get(notice.card.workId) ?? -1)) return Promise.resolve();
    // Claimed before the first await, so two reports of one landing at once still push once.
    this.told.set(notice.card.workId, notice.card.landing);
    if (!orchestratorsLanding(after.events)) return this.enqueue(notice);
    // An orchestrator's own landing is its to read first: it pushes only if still at your gate after the grace.
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.stillWaiting(notice.card.workId, notice.card.landing)
          .catch(() => false)
          .then((waiting) => {
            if (waiting) return this.enqueue(notice);
            this.log(`inbox notice for ${notice.card.workId}: its orchestrator took it within the grace; no push`);
          })
          .then(resolve);
      }, this.graceMs);
      // A pending grace never keeps the process alive; one lost to a restart still shows in Needs you.
      (timer as { unref?: () => void }).unref?.();
    });
  }

  private enqueue(notice: InboxNotice): Promise<void> {
    const sent = this.chain.then(() => this.bounded(this.send(notice)));
    this.chain = sent.catch(() => undefined);
    return sent.catch((error) => this.log(`inbox notice for ${notice.card.workId}: ${(error as Error).message}`));
  }

  private bounded(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`Paseo has not answered in ${this.limitMs / 1000} s; not waiting (it may still arrive)`)),
        this.limitMs,
      );
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  private async send(notice: InboxNotice): Promise<void> {
    const paseo = this.paseo();
    if (!paseo) throw new Error("Maestro has no connection to Paseo yet");
    const id = await this.session(paseo);
    // Counted as it goes out, after the landing it tells of: the push says the number the header says now.
    // A count slower than COUNT_MS is left out ("Needs you"), never waited on.
    const needs = await within(this.count(), COUNT_MS).catch(() => null);
    const told = needs === null ? notice : { ...notice, needs };
    // Paseo records the prompt's text as your message; an attachment it keeps out of it (and the provider reads).
    await paseo.agents.ref(id).send(notice.title, {
      attachments: [{ type: "text", mimeType: "text/plain", title: NOTICE_ATTACHMENT, text: encodeNotice(told) }],
    });
  }

  /**
   * The inbox session: the one kept, else a new one. Paseo raises a session's
   * attention once and clears it only when you open that session, so a kept
   * inbox still unread would never push again (you answered elsewhere, say).
   * Within BURST_MS of its push a notice joins it, so a burst is one push;
   * later, it is archived and a fresh one pushes. Everything it held is still
   * in Maestro's Needs you. A daemon that cannot say is an error, never
   * a reason to open a second inbox.
   */
  private async session(paseo: Paseo): Promise<string> {
    const kept =
      this.kept ??
      (await readFile(this.path, "utf8")
        .then((text) => z.object({ agentId: z.string() }).parse(JSON.parse(text)).agentId)
        .catch(() => null));
    if (kept) {
      // Paseo says "not found" for a session it no longer has (deleted, or a reset home): that one is gone.
      // Any other failure cannot say whether it is there, so the notice is dropped rather than a twin opened.
      const found = await paseo.agents
        .ref(kept)
        .refresh()
        .catch((error: Error) => {
          if (/not found/i.test(error.message)) return null;
          throw error;
        });
      const agent = found?.agent;
      // Unread since its own push within the burst window: this notice joins it, so a burst is one push.
      // Attention of another kind (an error, say, from a reload) pushed nothing and would swallow this push.
      const pushed = agent?.requiresAttention && agent.attentionReason === "finished";
      const quiet = !agent?.requiresAttention;
      const fresh = quiet || (pushed && this.now() - Date.parse(agent?.attentionTimestamp ?? "") < BURST_MS);
      if (agent && !agent.archivedAt && fresh) {
        this.kept = kept;
        return kept;
      }
      if (agent && !agent.archivedAt) {
        await paseo.agents
          .ref(kept)
          .archive()
          .catch((error) => this.log(`unread inbox ${kept} not archived: ${(error as Error).message}`));
      }
    }
    // One creation at a time, even past a notice the inbox stopped waiting on: a second never races it.
    this.creating ??= this.open(paseo).finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  private async open(paseo: Paseo): Promise<string> {
    const created = await paseo.agents.create({
      config: { provider: `${INBOX_PROVIDER}/${MODEL}` },
      cwd: await this.cwd(),
      title: INBOX_TITLE,
    });
    this.kept = created.id;
    await writeFile(this.path, `${JSON.stringify({ agentId: created.id })}\n`).catch((error) =>
      this.log(`inbox id not kept on disk (kept for this run): ${(error as Error).message}`),
    );
    return created.id;
  }
}
