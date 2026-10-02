import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHCTL, Launchd, LOG, NotARead, PLUTIL, PS, type Runner, readOnly } from "./launchd";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = Date.parse("2026-10-02T21:20:00Z");

describe("the timeline only reads", () => {
  const calls: string[] = [];
  const run = readOnly(async (command, args) => {
    calls.push([command, ...args].join(" "));
    return { stdout: "", code: 0 };
  });

  test("launchctl may list and print, and nothing else", async () => {
    await run(LAUNCHCTL, ["list"], { timeoutMs: 1000 });
    await run(LAUNCHCTL, ["print", "gui/501/com.broomva.kg-lint"], { timeoutMs: 1000 });
    for (const verb of [
      "load",
      "unload",
      "bootstrap",
      "bootout",
      "kickstart",
      "kill",
      "enable",
      "disable",
      "start",
      "stop",
      "remove",
      "submit",
    ]) {
      await expect(run(LAUNCHCTL, [verb, "gui/501/com.broomva.kg-lint"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(
        NotARead,
      );
    }
    // print with more than its target is not a plain read either.
    await expect(run(LAUNCHCTL, ["print", "gui/501/x", "extra"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(NotARead);
    expect(calls).toEqual(["/bin/launchctl list", "/bin/launchctl print gui/501/com.broomva.kg-lint"]);
  });

  test("plutil only converts to stdout; log only shows; ps only reads what the timeline asks", async () => {
    await expect(run(PLUTIL, ["-convert", "json", "-o", "-", "/x.plist"], { timeoutMs: 1000 })).resolves.toBeDefined();
    await expect(run(PLUTIL, ["-convert", "json", "/x.plist"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(NotARead);
    await expect(
      run(PLUTIL, ["-replace", "Label", "-string", "x", "/x.plist"], { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(NotARead);
    await expect(run(LOG, ["erase", "--all"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(NotARead);
    await expect(run(LOG, ["config", "--mode", "level:off"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(NotARead);
    await expect(run("/usr/sbin/sysctl", ["-w", "kern.waketime=0"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      NotARead,
    );
    await expect(run(PS, ["-o", "etime=", "-p", "1"], { timeoutMs: 1000 })).resolves.toBeDefined();
    await expect(run("/bin/kill", ["-9", "1"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(NotARead);
    await expect(run("/bin/sh", ["-c", "launchctl list"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(NotARead);
  });
});

const exitLine = (label: string, pid: number, timestamp: string, message: string) =>
  JSON.stringify({ subsystem: `gui/501/${label} [${pid}]`, eventMessage: message, timestamp });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "maestro-launchd-"));
  roots.push(root);
  const agents = join(root, "LaunchAgents");
  await mkdir(agents, { recursive: true });
  const logs = join(root, "logs");
  await mkdir(logs, { recursive: true });
  const plists: Record<string, Record<string, unknown>> = {
    "com.broomva.kg-compile": {
      Label: "com.broomva.kg-compile",
      StartCalendarInterval: { Hour: 2, Minute: 0 },
      StandardOutPath: join(logs, "kg-compile.log"),
    },
    "com.broomva.moltbook-loop": { Label: "com.broomva.moltbook-loop", StartInterval: 900 },
    "com.broomva.old-job": { Label: "com.broomva.old-job", StartInterval: 60 },
  };
  for (const label of Object.keys(plists)) await writeFile(join(agents, `${label}.plist`), "<plist/>");
  await writeFile(join(logs, "kg-compile.log"), "[2026-10-02T07:00:01Z] pass 'compile' done (rc=0)\n");
  await utimes(join(logs, "kg-compile.log"), new Date("2026-10-02T07:00:18Z"), new Date("2026-10-02T07:00:18Z"));
  const calls: string[][] = [];
  let shown = [
    exitLine("com.broomva.moltbook-loop", 1, "2026-10-02 16:02:37.810720-0500", "exited due to exit(0), ran for 22ms"),
    exitLine("com.broomva.kg-compile", 2, "2026-10-02 02:00:18.592358-0500", "exited due to exit(0), ran for 17000ms"),
    '{"count":2,"finished":1}',
  ].join("\n");
  let listFails = false;
  let listExit = 0;
  let showExit = 0;
  let printFails = false;
  const brokenPlists = new Set<string>();
  const run: Runner = async (command, args, options) => {
    calls.push([command, ...args, ...(options.firstLine ? ["(first line)"] : [])]);
    if (command === LAUNCHCTL && args[0] === "list") {
      if (listFails) throw new Error("launchctl is unhappy");
      if (listExit !== 0) return { stdout: "", code: listExit };
      return {
        stdout:
          "PID\tStatus\tLabel\n-\t0\tcom.broomva.kg-compile\n4321\t0\tcom.broomva.moltbook-loop\n-\t0\tcom.apple.x\n",
        code: 0,
      };
    }
    if (command === LAUNCHCTL && args[0] === "print") {
      if (printFails) return { stdout: "", code: 113 };
      const label = String(args[1]).split("/").pop() ?? "";
      const running = label === "com.broomva.moltbook-loop";
      return {
        stdout: `x = {\n\tpath = ${join(agents, `${label}.plist`)}\n\tstate = ${running ? "running" : "not running"}\n${running ? "\tpid = 4321\n" : ""}\truns = 3\n\tlast exit code = 0\n}`,
        code: 0,
      };
    }
    if (command === PLUTIL) {
      const label =
        String(args[4])
          .split("/")
          .pop()
          ?.replace(/\.plist$/, "") ?? "";
      // plutil on a missing or broken plist: nothing on stdout, its error on stderr, exit 1.
      if (brokenPlists.has(label)) return { stdout: "", code: 1 };
      return { stdout: JSON.stringify(plists[label] ?? {}), code: 0 };
    }
    if (command === PS) return { stdout: "  02:00\n", code: 0 };
    if (command === LOG && options.firstLine) {
      return { stdout: JSON.stringify({ timestamp: "2026-10-01 22:01:16.787692-0500" }), code: 0 };
    }
    if (command === LOG) return { stdout: showExit === 0 ? shown : "", code: showExit };
    throw new Error(`unexpected ${command}`);
  };
  let now = NOW;
  const launchd = new Launchd({
    run,
    uid: 501,
    agentsDir: agents,
    now: () => now,
    awakeSince: async () => 1790948115000,
  });
  return {
    launchd,
    calls,
    agents,
    setShown: (text: string) => (shown = text),
    setNow: (at: number) => (now = at),
    failList: () => (listFails = true),
    exitList: (code: number) => (listExit = code),
    exitShow: (code: number) => (showExit = code),
    failPrint: () => (printFails = true),
    breakPlist: (label: string) => brokenPlists.add(label),
  };
}

describe("reading the jobs", () => {
  test("each job under the prefix: loaded or not, its plist, its log's end, a run going and when it began", async () => {
    const { launchd } = await setup();
    const read = await launchd.read();
    expect(read.jobs.map((job) => [job.label, job.loaded, job.running])).toEqual([
      ["com.broomva.kg-compile", true, false],
      ["com.broomva.moltbook-loop", true, true],
      // A plist in LaunchAgents that launchd has not loaded.
      ["com.broomva.old-job", false, false],
    ]);
    const [compile, molt, old] = read.jobs;
    expect(compile?.plist?.StartCalendarInterval).toEqual({ Hour: 2, Minute: 0 });
    expect(compile?.logText).toContain("pass 'compile' done");
    expect(compile?.logWrittenAt).toBe(Date.parse("2026-10-02T07:00:18Z"));
    expect(molt?.runningSince).toBe(NOW - 120_000);
    expect(old?.printed).toBeNull();
    expect(read.awakeSince).toBe(1790948115 * 1000);
    expect(read.warnings).toEqual([]);
  });

  test("the unified log: a day of run ends once, then only what came since, kept without repeats", async () => {
    const { launchd, calls, setShown, setNow } = await setup();
    const first = await launchd.read();
    expect(first.exits.map((exit) => [exit.label, exit.exit])).toEqual([
      ["com.broomva.kg-compile", 0],
      ["com.broomva.moltbook-loop", 0],
    ]);
    // It reaches back as far as the oldest event the log holds, or the oldest run end, whichever is older.
    expect(first.coverage).toBe(Date.parse("2026-10-02T03:01:16.787Z"));
    const shows = () => calls.filter((call) => call[0] === LOG);
    expect(shows().map((call) => call.slice(1, 3))).toEqual([
      ["show", "--last"],
      ["show", "--last"],
    ]);
    expect(shows()[0]?.join(" ")).toContain('subsystem BEGINSWITH "gui/501/com.broomva."');
    expect(shows().filter((call) => call.includes("(first line)"))).toHaveLength(1);

    setNow(NOW + 60_000);
    setShown(
      [
        // The edge the last read already saw, and one new run end.
        exitLine(
          "com.broomva.moltbook-loop",
          1,
          "2026-10-02 16:02:37.810720-0500",
          "exited due to exit(0), ran for 22ms",
        ),
        exitLine(
          "com.broomva.moltbook-loop",
          9,
          "2026-10-02 16:17:37.000000-0500",
          "exited due to exit(2), ran for 30ms",
        ),
      ].join("\n"),
    );
    const second = await launchd.read();
    expect(second.exits.map((exit) => exit.exit)).toEqual([0, 0, 2]);
    const last = shows()[shows().length - 1] ?? [];
    expect(last.slice(1, 3)).toEqual(["show", "--start"]);
    // No second probe: how far back the log reaches is read once.
    expect(shows().filter((call) => call.includes("(first line)"))).toHaveLength(1);
  });

  test("run ends older than a day and an hour are let go", async () => {
    const { launchd, setNow, setShown } = await setup();
    await launchd.read();
    setNow(NOW + 26 * 3_600_000);
    setShown("");
    const read = await launchd.read();
    expect(read.exits).toEqual([]);
    expect(read.coverage).toBe(NOW + 26 * 3_600_000 - 25 * 3_600_000);
  });

  test("a launchctl that cannot list is said, and no job is guessed at", async () => {
    const { launchd, failList } = await setup();
    failList();
    const read = await launchd.read();
    expect(read.jobs).toEqual([]);
    expect(read.warnings).toEqual(["launchctl list could not be read: launchctl is unhappy"]);
  });

  test("two reads at once are one read", async () => {
    const { launchd, calls } = await setup();
    const [a, b] = await Promise.all([launchd.read(), launchd.read()]);
    expect(a).toBe(b);
    expect(calls.filter((call) => call[0] === LAUNCHCTL && call[1] === "list")).toHaveLength(1);
  });
});

describe("a read that fails is said, and never reads as healthy", () => {
  test("a plist that will not convert costs that job its schedule, never the other jobs", async () => {
    const { launchd, breakPlist } = await setup();
    breakPlist("com.broomva.kg-compile");
    const read = await launchd.read();
    expect(read.jobs.map((job) => [job.label, job.plist === null])).toEqual([
      ["com.broomva.kg-compile", true],
      ["com.broomva.moltbook-loop", false],
      ["com.broomva.old-job", false],
    ]);
    expect(read.warnings).toEqual([expect.stringContaining("The plist of com.broomva.kg-compile could not be read")]);
  });

  test("a log show that exits non-zero is a failed read: said, and how far the evidence reaches stays put", async () => {
    const { launchd, exitShow, setNow } = await setup();
    const first = await launchd.read();
    expect(first.exitsUntil).toBe(NOW);
    exitShow(1);
    setNow(NOW + 60 * 60_000);
    const second = await launchd.read();
    expect(second.warnings).toEqual([expect.stringContaining("The unified log could not be read")]);
    expect(second.exitsUntil).toBe(NOW);
    expect(second.exits).toHaveLength(2);
  });

  test("a launchctl list that exits non-zero shows no job rather than every job unloaded", async () => {
    const { launchd, exitList } = await setup();
    exitList(5);
    const read = await launchd.read();
    expect(read.jobs).toEqual([]);
    expect(read.warnings).toEqual([
      expect.stringContaining("launchctl list could not be read: launchctl list exited 5"),
    ]);
  });

  test("a print that fails still knows a run is going, from the list's pid", async () => {
    const { launchd, failPrint } = await setup();
    failPrint();
    const read = await launchd.read();
    const molt = read.jobs.find((job) => job.label === "com.broomva.moltbook-loop");
    expect(molt).toMatchObject({ printed: null, running: true, runningSince: NOW - 120_000 });
    expect(read.warnings).toHaveLength(2);
  });

  test("each job carries when its plist was written", async () => {
    const { launchd } = await setup();
    const read = await launchd.read();
    expect(read.jobs.every((job) => typeof job.installedAt === "number")).toBe(true);
  });

  test("a prefix that is not a label prefix is refused before anything runs", () => {
    expect(() => new Launchd({ prefix: 'com.broomva." OR process == "x' })).toThrow("Not a launchd label prefix");
    expect(() => new Launchd({ prefix: "" })).toThrow("Not a launchd label prefix");
  });
});
