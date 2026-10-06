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
import { lookOf, workerOf } from "./events";
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
});
export type InboxNotice = z.infer<typeof NoticeSchema>;
const PREFIX = "maestro-inbox:";

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

/** The notice as the inbox says it, and as the push reads it: what needs you first, then what it asks. */
export const noticeText = (notice: InboxNotice): string =>
  notice.ask ? `**Needs you** · ${notice.title}\n\n${notice.ask}` : `**Needs you** · ${notice.title}`;

/**
 * The notice for a change, when it is a landing at your gate (landingOf), else
 * null. The ask is the session's own (lookOf); when it asked nothing, the
 * notice names the work and the card under it carries its last words.
 */
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
  const open = new Map<string, { turns: number }>();
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

function answer(input: ProviderInput, open: Map<string, { turns: number }>, emit: (event: ProviderEvent) => void) {
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
      open.set(input.sessionId, { turns: 0 });
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
      const session = open.get(input.sessionId);
      if (!session) {
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: prompt.clientMessageId,
          result: { type: "failed", error: { message: "The inbox session is not open" } },
        });
        return;
      }
      const parts = prompt.input.type === "message" ? prompt.input.content : [];
      const texts = parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
      const text = texts.join("\n");
      session.turns += 1;
      const turnId = `inbox-${session.turns}`;
      const sessionId = input.sessionId;
      emit({
        type: "session.prompt_result",
        sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "turn", turnId },
      });
      emit({ type: "session.turn", sessionId, turnId, state: "started" });
      // The notice rides as an attachment (Inbox.send), so your side of the inbox shows its title, not its code.
      const notice = texts.map(decodeNotice).find((found) => found !== null) ?? null;
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

/** How long one notice may take before it is dropped, so a daemon that never answers jams no later notice. */
export const NOTICE_MS = 30_000;

export class Inbox {
  /** One notice at a time, so two landings at once open one session, not two. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The inbox session in use, once known: a failed write of inbox.json never opens another. */
  private kept: string | null = null;
  /** Per work id, the latest landing this process has told, as GateCards keeps it: a repeated report pushes once. */
  private readonly told = new Map<string, number>();

  constructor(
    private readonly paseo: () => Paseo | null,
    private readonly cwd: () => Promise<string>,
    private readonly log: (message: string) => void,
    private readonly path: string = inboxPath(),
    private readonly now: () => number = Date.now,
    private readonly limitMs: number = NOTICE_MS,
  ) {}

  /**
   * Tells the inbox about a landing. Always settles and never rejects: a
   * notice that fails, or takes longer than the limit, is logged and dropped,
   * and the next one goes on.
   */
  landed(before: Pick<StoredWork, "events">, after: StoredWork): Promise<void> {
    const notice = noticeOf(before, after, this.now());
    if (!notice || notice.card.landing <= (this.told.get(notice.card.workId) ?? -1)) return Promise.resolve();
    // Claimed before the first await, so two reports of one landing at once still push once.
    this.told.set(notice.card.workId, notice.card.landing);
    const sent = this.chain.then(() => this.bounded(this.send(notice)));
    this.chain = sent.catch(() => undefined);
    return sent.catch((error) =>
      this.log(`inbox notice for ${notice.card.workId} not sent: ${(error as Error).message}`),
    );
  }

  private bounded(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Paseo did not answer within ${this.limitMs / 1000} s`)), this.limitMs);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  private async send(notice: InboxNotice): Promise<void> {
    const paseo = this.paseo();
    if (!paseo) throw new Error("Maestro has no connection to Paseo yet");
    const id = await this.session(paseo);
    // Paseo records the prompt's text as your message; an attachment it keeps out of it (and the provider reads).
    await paseo.agents.ref(id).send(notice.title, {
      attachments: [{ type: "text", mimeType: "text/plain", title: "Maestro notice", text: encodeNotice(notice) }],
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
      const found = await paseo.agents.ref(kept).refresh();
      const agent = found?.agent;
      // Unread since a push within the burst window: this notice joins it, so a burst of landings is one push.
      const unread = agent?.requiresAttention ? Date.parse(agent.attentionTimestamp ?? "") : null;
      const fresh = unread === null || this.now() - unread < BURST_MS;
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
