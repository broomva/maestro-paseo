import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { GATE_CARD_KIND } from "../shared/gate-card";
import type { WorkEvent } from "./events";
import {
  createInboxProvider,
  decodeNotice,
  encodeNotice,
  INBOX_PROVIDER,
  INBOX_TITLE,
  Inbox,
  type InboxNotice,
  noticeOf,
  noticeText,
} from "./inbox";
import type { Paseo } from "./runs";
import type { StoredWork } from "./store";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-06T20:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const adopted: WorkEvent = {
  ts: at(0),
  type: "adopted",
  actor: "agent",
  by: "orchestrator",
  agentId: "arc",
  workspaceId: "ws",
  provider: "claude",
  branch: null,
  cwd: "/wt/sti-3492",
};
const ended = (summary: string): WorkEvent => ({
  ts: at(30),
  type: "turn.ended",
  actor: "agent",
  agentId: "arc",
  outcome: "completed",
  error: null,
  summary,
  turnId: "t1",
});
const toReview: WorkEvent = { ts: at(30), type: "state", actor: "agent", from: "running", to: "review", reason: null };

function work(events: WorkEvent[], id = "w1"): StoredWork {
  return {
    title: "SRI: STI-3492 organisation referrers (arc)",
    contract: { id },
    events,
  } as unknown as StoredWork;
}

describe("the notice", () => {
  test("a landing at your gate is a notice: the work, its own ask, and the card that answers it", () => {
    const before = work([adopted]);
    const after = work([adopted, ended("PR #2134 is open.\n\n## Ask\n- Merge #2134 once its checks pass?"), toReview]);
    expect(noticeOf(before, after, T0 + 31 * 60_000)).toEqual({
      title: "SRI: STI-3492 organisation referrers (arc)",
      ask: "Merge #2134 once its checks pass?",
      card: { workId: "w1", landing: 2, agentId: "arc" },
    });
  });

  test("anything else is not: a turn kept running, or a landing already told", () => {
    const kept = work([adopted, ended("Typechecking the touched packages.")]);
    expect(noticeOf(work([adopted]), kept, T0)).toBeNull();
    const landed = work([adopted, ended("## Ask\n- Merge?"), toReview]);
    expect(noticeOf(landed, landed, T0)).toBeNull();
  });

  test("it reads as the push shows it: what needs you, then what it asks; it survives the trip as text", () => {
    const notice: InboxNotice = {
      title: "Fix the flaky test",
      ask: "Merge #12?",
      card: { workId: "w", landing: 3, agentId: "a" },
    };
    expect(noticeText(notice)).toBe("**Needs you** · Fix the flaky test\n\nMerge #12?");
    expect(noticeText({ ...notice, ask: "" })).toBe("**Needs you** · Fix the flaky test");
    expect(decodeNotice(encodeNotice(notice))).toEqual(notice);
    expect(decodeNotice("merge it please")).toBeNull();
    expect(decodeNotice('maestro-inbox:{"title":1}')).toBeNull();
  });
});

describe("the provider", () => {
  async function connected() {
    const connection = await createInboxProvider().connect({ versions: [1], capabilities: [] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    const send = async (input: ProviderInput) => {
      await connection.send(input);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: { cwd: "/maestro", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });
    return { events, send };
  }
  const prompt = (text: string): ProviderInput => ({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "c1", delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } },
  });

  test("it opens a session and says a notice in one finished turn, with the gate card under it", async () => {
    const { events, send } = await connected();
    expect(events.map((e) => e.type)).toEqual(["session.opened", "session.ready"]);
    expect(events[0]).toMatchObject({ title: INBOX_TITLE, cwd: "/maestro" });
    const notice: InboxNotice = {
      title: "Fix the flaky test",
      ask: "Merge #12?",
      card: { workId: "w", landing: 3, agentId: "a" },
    };
    events.length = 0;
    await send(prompt(encodeNotice(notice)));
    expect(events).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "s1",
        clientMessageId: "c1",
        result: { type: "turn", turnId: "inbox-1" },
      },
      { type: "session.turn", sessionId: "s1", turnId: "inbox-1", state: "started" },
      {
        type: "timeline.item",
        sessionId: "s1",
        item: { type: "assistant_message", id: "inbox-1-notice", text: noticeText(notice) },
      },
      {
        type: "timeline.item",
        sessionId: "s1",
        item: {
          type: "plugin",
          id: "inbox-1-card",
          pluginId: "maestro",
          kind: GATE_CARD_KIND,
          version: 1,
          data: notice.card,
        },
      },
      { type: "session.turn", sessionId: "s1", turnId: "inbox-1", state: "completed" },
    ]);
  });

  test("what you write there is answered with where to answer", async () => {
    const { events, send } = await connected();
    events.length = 0;
    await send(prompt("approve it"));
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item] : []));
    expect(items.map((item) => item.type)).toEqual(["user_message", "assistant_message"]);
    expect(events.at(-1)).toMatchObject({ type: "session.turn", state: "completed" });
  });
});

describe("the inbox session", () => {
  function fakePaseo() {
    const agents = new Map<string, { archivedAt: string | null }>();
    const created: Array<Record<string, unknown>> = [];
    const sent: Array<{ id: string; text: string }> = [];
    const paseo = {
      agents: {
        create: async (options: Record<string, unknown>) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const id = `inbox-${created.length + 1}`;
          created.push(options);
          agents.set(id, { archivedAt: null });
          return { id };
        },
        ref: (id: string) => ({
          refresh: async () => {
            const agent = agents.get(id);
            return agent ? { agent, project: null } : null;
          },
          send: async (text: string) => {
            sent.push({ id, text });
          },
        }),
      },
    } as unknown as Paseo;
    return { paseo, agents, created, sent };
  }

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "maestro-inbox-"));
    roots.push(root);
    const fake = fakePaseo();
    const logs: string[] = [];
    const path = join(root, "inbox.json");
    const inbox = new Inbox(
      () => fake.paseo,
      async () => "/Users/me/maestro",
      (message) => logs.push(message),
      path,
      () => T0 + 31 * 60_000,
    );
    return { fake, inbox, path, logs };
  }
  const landing = (summary: string, id = "w1") =>
    [work([adopted], id), work([adopted, ended(summary), toReview], id)] as const;

  test("the first landing opens the inbox on Maestro's provider and keeps its id; the next one reuses it", async () => {
    const { fake, inbox, path } = await setup();
    await inbox.landed(...landing("## Ask\n- Merge #2134?"));
    await inbox.landed(...landing("ARC-STATUS: HANDBACK 1", "w2"));
    expect(fake.created).toEqual([
      { config: { provider: `${INBOX_PROVIDER}/inbox` }, cwd: "/Users/me/maestro", title: INBOX_TITLE },
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ agentId: "inbox-1" });
    expect(fake.sent.map((s) => [s.id, decodeNotice(s.text)?.ask])).toEqual([
      ["inbox-1", "Merge #2134?"],
      ["inbox-1", expect.stringContaining("It hands 1 thing back to you.")],
    ]);
  });

  test("two landings at once open one inbox, not two", async () => {
    const { fake, inbox } = await setup();
    await Promise.all([inbox.landed(...landing("## Ask\n- A?")), inbox.landed(...landing("## Ask\n- B?", "w2"))]);
    expect(fake.created).toHaveLength(1);
    expect(fake.sent).toHaveLength(2);
  });

  test("an inbox you archived is replaced by a new one; a change that is not a landing sends nothing", async () => {
    const { fake, inbox } = await setup();
    await inbox.landed(...landing("## Ask\n- A?"));
    const first = fake.agents.get("inbox-1");
    if (first) first.archivedAt = at(40);
    await inbox.landed(...landing("## Ask\n- B?", "w2"));
    expect(fake.sent.map((s) => s.id)).toEqual(["inbox-1", "inbox-2"]);
    await inbox.landed(work([adopted]), work([adopted, ended("Typechecking.")]));
    expect(fake.sent).toHaveLength(2);
  });

  test("one landing reported twice pushes once; a later landing of the same work pushes again", async () => {
    const { fake, inbox } = await setup();
    const [before, after] = landing("## Ask\n- A?");
    await Promise.all([inbox.landed(before, after), inbox.landed(before, after)]);
    expect(fake.sent).toHaveLength(1);
    const again = work([...after.events, ended("## Ask\n- B?"), toReview]);
    await inbox.landed(after, again);
    expect(fake.sent.map((s) => decodeNotice(s.text)?.card.landing)).toEqual([2, 4]);
  });

  test("a send Paseo never answers is dropped at the limit, and the next notice still goes", async () => {
    const root = await mkdtemp(join(tmpdir(), "maestro-inbox-"));
    roots.push(root);
    const fake = fakePaseo();
    let sends = 0;
    const paseo = {
      agents: {
        create: fake.paseo.agents.create,
        ref: (id: string) => ({
          ...fake.paseo.agents.ref(id),
          send: (text: string) =>
            ++sends === 1 ? new Promise<void>(() => undefined) : fake.paseo.agents.ref(id).send(text),
        }),
      },
    } as unknown as Paseo;
    const logs: string[] = [];
    const inbox = new Inbox(
      () => paseo,
      async () => "/m",
      (m) => logs.push(m),
      join(root, "inbox.json"),
      Date.now,
      50,
    );
    const first = inbox.landed(...landing("## Ask\n- A?"));
    await Promise.all([first, inbox.landed(...landing("## Ask\n- B?", "w2"))]);
    expect(logs).toEqual(["inbox notice for w1 not sent: Paseo did not answer within 0.05 s"]);
    expect(fake.sent.map((s) => decodeNotice(s.text)?.card.workId)).toEqual(["w2"]);
  });

  test("without a connection to Paseo the notice is logged and dropped, never thrown", async () => {
    const root = await mkdtemp(join(tmpdir(), "maestro-inbox-"));
    roots.push(root);
    const logs: string[] = [];
    const inbox = new Inbox(
      () => null,
      async () => "/m",
      (m) => logs.push(m),
      join(root, "inbox.json"),
    );
    await inbox.landed(...landing("## Ask\n- A?"));
    expect(logs).toEqual(["inbox notice for w1 not sent: Maestro has no connection to Paseo yet"]);
  });
});
