import { describe, expect, test } from "bun:test";
import type { WorkItem } from "../shared/contracts";
import { ChangedCache } from "./changed";

type Page = {
  entries: Array<{ id: string; diffStat?: { additions: number; deletions: number } | null }>;
  pageInfo: { nextCursor: string | null };
};

/** A daemon whose workspace list answers from `pages`, counting every call. */
function daemon(pages: Page[] | (() => Promise<Page>)) {
  const calls: Array<{ cursor?: string }> = [];
  const workspaces = {
    list: async (options?: { page?: { cursor?: string } }) => {
      calls.push({ cursor: options?.page?.cursor });
      if (typeof pages === "function") return pages();
      const index = options?.page?.cursor ? Number(options.page.cursor) : 0;
      return pages[index] ?? { entries: [], pageInfo: { nextCursor: null } };
    },
  };
  return { paseo: { workspaces } as never, calls };
}

const onWorkspace = (id: string, workspaceId: string | null): Pick<WorkItem, "id" | "worker"> => ({
  id,
  worker: workspaceId ? { agentId: `ag-${id}`, workspaceId, provider: "claude", branch: null, cwd: null } : null,
});

const items = [onWorkspace("a", "ws-a"), onWorkspace("b", "ws-b"), onWorkspace("c", null), onWorkspace("d", "ws-gone")];
const onePage: Page[] = [
  {
    entries: [
      { id: "ws-a", diffStat: { additions: 12, deletions: 3 } },
      { id: "ws-b", diffStat: null },
    ],
    pageInfo: { nextCursor: null },
  },
];

describe("the changed line, read on the server", () => {
  test("one read fills every item, and each gets its own workspace's stat or null", async () => {
    const { paseo, calls } = daemon(onePage);
    const filled = await new ChangedCache().fill(paseo, items);
    expect(calls).toHaveLength(1);
    expect(filled.map((item) => item.changed)).toEqual([{ additions: 12, deletions: 3 }, null, null, null]);
  });

  test("a read serves every list for the TTL, and the next list after it reads again", async () => {
    let now = 1_000;
    const { paseo, calls } = daemon(onePage);
    const cache = new ChangedCache({ now: () => now, ttlMs: 15_000 });
    await cache.fill(paseo, items);
    now += 14_999;
    await cache.fill(paseo, items);
    await cache.fill(paseo, items.slice(0, 1));
    expect(calls).toHaveLength(1);
    now += 1;
    await cache.fill(paseo, items);
    expect(calls).toHaveLength(2);
  });

  test("lists at the same moment share one read", async () => {
    const { paseo, calls } = daemon(onePage);
    const cache = new ChangedCache();
    const [first, second] = await Promise.all([cache.fill(paseo, items), cache.fill(paseo, items)]);
    expect(calls).toHaveLength(1);
    expect(first[0]?.changed).toEqual({ additions: 12, deletions: 3 });
    expect(second[0]?.changed).toEqual({ additions: 12, deletions: 3 });
  });

  test("every page is read, following the cursor", async () => {
    const { paseo, calls } = daemon([
      { entries: [{ id: "ws-a", diffStat: { additions: 1, deletions: 0 } }], pageInfo: { nextCursor: "1" } },
      { entries: [{ id: "ws-b", diffStat: { additions: 2, deletions: 5 } }], pageInfo: { nextCursor: null } },
    ]);
    const filled = await new ChangedCache().fill(paseo, items);
    expect(calls.map((call) => call.cursor)).toEqual([undefined, "1"]);
    expect(filled[1]?.changed).toEqual({ additions: 2, deletions: 5 });
  });

  test("a failed read leaves every stat null and does not fail the list, then waits out the TTL", async () => {
    let now = 0;
    let fail = true;
    const { paseo, calls } = daemon(async () => {
      if (fail) throw new Error("daemon went away");
      return onePage[0] as Page;
    });
    const cache = new ChangedCache({ now: () => now });
    const filled = await cache.fill(paseo, items);
    expect(filled.map((item) => item.changed)).toEqual([null, null, null, null]);
    fail = false;
    now += 1_000;
    await cache.fill(paseo, items);
    expect(calls).toHaveLength(1);
    now += 15_000;
    expect((await cache.fill(paseo, items))[0]?.changed).toEqual({ additions: 12, deletions: 3 });
  });

  test("a read that hangs never holds the list past the wait", async () => {
    const { paseo } = daemon(() => new Promise<Page>(() => undefined));
    const cache = new ChangedCache({ waitMs: 30, giveUpMs: 3_000 });
    const started = performance.now();
    const filled = await cache.fill(paseo, items);
    // Well under the give-up: the list went out on the wait alone.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(filled.every((item) => item.changed === null)).toBe(true);
  });

  test("a hung read is abandoned, so a later list can read again", async () => {
    let now = 0;
    const { paseo, calls } = daemon(() => new Promise<Page>(() => undefined));
    const cache = new ChangedCache({ now: () => now, waitMs: 10, giveUpMs: 40 });
    await cache.fill(paseo, items);
    await new Promise((resolve) => setTimeout(resolve, 100));
    now += 20_000;
    await cache.fill(paseo, items);
    expect(calls).toHaveLength(2);
  });

  test("a client that throws when touched (one being disposed) leaves the list whole", async () => {
    const disposed = {
      get workspaces(): never {
        throw new Error("client disposed");
      },
    };
    const filled = await new ChangedCache().fill(disposed as never, items);
    expect(filled.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(filled.every((item) => item.changed === null)).toBe(true);
  });

  test("before any client has been handed over, every stat is null and nothing is read", async () => {
    const cache = new ChangedCache();
    expect((await cache.fill(undefined, items)).map((item) => item.changed)).toEqual([null, null, null, null]);
    expect(cache.reads).toBe(0);
  });

  test("a stat that is not two numbers is unknown, not zero", async () => {
    const { paseo } = daemon([
      {
        entries: [{ id: "ws-a", diffStat: { additions: Number.NaN, deletions: 1 } }],
        pageInfo: { nextCursor: null },
      },
    ]);
    expect((await new ChangedCache().fill(paseo, items))[0]?.changed).toBeNull();
  });

  test("follows the workspace list to its end, past the old ten-page stop", async () => {
    const pages: Page[] = Array.from({ length: 12 }, (_, i) => ({
      entries: [{ id: `ws-${i}`, diffStat: { additions: i, deletions: 0 } }],
      pageInfo: { nextCursor: i < 11 ? String(i + 1) : null },
    }));
    const { paseo, calls } = daemon(pages);
    const filled = await new ChangedCache().fill(paseo, [onWorkspace("late", "ws-11")]);
    expect(calls).toHaveLength(12);
    expect(filled[0]?.changed).toEqual({ additions: 11, deletions: 0 });
  });

  test("a daemon that repeats a cursor does not loop forever", async () => {
    const pages: Page[] = [
      { entries: [{ id: "ws-a", diffStat: { additions: 1, deletions: 1 } }], pageInfo: { nextCursor: "1" } },
      { entries: [], pageInfo: { nextCursor: "1" } },
    ];
    const { paseo, calls } = daemon(pages);
    const filled = await new ChangedCache().fill(paseo, [onWorkspace("a", "ws-a")]);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(filled[0]?.changed).toEqual({ additions: 1, deletions: 1 });
  });
});
