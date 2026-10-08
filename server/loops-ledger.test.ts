import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirLedger, gitLedger, LEDGER_DIR, loopPaths, parseLedger, parseRow } from "./loops-ledger";

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
