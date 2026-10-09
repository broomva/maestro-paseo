import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopIntent } from "../shared/loops";
import {
  dirLedger,
  gitLedger,
  LEDGER_DIR,
  type LedgerSource,
  type LoopRepo,
  loopPaths,
  loopReposPath,
  multiLedger,
  parseLedger,
  parseLoopRepos,
  parseRow,
} from "./loops-ledger";

const FIXTURE = join(import.meta.dir, "testdata", "loops-ledger");
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const ROW = `id: kg-lint
title: Knowledge-graph weekly lint
purpose: Lint every entity page.
owner: owner
scope: broomva
substrate: {kind: launchd, ref: com.broomva.kg-lint}
cadence: Sundays 02:30
desired: paused
desired_since: '2026-10-04'
reason: Paused until the evals land.
review_by: '2026-10-21'
`;
const file = (id: string) => `${LEDGER_DIR}/${id}.yaml`;
const parse = (text: string, id = "kg-lint", files: string[] = []) => parseRow(file(id), text, new Set(files));

describe("the ledger rows", () => {
  test("the P1 rows (a fixture copy) all parse, the bound coordinator row among them", async () => {
    const read = await dirLedger(FIXTURE).read();
    expect(read.errors).toEqual([]);
    expect(read.intents.length).toBeGreaterThanOrEqual(23);
    const coordinator = read.intents.find((row) => row.id === "coordinator-tick");
    expect(coordinator).toMatchObject({
      owner: "coordinator",
      substrate: { kind: "paseo-heartbeat", ref: "name:coordinator-tick" },
      session: "bound",
      prompt: ".broomva/loops/prompts/coordinator-tick.md",
      desired: "active",
    });
    expect(read.intents.find((row) => row.id === "fleet-reconcile-sri")).toMatchObject({ scope: "sri", desired: null });
  });

  test("a valid row parses", () => {
    expect(parse(ROW)).toMatchObject({
      id: "kg-lint",
      desired: "paused",
      desiredSince: "2026-10-04",
      scope: "broomva",
    });
  });

  test("an unknown key is a row error, never a crash", () => {
    expect(parse(`${ROW}colour: blue\n`)).toBe("unknown key colour");
    expect(parse(ROW.replace("ref: com.broomva.kg-lint", "ref: com.broomva.kg-lint, label: x"))).toContain(
      "unknown substrate key label",
    );
  });

  test("a duplicate key, bad YAML, a missing field or a value outside its set is a row error", () => {
    expect(parse(`${ROW}owner: fleet\n`)).toContain("unparseable YAML");
    expect(parse("id: [unclosed")).toContain("unparseable YAML");
    expect(parse("- a\n- b\n")).toBe("the top level must be a mapping");
    expect(parse(ROW.replace("cadence: Sundays 02:30\n", ""))).toContain("missing cadence");
    expect(parse(ROW.replace("desired: paused", "desired: sleeping"))).toContain("desired must be");
    expect(parse(ROW.replace("scope: broomva", "scope: everyone"))).toContain("scope must be");
    expect(parse(ROW.replace("kind: launchd", "kind: cron"))).toContain("substrate.kind must be");
    expect(parse(ROW, "kg-compile")).toContain("must be a slug equal to the file name");
  });

  test("desired is required unless sri, and forbidden when sri", () => {
    expect(parse(ROW.replace("desired: paused\n", ""))).toContain("desired is required");
    expect(parse(ROW.replace("scope: broomva", "scope: sri"))).toContain("a scope sri row has no desired");
  });

  test("§1a: prompt and session, each in its place", () => {
    const hb = (extra: string) =>
      `id: coordinator-tick
title: t
purpose: p
owner: coordinator
scope: broomva
substrate: {kind: paseo-heartbeat, ref: 'name:coordinator-tick'}
cadence: c
desired: active
review_by: '2026-10-21'
${extra}`;
    const prompt = ".broomva/loops/prompts/coordinator-tick.md";
    const files = [prompt];
    const ok = parseRow(file("coordinator-tick"), hb(`prompt: ${prompt}\nsession: bound\n`), new Set(files));
    expect(typeof ok).toBe("object");
    const err = (extra: string, id = "coordinator-tick", known = files) =>
      parseRow(file(id), hb(extra), new Set(known)) as string;
    expect(err(`prompt: ${prompt}\nsession: bound\n`, "coordinator-tick", [])).toContain("is not in the ledger");
    expect(err("prompt: ../../etc/passwd\n")).toContain("prompt must be a file under");
    expect(err("session: bound\n")).toContain("session: bound needs a prompt");
    expect(
      parseRow(
        file("coordinator-tick"),
        hb(`prompt: ${prompt}\nsession: bound\n`).replace("owner: coordinator", "owner: coordinator:f5307ce7"),
        new Set(files),
      ),
    ).toContain("session: bound needs owner");
    expect(
      parseRow(
        file("coordinator-tick"),
        hb(`prompt: ${prompt}\nsession: bound\n`).replace("name:coordinator-tick", "103a1850"),
        new Set(files),
      ),
    ).toContain("session: bound needs ref name:coordinator-tick");
    expect(
      parseRow(
        file("coordinator-tick"),
        hb(`prompt: ${prompt}\nsession: bound\n`).replace("paseo-heartbeat", "paseo-schedule"),
        new Set(files),
      ),
    ).toContain("session: bound is only for paseo-heartbeat");
    expect(parse(ROW.replace("review_by", `prompt: ${prompt}\nreview_by`), "kg-lint", files)).toContain(
      "prompt is only for",
    );
  });

  test("one bad file costs only itself; two rows cannot claim one substrate; nothing but prompts/*.md below the folder", () => {
    const files = new Map<string, string | null>([
      [file("kg-lint"), ROW],
      [file("bad"), "id: bad\n"],
      [file("kg-lint-copy"), ROW.replace("id: kg-lint", "id: kg-lint-copy")],
      [`${LEDGER_DIR}/README.md`, "# readme"],
      [`${LEDGER_DIR}/prompts/x.md`, "x"],
      [`${LEDGER_DIR}/prompts/nested/y.md`, "y"],
      [`${LEDGER_DIR}/other/z.yaml`, "z"],
    ]);
    const read = parseLedger(files);
    // The first by file name keeps the claim; the other is an error naming it.
    expect(read.intents.map((row) => row.id)).toEqual(["kg-lint-copy"]);
    expect(read.errors.map((error) => error.file).sort()).toEqual(
      [file("bad"), file("kg-lint"), `${LEDGER_DIR}/other/z.yaml`, `${LEDGER_DIR}/prompts/nested/y.md`].sort(),
    );
    expect(read.errors.find((error) => error.file === file("kg-lint"))?.error).toContain(
      "already claims launchd com.broomva.kg-lint",
    );
  });

  test("checks (BRO-2942): a snapshot script under checks/, present, beside a prompt", () => {
    const prompt = ".broomva/loops/prompts/coordinator-tick.md";
    const checks = ".broomva/loops/checks/coordinator-tick.sh";
    const hb = (extra: string) =>
      `id: coordinator-tick
title: t
purpose: p
owner: coordinator
scope: broomva
substrate: {kind: paseo-heartbeat, ref: 'name:coordinator-tick'}
cadence: c
desired: active
review_by: '2026-10-21'
${extra}`;
    const at = (extra: string, known = [prompt, checks]) =>
      parseRow(file("coordinator-tick"), hb(extra), new Set(known));
    expect(at(`prompt: ${prompt}\nsession: bound\nchecks: ${checks}\n`)).toMatchObject({ checks, prompt });
    expect(at(`prompt: ${prompt}\n`)).toMatchObject({ checks: null });
    expect(at(`prompt: ${prompt}\nchecks: ${checks}\n`, [prompt])).toContain("is not in the ledger");
    expect(at(`checks: ${checks}\n`)).toContain("checks needs a prompt");
    for (const bad of [
      ".broomva/loops/checks/x.py",
      ".broomva/loops/checks/../x.sh",
      ".broomva/loops/checks/a/x.sh",
      "x.sh",
    ]) {
      expect(at(`prompt: ${prompt}\nchecks: ${bad}\n`, [prompt, bad])).toContain("checks must be a file under");
    }
  });

  test("checks/*.sh sits below the folder as prompts/*.md does; nothing else does", () => {
    const read = parseLedger(
      new Map<string, string | null>([
        [file("kg-lint"), ROW],
        [`${LEDGER_DIR}/checks/tick.sh`, "#!/bin/sh"],
        [`${LEDGER_DIR}/checks/tick.md`, "x"],
        [`${LEDGER_DIR}/checks/nested/tick.sh`, "x"],
        [`${LEDGER_DIR}/prompts/tick.sh`, "x"],
      ]),
    );
    expect(read.errors.map((error) => error.file).sort()).toEqual(
      [`${LEDGER_DIR}/checks/nested/tick.sh`, `${LEDGER_DIR}/checks/tick.md`, `${LEDGER_DIR}/prompts/tick.sh`].sort(),
    );
  });

  test("a repo that owns a scope records intent for it; anywhere else a scope sri row is a mirror", () => {
    const sri = ROW.replace("scope: broomva", "scope: sri");
    expect(parse(sri)).toContain("a scope sri row has no desired");
    expect(parseRow(file("kg-lint"), sri, new Set(), "sri")).toMatchObject({ scope: "sri", desired: "paused" });
    expect(
      parseRow(file("kg-lint"), sri.replace(/desired.*\n/g, "").replace(/reason.*\n/, ""), new Set(), "sri"),
    ).toContain("desired is required");
  });

  test("loopPaths resolves the home as broomva_home.py does", () => {
    expect(loopPaths({ BROOMVA_HOME: "/tmp/h" })).toMatchObject({
      streams: "/tmp/h/ledger/loops",
      notes: "/tmp/h/notes/loops",
    });
    expect(loopPaths({}).streams).toEndWith("/.broomva/ledger/loops");
  });
});

describe("reading origin/main, never the working tree", () => {
  test("the rows on origin/main are read; a working-tree edit is not", async () => {
    const root = await mkdtemp(join(tmpdir(), "loops-ledger-"));
    roots.push(root);
    const repo = join(root, "repo");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await cp(FIXTURE, join(repo, LEDGER_DIR), { recursive: true });
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ledger", "--no-verify");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    // A checkout on another branch with a broken row: origin/main is what counts.
    await writeFile(join(repo, LEDGER_DIR, "kg-lint.yaml"), "colour: blue\n");
    const read = await gitLedger(repo).read();
    expect(read.errors).toEqual([]);
    expect(read.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(read.intents.find((row) => row.id === "kg-lint")?.desired).toBe("paused");
  });
});

describe("several repos (BRO-2942)", () => {
  const row = (id: string, extra: Partial<LoopIntent> = {}): LoopIntent => ({
    id,
    title: id,
    purpose: "p",
    owner: "owner",
    scope: "broomva",
    initiative: null,
    substrate: { kind: "launchd", ref: `com.x.${id}` },
    cadence: "c",
    desired: "active",
    desiredSince: null,
    reason: null,
    reviewBy: null,
    prompt: null,
    session: null,
    checks: null,
    file: `${LEDGER_DIR}/${id}.yaml`,
    ...extra,
  });
  const fixed = (intents: LoopIntent[], errors = [] as { file: string; error: string }[], sha = "a".repeat(40)) =>
    ({
      where: { repo: "/r", path: "origin/main:.broomva/loops" },
      read: async () => ({ intents, errors, sha }),
    }) as LedgerSource;
  const repos = (list: unknown) => async () => JSON.stringify({ repos: list });

  test("the repos file: strict, and each bad entry costs only itself", () => {
    expect(parseLoopRepos('{"repos": [{"label": "sri", "repo": "~/x", "ref": "origin/dev", "owns": "sri"}]}')).toEqual({
      repos: [{ label: "sri", repo: expect.stringMatching(/\/x$/), ref: "origin/dev", owns: "sri" }],
      errors: [],
    });
    expect(parseLoopRepos('{"repos": [{"label": "a", "repo": "/a"}]}').repos[0]).toMatchObject({
      ref: "origin/main",
      owns: null,
    });
    expect(parseLoopRepos("nope").errors[0]).toContain("unparseable JSON");
    expect(parseLoopRepos('{"repos": [], "x": 1}').errors[0]).toContain("exactly");
    const bad = parseLoopRepos(
      JSON.stringify({
        repos: [
          { label: "Bad Label", repo: "/a" },
          { label: "a", repo: "/a", ref: "main" },
          { label: "b", repo: "/b", owns: "everyone" },
          { label: "c", repo: "/c", colour: "x" },
          { label: "d", repo: "" },
          { label: "e", repo: "/e" },
          { label: "e", repo: "/e2" },
        ],
      }),
    );
    expect(bad.repos.map((one) => one.label)).toEqual(["e"]);
    expect(bad.errors).toHaveLength(6);
  });

  test("the repos file sits beside the config unless named; off reads none", () => {
    expect(loopReposPath({ MAESTRO_PASEO_CONFIG: "/c/config.json" })).toBe("/c/loop-repos.json");
    expect(loopReposPath({ MAESTRO_PASEO_LOOP_REPOS: "/x.json" })).toBe("/x.json");
    expect(loopReposPath({ MAESTRO_PASEO_LOOP_REPOS: "off" })).toBeNull();
  });

  test("no repos file: the control repo's read, unchanged", async () => {
    const primary = fixed([row("a")]);
    const read = await multiLedger(primary, { reposPath: "/none", readText: async () => null }).read();
    expect(read).toEqual(await primary.read());
  });

  test("an extra repo's rows join, labelled; its errors are labelled; a repo that fails costs only itself", async () => {
    const made: LoopRepo[] = [];
    const ledger = multiLedger(fixed([row("a")]), {
      reposPath: "/r.json",
      readText: repos([
        { label: "two", repo: "/two" },
        { label: "down", repo: "/down" },
      ]),
      source: (one) => {
        made.push(one);
        return one.label === "down"
          ? ({
              where: { repo: one.repo, path: "" },
              read: async () => Promise.reject(new Error("no ref")),
            } as LedgerSource)
          : fixed([row("b")], [{ file: `${LEDGER_DIR}/x.yaml`, error: "bad" }]);
      },
    });
    const read = await ledger.read();
    expect(read.intents.map((one) => [one.id, one.file])).toEqual([
      ["a", `${LEDGER_DIR}/a.yaml`],
      ["b", `two:${LEDGER_DIR}/b.yaml`],
    ]);
    expect(read.errors).toEqual([
      { file: `two:${LEDGER_DIR}/x.yaml`, error: "bad" },
      { file: `down:${LEDGER_DIR}`, error: "could not be read at origin/main: no ref" },
    ]);
    expect(read.sha).toBe("a".repeat(40));
    await ledger.read();
    expect(made).toHaveLength(2); // a source is made once and kept: its fetch clock survives reads
  });

  test("the owner's row replaces the control repo's mirror; any other clash is an error and the first keeps it", async () => {
    const mirror = row("sri-tick", {
      scope: "sri",
      desired: null,
      owner: "sri-orchestrator",
      substrate: { kind: "paseo-heartbeat", ref: "name:sri-tick" },
    });
    const owned = row("sri-tick", {
      scope: "sri",
      owner: "coordinator",
      substrate: { kind: "paseo-heartbeat", ref: "name:sri-tick" },
    });
    const read = await multiLedger(fixed([mirror, row("a")]), {
      reposPath: "/r.json",
      readText: repos([{ label: "sri", repo: "/s", ref: "origin/dev", owns: "sri" }]),
      source: () => fixed([owned, row("a"), row("c", { substrate: { kind: "launchd", ref: "com.x.a" } })]),
    }).read();
    expect(read.intents.map((one) => [one.id, one.file, one.desired])).toEqual([
      ["a", `${LEDGER_DIR}/a.yaml`, "active"],
      ["sri-tick", `sri:${LEDGER_DIR}/sri-tick.yaml`, "active"],
    ]);
    expect(read.errors).toEqual([
      { file: `sri:${LEDGER_DIR}/a.yaml`, error: `${LEDGER_DIR}/a.yaml already has the id a` },
      { file: `sri:${LEDGER_DIR}/c.yaml`, error: `${LEDGER_DIR}/a.yaml already claims launchd com.x.a` },
    ]);
    // A repo that does not own sri cannot replace the mirror.
    const other = await multiLedger(fixed([mirror]), {
      reposPath: "/r.json",
      readText: repos([{ label: "x", repo: "/x" }]),
      source: () => fixed([owned]),
    }).read();
    expect(other.intents.map((one) => one.file)).toEqual([`${LEDGER_DIR}/sri-tick.yaml`]);
    expect(other.errors[0]?.error).toContain("already has the id sri-tick");
  });

  test("gitLedger reads the named ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "loops-ledger-ref-"));
    roots.push(root);
    const repo = join(root, "repo");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    execFileSync("git", ["init", "-q", "-b", "dev", repo]);
    await cp(FIXTURE, join(repo, LEDGER_DIR), { recursive: true });
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ledger", "--no-verify");
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    const read = await gitLedger(repo, { ref: "origin/dev" }).read();
    expect(read.intents.length).toBeGreaterThanOrEqual(23);
    await expect(gitLedger(repo).read()).rejects.toThrow();
  });

  test("a repo that fails stands on its last good read; one never read is reported unread", async () => {
    let fail = false;
    const ledger = multiLedger(fixed([row("a")]), {
      reposPath: "/r.json",
      readText: repos([{ label: "two", repo: "/two" }]),
      source: () =>
        ({
          where: { repo: "/two", path: "" },
          read: async () => {
            if (fail) throw new Error("lock");
            return { intents: [row("b")], errors: [], sha: "b".repeat(40) };
          },
        }) as LedgerSource,
    });
    expect((await ledger.read()).unread).toBeUndefined();
    fail = true;
    const after = await ledger.read();
    expect(after.intents.map((one) => one.id)).toEqual(["a", "b"]);
    expect(after.unread).toBeUndefined();
    expect(after.errors[0]?.error).toBe("could not be read at origin/main: lock; its last read (bbbbbbbbb) stands in");
    const never = await multiLedger(fixed([row("a")]), {
      reposPath: "/r.json",
      readText: repos([{ label: "down", repo: "/down" }]),
      source: () =>
        ({ where: { repo: "/down", path: "" }, read: () => Promise.reject(new Error("x")) }) as LedgerSource,
    }).read();
    expect(never.unread).toEqual(["down"]);
    expect(never.intents.map((one) => one.id)).toEqual(["a"]);
  });

  test("a repo dropped from the file is forgotten: re-added, it is made afresh", async () => {
    let list: unknown[] = [{ label: "two", repo: "/two" }];
    let made = 0;
    const ledger = multiLedger(fixed([]), {
      reposPath: "/r.json",
      readText: async () => JSON.stringify({ repos: list }),
      source: () => {
        made += 1;
        return fixed([row("b")]);
      },
    });
    await ledger.read();
    list = [];
    expect((await ledger.read()).intents).toEqual([]);
    list = [{ label: "two", repo: "/two" }];
    await ledger.read();
    expect(made).toBe(2);
  });

  test("the repos file: absent is none; present but unreadable is said", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loop-repos-"));
    roots.push(dir);
    expect((await multiLedger(fixed([]), { reposPath: join(dir, "none.json") }).read()).errors).toEqual([]);
    const said = await multiLedger(fixed([]), { reposPath: dir }).read(); // a directory: EISDIR
    expect(said.errors[0]).toMatchObject({ file: dir, error: expect.stringContaining("could not be read") });
    expect(parseLoopRepos('{"repos": [{"label": "a", "repo": "rel/path"}]}').errors[0]).toContain("absolute path");
  });

  test("only the owner's row in the owned scope replaces a mirror", async () => {
    const mirror = row("sri-tick", {
      scope: "sri",
      desired: null,
      owner: "sri-orchestrator",
      substrate: { kind: "paseo-heartbeat", ref: "name:sri-tick" },
    });
    const read = await multiLedger(fixed([mirror]), {
      reposPath: "/r.json",
      readText: repos([{ label: "sri", repo: "/s", owns: "sri" }]),
      // the owner repo's broomva-scope row with the mirror's id: a clash, not a replacement
      source: () => fixed([row("sri-tick", { substrate: { kind: "launchd", ref: "com.x.other" } })]),
    }).read();
    expect(read.intents.map((one) => one.file)).toEqual([`${LEDGER_DIR}/sri-tick.yaml`]);
    expect(read.errors[0]?.error).toContain("already has the id sri-tick");
  });
});
