import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionAsk } from "../shared/fleet";
import type { Initiative } from "../shared/initiatives";
import { decisionOf, parsed, rowsOf } from "./control-asks";
import {
  agentIds,
  ghOutput,
  IDEA_TITLE_MAX,
  ideaCounts,
  ideaWork,
  initiativeOf,
  type Lookups,
  parseInitiative,
  prStates,
  sortInitiatives,
  staleOf,
  workspaceInitiatives,
} from "./initiatives";
import type { Paseo } from "./runs";

/** maestro.yaml as workspace#894 ships it, trimmed: active, a coordinator driving, an asks link. */
const MAESTRO = `id: maestro
title: "Maestro: the Paseo UI for the .control metalayer"
intent: "(not stated verbatim)"
summary: "Panels, contextual asks, answers, Fleet and Timeline views."
stated: 2026-09-29          # earliest linked ticket
status: active
next_action: "BRO-2801: Maestro Decisions reads the workspace .control/asks."
driver: coordinator:f5307ce7
links:
  linear: [BRO-2670, BRO-2801]
  prs: ["broomva/maestro-paseo#19"]
  repos: ["apps/maestro-paseo"]
  sessions: [f5307ce7]
  asks: ["maestro-paseo-gaps.yaml"]
review_by: 2026-10-10
exit: "The owner runs initiatives, asks and the fleet from Maestro alone."
`;

/** The one verbatim intent, blocked on an ask with an id. */
const FLEET = `id: fleet-autonomy
title: "Fleet autonomy"
intent: "as we keep operating these sessions and fleets, more of the automation can make the work we start get forgotten"
intent_source: "owner, 2026-10-03, session f5307ce7"
stated: 2026-10-03
status: blocked_on_owner
next_action: "Owner answers the canvas ask."
driver: owner
waiting_on:
  - kind: ask
    ref: "bro-2795-local-first-agentic-canvas.yaml#product-name"
  - kind: owner-step
    ref: "reload paseo"
    note: "after #19"
  - kind: pr
    ref: "broomva/workspace#889"
links:
  linear: [BRO-2802]
  prs: ["broomva/workspace#889"]
review_by: 2026-10-07
exit: "Nothing started is forgotten."
`;

const PARKED = `id: content-engine
title: "Content engine"
intent: "(not stated verbatim)"
stated: 2026-10-01
status: parked
next_action: "Pick one idea."
driver: none
wake: 2026-10-31
links:
  linear: [BRO-2771]
review_by: 2026-10-31
exit: "One piece ships."
`;

const lookups = (over: Partial<Lookups> = {}): Lookups => ({
  today: "2026-10-05",
  prStates: new Map(),
  agents: new Map(),
  ideas: new Map(),
  ...over,
});
const MAIN_HOME = { kind: "main" as const, path: "/repo", branch: null };
const read = (source: string, file: string, over: Partial<Lookups> = {}) =>
  initiativeOf(parseInitiative(source, file), file, MAIN_HOME, lookups(over));

describe("one initiative file", () => {
  test("a well-formed file reads every field the card shows, the sentinel as no quote", () => {
    const maestro = read(MAESTRO, "maestro.yaml", {
      prStates: new Map([["broomva/maestro-paseo#19", "merged"]]),
      agents: new Map([["f5307ce7", "f5307ce7-1111-2222-3333-444455556666"]]),
      ideas: new Map([["maestro", { open: 2, triaged: 1 }]]),
    });
    expect(maestro.error).toBeNull();
    expect([maestro.title, maestro.quote, maestro.status, maestro.reviewBy, maestro.driver]).toEqual([
      "Maestro: the Paseo UI for the .control metalayer",
      null,
      "active",
      "2026-10-10",
      "coordinator:f5307ce7",
    ]);
    // A comment after the date is the file's own, never part of the value.
    expect(maestro.stated).toBe("2026-09-29");
    expect(maestro.prs).toEqual([
      { ref: "broomva/maestro-paseo#19", url: "https://github.com/broomva/maestro-paseo/pull/19", state: "merged" },
    ]);
    expect(maestro.sessions).toEqual([{ id: "f5307ce7", agentId: "f5307ce7-1111-2222-3333-444455556666" }]);
    expect([maestro.linear, maestro.repos, maestro.asks]).toEqual([
      ["BRO-2670", "BRO-2801"],
      ["apps/maestro-paseo"],
      ["maestro-paseo-gaps.yaml"],
    ]);
    expect(maestro.ideas).toEqual({ open: 2, triaged: 1 });
    expect(maestro.stale).toBeNull();
  });

  test("a quote keeps its words and source; waiting_on names the ask, the step and the PR", () => {
    const fleet = read(FLEET, "fleet-autonomy.yaml");
    expect(fleet.quote).toStartWith("as we keep operating");
    expect(fleet.intentSource).toBe("owner, 2026-10-03, session f5307ce7");
    expect(fleet.waitingOn).toEqual([
      {
        kind: "ask",
        ref: "bro-2795-local-first-agentic-canvas.yaml#product-name",
        note: null,
        ledger: "bro-2795-local-first-agentic-canvas.yaml",
        askId: "product-name",
      },
      { kind: "owner-step", ref: "reload paseo", note: "after #19", ledger: null, askId: null },
      { kind: "pr", ref: "broomva/workspace#889", note: null, ledger: null, askId: null },
    ]);
    // An unknown PR state stays unknown, never a guess.
    expect(fleet.prs[0]?.state).toBeNull();
  });

  test.each([
    ["a duplicate key", MAESTRO.replace("status: active", "status: active\nstatus: parked"), "YAML error"],
    ["a parked file with no wake", PARKED.replace("wake: 2026-10-31\n", ""), "parked with no wake date"],
    [
      "an active file with no driver",
      MAESTRO.replace("driver: coordinator:f5307ce7", "driver: none"),
      "active with no driver",
    ],
    ["a quote with no source", FLEET.replace(/intent_source: .*\n/, ""), "no intent_source"],
    ["an id that is not the file's name", MAESTRO.replace("id: maestro", "id: maestro-ui"), "is not its file name"],
    ["a status nobody reads", MAESTRO.replace("status: active", "status: paused"), "status paused is not one of"],
    [
      "a review date that is not a date",
      MAESTRO.replace("review_by: 2026-10-10", "review_by: next week"),
      "review_by is not",
    ],
    ["a link key nobody reads", MAESTRO.replace("  repos:", "  docs: [x]\n  repos:"), "unknown keys docs"],
    ["a list at the top", "- id: maestro\n", "top level is not a mapping"],
  ])("%s is an error row with the reason, never hidden", (_name, source, reason) => {
    const row = read(source, "maestro.yaml");
    expect(row.error).toContain(reason);
    expect(row.error).toStartWith("maestro.yaml: ");
    // Its dates cannot be trusted, so it never counts as stale.
    expect(read(source, "maestro.yaml", { today: "2027-01-01" }).stale).toBeNull();
  });

  test("the good fixtures read with no error (each negative above is the rule's, not the fixture's)", () => {
    for (const [source, file] of [
      [MAESTRO, "maestro.yaml"],
      [FLEET, "fleet-autonomy.yaml"],
      [PARKED, "content-engine.yaml"],
    ] as const) {
      expect(read(source, file).error).toBeNull();
    }
  });
});

describe("stale, by the file's own dates", () => {
  const row = (source: string) => parsed(source);
  test("active or blocked: stale the day after review_by, never on it", () => {
    expect(staleOf(row(MAESTRO), "2026-10-10")).toBeNull();
    expect(staleOf(row(MAESTRO), "2026-10-11")).toEqual({ kind: "overdue", date: "2026-10-10" });
    expect(staleOf(row(FLEET), "2026-10-08")).toEqual({ kind: "overdue", date: "2026-10-07" });
  });

  test("parked: stale on its wake date, never before", () => {
    expect(staleOf(row(PARKED), "2026-10-30")).toBeNull();
    expect(staleOf(row(PARKED), "2026-10-31")).toEqual({ kind: "wake", date: "2026-10-31" });
  });

  test("done or killed: never stale", () => {
    const done = `${MAESTRO.replace("status: active", "status: done")}closed_at: 2026-10-04\noutcome: shipped\n`;
    expect(staleOf(row(done), "2027-01-01")).toBeNull();
  });

  test("the list: unreadable first, then stale, then by status and date", () => {
    const today = "2026-10-08";
    const list = [
      read(PARKED, "content-engine.yaml", { today }),
      read(MAESTRO, "maestro.yaml", { today }),
      read(FLEET, "fleet-autonomy.yaml", { today }),
      read("- x\n", "broken.yaml", { today }),
    ];
    expect(sortInitiatives(list).map((entry) => entry.id)).toEqual([
      "broken",
      "fleet-autonomy",
      "maestro",
      "content-engine",
    ]);
  });
});

/** An idea-triage ask as workspace#894's ledgers write it. */
const IDEAS = `arc: ideas-maestro
opened: 2026-10-05T21:00Z
tz: America/Bogota
lanes: [triage]
asks:
  - id: I1
    class: idea
    initiative: maestro
    idea: "An Initiatives tab"
    source: {kind: pr, ref: "broomva/workspace#894"}
    evidence: BRO-2802
    ask: "Develop, park or kill the tab?"
    headline: "Build the Initiatives tab, or park it?"
    stakes: "Ideas are forgotten."
    why_you: "Your call."
    options:
      - {id: develop, label: Develop, consequence: "A work item", reversible: true, recommended: true}
      - {id: park, label: Park, consequence: "Comes back", reversible: true}
      - {id: kill, label: Kill, consequence: "Closed", reversible: true}
    default: "develop"
    wake: 2026-11-02
    blocking: false
    asked_at: 2026-10-05T21:00Z
    answered_at: null
`;

const ideaAsks = (source: string = IDEAS): DecisionAsk[] => {
  const data = parsed(source);
  return rowsOf(data).flatMap((row) => {
    const ask = row
      ? decisionOf(row, data, "ideas-maestro.yaml", { ids: new Set(), uids: new Set() }, MAIN_HOME)
      : null;
    return ask ? [ask] : [];
  });
};

describe("ideas", () => {
  test("an idea ask carries its initiative, line, source, evidence and wake; counts split open and triaged", () => {
    const [idea] = ideaAsks();
    expect(idea?.idea).toEqual({
      initiative: "maestro",
      idea: "An Initiatives tab",
      source: { kind: "pr", ref: "broomva/workspace#894" },
      evidence: "BRO-2802",
      wake: "2026-11-02",
    });
    const answered = ideaAsks(
      IDEAS.replace("answered_at: null", 'answered_at: "2026-10-06T10:00Z"\n    answer_option: kill'),
    );
    expect(ideaCounts([...ideaAsks(), ...answered])).toEqual(new Map([["maestro", { open: 1, triaged: 1 }]]));
  });

  test("a develop brief carries the idea, its evidence, your words, and the initiative file", () => {
    const [idea] = ideaAsks();
    if (!idea) throw new Error("no idea");
    const maestro = read(MAESTRO, "maestro.yaml");
    const { title, brief } = ideaWork(maestro, { ...idea, answer: "Develop: A work item\nstart with the cards" });
    // The headline is written for people: the work is titled after it.
    expect(title).toBe("Build the Initiatives tab, or park it?");
    for (const part of [
      "ideas-maestro.yaml I1",
      "## The idea",
      "An Initiatives tab",
      "Evidence: BRO-2802",
      "Source: pr broomva/workspace#894",
      "> start with the cards",
      "Maestro: the Paseo UI for the .control metalayer (.control/initiatives/maestro.yaml, active)",
      "Intent: (not stated verbatim)",
      "Its next action: BRO-2801",
      "Done when: The owner runs initiatives",
      "Linked: BRO-2670, BRO-2801, broomva/maestro-paseo#19",
      '"Initiative: maestro"',
    ]) {
      expect(brief).toContain(part);
    }
    // An initiative that cannot be read is said in the brief, never papered over.
    expect(ideaWork(null, idea).brief).toContain(".control/initiatives/maestro.yaml could not be read");
  });

  test("a develop title is never cut mid-word: the headline, else the idea, at a word with …", () => {
    const [idea] = ideaAsks();
    if (!idea?.idea) throw new Error("no idea");
    const long =
      "Build the factory cell in six slices (S1-S6): one eve app driving holon worker units through a shared ledger and a replayable trace";
    // No headline: the idea, cut at the last whole word within IDEA_TITLE_MAX.
    const fromIdea = ideaWork(null, { ...idea, headline: null, idea: { ...idea.idea, idea: long } }).title;
    expect(fromIdea.length).toBeLessThanOrEqual(IDEA_TITLE_MAX);
    expect(fromIdea.endsWith("\u2026")).toBe(true);
    expect(long.startsWith(fromIdea.slice(0, -1))).toBe(true);
    expect(long.charAt(fromIdea.length - 1)).toBe(" ");
    expect(fromIdea).not.toContain("holon worker u\u2026");
    // A headline wins over the idea, and a blank one falls back to it.
    expect(ideaWork(null, { ...idea, headline: "Factory cell: build it?" }).title).toBe("Factory cell: build it?");
    expect(ideaWork(null, { ...idea, headline: "  " }).title).toBe("An Initiatives tab");
    // Nothing but the id: the id.
    expect(ideaWork(null, { ...idea, headline: null, idea: null }).title).toBe(idea.id);
  });
});

describe("PR states, one cached query", () => {
  test("gh's answer is kept when it exits 1 over one missing ref; with no answer, its error stands", () => {
    const partial = '{"data":{"p0":{"state":"MERGED"},"p1":null}}';
    expect(ghOutput(new Error("exit 1"), partial)).toBe(partial);
    expect(ghOutput(null, "")).toBe("");
    expect(() => ghOutput(new Error("gh: not logged in"), "  ")).toThrow("not logged in");
  });

  test("every ref in one GraphQL call, each state read back; unknown ones stay null", async () => {
    const calls: string[][] = [];
    let at = 0;
    const states = prStates(
      async (args) => {
        calls.push([...args]);
        return JSON.stringify({
          data: {
            r0: { p0: { state: "MERGED" }, p1: null },
            r1: { p2: { state: "OPEN" } },
          },
        });
      },
      () => at,
    );
    const refs = ["broomva/workspace#888", "broomva/workspace#1", "broomva/skills#267", "not a ref"];
    expect(states.get(refs).size).toBe(0);
    await states.settled();
    expect(calls).toHaveLength(1);
    const query = calls[0]?.at(-1) ?? "";
    expect(query).toContain('r0: repository(owner: "broomva", name: "workspace")');
    expect(query).toContain("p1: pullRequest(number: 1)");
    expect(query).toContain('r1: repository(owner: "broomva", name: "skills") { p2: pullRequest(number: 267)');
    expect(states.get(refs)).toEqual(
      new Map([
        ["broomva/workspace#888", "merged"],
        ["broomva/workspace#1", null],
        ["broomva/skills#267", "open"],
      ]),
    );
    // Within ten minutes and no new ref: no second query; a new ref asks again at once.
    at += 60_000;
    states.get(refs);
    await states.settled();
    expect(calls).toHaveLength(1);
    states.get([...refs, "broomva/workspace#889"]);
    await states.settled();
    expect(calls).toHaveLength(2);
  });

  test("gh failing leaves every state unknown and logs it once per try", async () => {
    const logged: string[] = [];
    const states = prStates(
      async () => {
        throw new Error("gh: not logged in");
      },
      () => 0,
      (message) => logged.push(message),
    );
    states.get(["broomva/workspace#888"]);
    await states.settled();
    expect(states.get(["broomva/workspace#888"])).toEqual(new Map());
    expect(logged).toEqual(["initiatives: reading PR states: gh: not logged in"]);
  });
});

describe("session ids", () => {
  const paseoWith = (ids: string[], counter: { calls: number }) =>
    ({
      agents: {
        list: async () => {
          counter.calls += 1;
          return { entries: ids.map((id) => ({ agent: { id } })) };
        },
      },
    }) as unknown as Paseo;

  test("an 8-hex prefix resolves when exactly one agent has it; an ambiguous or short one does not", async () => {
    const counter = { calls: 0 };
    const paseo = paseoWith(["f5307ce7-aaaa", "2fa8824a-bbbb", "2fa8824a-cccc", "abc12345-dddd"], counter);
    const resolve = agentIds(() => 0);
    expect(await resolve.resolve(paseo, ["f5307ce7", "2fa8824a", "abc1", "deadbeef"])).toEqual(
      new Map([["f5307ce7", "f5307ce7-aaaa"]]),
    );
    // Cached: the next read lists nothing again; with no client it resolves from what it knows.
    await resolve.resolve(paseo, ["f5307ce7"]);
    expect(counter.calls).toBe(1);
    expect(await agentIds(() => 0).resolve(null, ["f5307ce7"])).toEqual(new Map());
  });
});

// ── The home rule, in a scratch control repo ─────────────────────────────────

const scratch: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ISOLATED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
beforeAll(async () => {
  for (const key of ISOLATED) savedEnv[key] = process.env[key];
  // Neither the owner's global hooks nor their identity: a config of the test's own.
  const home = await mkdtemp(join(tmpdir(), "maestro-initiatives-git-"));
  scratch.push(home);
  const config = join(home, "gitconfig");
  await writeFile(
    config,
    "[user]\n\tname = Maestro Test\n\temail = maestro@example.invalid\n[init]\n\tdefaultBranch = main\n",
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(async () => {
  for (const key of ISOLATED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env }).trim();

/** A control repo whose origin/main holds maestro, fleet-autonomy and content-engine. */
async function controlRepo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-initiatives-")));
  scratch.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "broomva");
  git(root, "init", "--quiet", "--bare", origin);
  git(root, "init", "--quiet", repo);
  const dir = join(repo, ".control", "initiatives");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "maestro.yaml"), MAESTRO);
  await writeFile(join(dir, "fleet-autonomy.yaml"), FLEET);
  await writeFile(join(dir, "content-engine.yaml"), PARKED);
  await writeFile(join(dir, "README.md"), "Not an initiative.\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "initiatives");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "fetch", "--quiet", "origin");
  return { root, repo, dir };
}

const byId = (list: readonly Initiative[], id: string) => {
  const found = list.find((entry) => entry.id === id);
  if (!found) throw new Error(`no initiative ${id}`);
  return found;
};

describe("the workspace's initiatives, in a scratch control repo", () => {
  test("origin/main is the record; a checkout's edit that has not landed is shown beside it, flagged local", async () => {
    const { root, repo } = await controlRepo();
    // A worktree that parks maestro and has not landed it.
    const tree = join(root, "wt-park");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/park-maestro", tree);
    await writeFile(
      join(tree, ".control", "initiatives", "maestro.yaml"),
      MAESTRO.replace("status: active", "status: parked").replace(
        "review_by: 2026-10-10",
        "review_by: 2026-10-31\nwake: 2026-10-31",
      ),
    );
    // The main checkout has an initiative of its own, not yet committed.
    await writeFile(join(repo, ".control", "initiatives", "kinetic.yaml"), MAESTRO.replaceAll("maestro", "kinetic"));
    const initiatives = workspaceInitiatives({
      controlRepo: repo,
      answersPath: join(root, "answers"),
      asks: null,
      now: () => Date.parse("2026-10-05T12:00:00"),
      ttlMs: 0,
    });
    const view = await initiatives.view();
    expect(view.warnings).toEqual([]);
    expect(view.today).toBe("2026-10-05");
    const maestro = byId(view.initiatives, "maestro");
    expect([maestro.status, maestro.home.kind]).toEqual(["active", "main"]);
    expect(maestro.local).toEqual([
      {
        path: tree,
        branch: "feat/park-maestro",
        fields: ["review_by", "status", "wake"],
        status: "parked",
        nextAction: null,
      },
    ]);
    const kinetic = byId(view.initiatives, "kinetic");
    expect([kinetic.home.kind, kinetic.home.path, kinetic.home.branch, kinetic.local]).toEqual([
      "checkout",
      repo,
      "main",
      [],
    ]);
    expect(view.initiatives.map((entry) => entry.id).sort()).toEqual([
      "content-engine",
      "fleet-autonomy",
      "kinetic",
      "maestro",
    ]);
  });

  test("an edit that landed on main is no longer local; the answers worktree is never a source", async () => {
    const { root, repo, dir } = await controlRepo();
    const tree = join(root, "wt-landed");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/next", tree);
    const next = MAESTRO.replace("BRO-2801: Maestro Decisions reads the workspace .control/asks.", "BRO-2802 phase 2.");
    await writeFile(join(tree, ".control", "initiatives", "maestro.yaml"), next);
    // Squash-merged: main holds the same words in a commit of its own.
    await writeFile(join(dir, "maestro.yaml"), next);
    git(repo, "commit", "--quiet", "-am", "landed");
    git(repo, "push", "--quiet", "origin", "main");
    git(repo, "fetch", "--quiet", "origin");
    const answers = join(root, "answers");
    git(repo, "worktree", "add", "--quiet", "-b", "maestro/answers", answers);
    await writeFile(join(answers, ".control", "initiatives", "maestro.yaml"), MAESTRO.replace("active", "done"));
    const view = await workspaceInitiatives({ controlRepo: repo, answersPath: answers, asks: null, ttlMs: 0 }).view();
    const maestro = byId(view.initiatives, "maestro");
    expect([maestro.nextAction, maestro.local]).toEqual(["BRO-2802 phase 2.", []]);
  });

  test("a malformed file on main is an error row; stale ones are notices; ideas are counted per initiative", async () => {
    const { repo, dir } = await controlRepo();
    await writeFile(join(dir, "broken.yaml"), "id: broken\nstatus: active\nstatus: parked\n");
    // A .yml is not an initiative file to initiative_ledger.py, so it is none here either.
    await writeFile(join(dir, "draft.yml"), MAESTRO.replaceAll("maestro", "draft"));
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "broken");
    git(repo, "push", "--quiet", "origin", "main");
    git(repo, "fetch", "--quiet", "origin");
    const asks = { read: async () => ({ controlRepo: repo, main: null, all: ideaAsks(), warnings: [] }) };
    const initiatives = workspaceInitiatives({
      controlRepo: repo,
      answersPath: join(repo, "..", "answers"),
      asks,
      now: () => Date.parse("2026-10-11T09:00:00"),
      ttlMs: 0,
    });
    const view = await initiatives.view();
    const [first] = view.initiatives;
    expect([first?.id, first?.error]).toEqual(["broken", expect.stringContaining("broken.yaml: it has a YAML error")]);
    expect(view.initiatives.map((entry) => entry.id)).not.toContain("draft");
    expect(byId(view.initiatives, "maestro").ideas).toEqual({ open: 1, triaged: 0 });
    expect(view.ideas.map((ask) => ask.id)).toEqual(["I1"]);
    expect(await initiatives.notices()).toEqual([
      { id: "fleet-autonomy", title: "Fleet autonomy", kind: "overdue", date: "2026-10-07" },
      {
        id: "maestro",
        title: "Maestro: the Paseo UI for the .control metalayer",
        kind: "overdue",
        date: "2026-10-10",
      },
    ]);
    expect((await initiatives.one("maestro"))?.title).toBe("Maestro: the Paseo UI for the .control metalayer");
  });

  test("no origin/main: nothing read, and the reason said", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-initiatives-bare-")));
    scratch.push(root);
    git(root, "init", "--quiet", "repo");
    const view = await workspaceInitiatives({
      controlRepo: join(root, "repo"),
      answersPath: join(root, "answers"),
      asks: null,
      ttlMs: 0,
    }).view();
    expect([view.initiatives, view.warnings[0]]).toEqual([[], expect.stringContaining("has no origin/main")]);
  });
});
