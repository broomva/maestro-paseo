import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarSpecs, dueTimes } from "./cron";
import { sleptThrough } from "./fake-awake";
import { execRunner, LAUNCHCTL, Launchd, LOG, NotARead, PLUTIL, PS, type Runner, readOnly } from "./launchd";
import { EVIDENCE_MS, logStartArg } from "./launchd-model";
import { launchdSource } from "./timeline-model";

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

const H = 3_600_000;
const M = 60_000;
const two = (n: number) => String(n).padStart(2, "0");

/** A time as `log show` writes it: the Mac's own zone, with its offset. */
function localStamp(at: number): string {
  const d = new Date(at);
  const offset = -d.getTimezoneOffset();
  const zone = `${offset >= 0 ? "+" : "-"}${two(Math.floor(Math.abs(offset) / 60))}${two(Math.abs(offset) % 60)}`;
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${ms}000${zone}`;
}

/** `log show --start`'s argument back to an instant: `YYYY-MM-DD HH:MM:SS+0000`, UTC, to the second. */
function startOf(args: readonly string[], now: number): number {
  const at = args.indexOf("--start");
  if (at < 0) return now - 24 * H;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\+0000$/.exec(String(args[at + 1]));
  if (!match) throw new Error(`not a UTC start: ${args[at + 1]}`);
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
}

/** The first launchd event a log holds at or after `from`: launchd writes every minute, and the log forgets past `retain`. */
const heldFrom = (from: number, now: number, retain: number) => Math.ceil(Math.max(from, now - retain) / M) * M;

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
  let compileStatus = 0;
  let showExit = 0;
  let printFails = false;
  let probeFails = false;
  let retain = 19 * H;
  let listed = ["com.broomva.kg-compile", "com.broomva.moltbook-loop"];
  const brokenPlists = new Set<string>();
  const run: Runner = async (command, args, options) => {
    calls.push([command, ...args, ...(options.firstLine ? ["(first line)"] : [])]);
    if (command === LAUNCHCTL && args[0] === "list") {
      if (listFails) throw new Error("launchctl is unhappy");
      if (listExit !== 0) return { stdout: "", code: listExit };
      const rows = listed.map((label) =>
        label === "com.broomva.kg-compile"
          ? `-\t${compileStatus}\t${label}`
          : label.includes("moltbook")
            ? `4321\t0\t${label}`
            : `-\t0\t${label}`,
      );
      return { stdout: `PID\tStatus\tLabel\n${rows.join("\n")}\n-\t0\tcom.apple.x\n`, code: 0 };
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
      if (probeFails) throw new Error("log took longer than 90 s");
      return { stdout: JSON.stringify({ timestamp: localStamp(heldFrom(startOf(args, now), now, retain)) }), code: 0 };
    }
    if (command === LOG) return { stdout: showExit === 0 ? shown : "", code: showExit };
    throw new Error(`unexpected ${command}`);
  };
  let now = NOW;
  const launchd = new Launchd({ run, uid: 501, agentsDir: agents, now: () => now });
  return {
    launchd,
    calls,
    agents,
    setShown: (text: string) => (shown = text),
    setNow: (at: number) => (now = at),
    failList: () => (listFails = true),
    unfailList: () => (listFails = false),
    exitList: (code: number) => (listExit = code),
    exitShow: (code: number) => (showExit = code),
    failPrint: () => (printFails = true),
    failProbe: () => (probeFails = true),
    unfailProbe: () => (probeFails = false),
    setRetain: (ms: number) => (retain = ms),
    setListed: (labels: string[]) => (listed = labels),
    listStatus: (code: number) => (compileStatus = code),
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
    expect(read.warnings).toEqual([]);
  });

  test("the unified log: a day of run ends once, then only what came since, kept without repeats", async () => {
    const { launchd, calls, setShown, setNow } = await setup();
    const first = await launchd.read();
    expect(first.exits.map((exit) => [exit.label, exit.exit])).toEqual([
      ["com.broomva.kg-compile", 0],
      ["com.broomva.moltbook-loop", 0],
    ]);
    const shows = () => calls.filter((call) => call[0] === LOG);
    // Both queries start a day back; the log proves it holds only its last 19 h, so that is what was seen.
    const dayBack = logStartArg(Math.floor((NOW - 24 * H) / 1000) * 1000);
    expect(shows().map((call) => call.slice(1, 3))).toEqual([
      ["show", "--start"],
      ["show", "--start"],
    ]);
    expect(shows().every((call) => call[3] === dayBack)).toBe(true);
    expect(shows()[0]?.join(" ")).toContain('subsystem BEGINSWITH "gui/501/com.broomva."');
    expect(first.seen).toEqual({ from: heldFrom(NOW - 24 * H, NOW, 19 * H), to: NOW });

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
    const start = logStartArg(Math.floor((NOW - 2 * M) / 1000) * 1000);
    expect(
      shows()
        .slice(-2)
        .every((call) => call[3] === start),
    ).toBe(true);
    // Every read probes; this one found the log still holding where the last ended, so the stretch goes on.
    expect(shows().filter((call) => call.includes("(first line)"))).toHaveLength(2);
    expect(second.seen).toEqual({ from: heldFrom(NOW - 24 * H, NOW, 19 * H), to: NOW + 60_000 });
  });

  test("after a gap the log no longer holds, only what it proves it holds now is seen", async () => {
    const { launchd, setNow, setShown, calls } = await setup();
    const first = await launchd.read();
    expect(first.seen?.to).toBe(NOW);
    setNow(NOW + 26 * H);
    setShown("");
    const read = await launchd.read();
    // Run ends are kept as long as the evidence they prove: eight days, so these two stay.
    expect(read.exits).toHaveLength(2);
    // It asked from where it last stopped; the log begins 19 h back now, so the stretch begins there, not before.
    const last = calls.filter((call) => call[0] === LOG).at(-1) ?? [];
    expect(last.slice(1, 3)).toEqual(["show", "--start"]);
    expect(last[3]).toBe(logStartArg(Math.floor((NOW - 2 * M) / 1000) * 1000));
    expect(read.seen).toEqual({ from: heldFrom(NOW + 26 * H - 19 * H, NOW + 26 * H, 19 * H), to: NOW + 26 * H });
  });

  test("the stretch keeps no further back than its run ends are kept, however long the reads go on", async () => {
    const { launchd, setNow, setShown } = await setup();
    setShown("");
    await launchd.read();
    // A read every hour for nine days: the stretch would reach back nine days, but run ends are kept eight.
    for (let hour = 1; hour <= 9 * 24; hour += 1) {
      setNow(NOW + hour * H);
      await launchd.read();
    }
    const read = await launchd.read();
    expect(read.seen?.from).toBe(NOW + 9 * 24 * H - EVIDENCE_MS);
  });

  test("a weekly job's run that ended days ago, read every hour since, is not called missed", async () => {
    const { launchd, setNow, setShown } = await setup();
    // The job: Sundays at 09:00, no log of its own; it ran on Sunday 4 October, 09:00:05 local.
    const ran = new Date(2026, 9, 4, 9, 0, 5).getTime();
    setNow(ran - 23 * H);
    setShown("");
    await launchd.read();
    let read = await launchd.read();
    for (let at = ran - 22 * H; at <= ran + 3 * 24 * H; at += H) {
      setNow(at);
      setShown(
        at >= ran && at - H < ran
          ? exitLine("com.broomva.moltbook-loop", 7, localStamp(ran), "exited due to exit(0), ran for 5000ms")
          : "",
      );
      read = await launchd.read();
      const job = read.jobs.find((one) => one.label === "com.broomva.moltbook-loop");
      if (!job) throw new Error("no job");
      const weekly = {
        ...job,
        plist: { StartCalendarInterval: { Weekday: 0, Hour: 9, Minute: 0 } },
        logText: null,
        logWrittenAt: null,
        running: false,
        runningSince: null,
      };
      const source = launchdSource(
        weekly,
        {
          exits: read.exits.filter((exit) => exit.label === job.label),
          seen: read.seen,
          awake: sleptThrough(at),
          prefix: "com.broomva.",
        },
        { now: at, from: at - 24 * H, to: at + 24 * H },
      );
      expect({ at: new Date(at).toISOString(), status: source.status }).not.toMatchObject({ status: "missed" });
    }
  });

  test("a list that fails holds what the log said about loading until a list reads", async () => {
    const { launchd, setNow, failList, unfailList } = await setup();
    await launchd.read();
    // A gap the log no longer holds, on a read whose list fails: the restart waits for the next list.
    setNow(NOW + 26 * H);
    failList();
    await launchd.read();
    unfailList();
    setNow(NOW + 26 * H + 5 * M);
    const read = await launchd.read();
    expect(read.jobs.find((job) => job.label === "com.broomva.kg-compile")?.loadedSince).toBe(NOW + 26 * H + 5 * M);
  });

  test("a LaunchAgents folder that cannot be read is said", async () => {
    const root = await mkdtemp(join(tmpdir(), "maestro-launchd-"));
    roots.push(root);
    const file = join(root, "not-a-folder");
    await writeFile(file, "");
    const launchd = new Launchd({
      run: async () => ({ stdout: "PID\tStatus\tLabel\n", code: 0 }),
      uid: 501,
      agentsDir: file,
      now: () => NOW,
    });
    const read = await launchd.read();
    expect(
      read.warnings.some((warning) => warning.includes("could not be read, so jobs not loaded are not shown")),
    ).toBe(true);
  });

  test("a log that forgot even the minutes just after the last read ended starts the stretch again", async () => {
    const { launchd, setNow, setRetain } = await setup();
    await launchd.read();
    // An hour on, the log holds only from four minutes after the last read ended: those four are unseen.
    setNow(NOW + H);
    setRetain(H - 4 * M);
    const read = await launchd.read();
    expect(read.seen).toEqual({ from: NOW + 4 * M, to: NOW + H });
  });

  test("a probe that fails changes nothing but the run ends: the stretch stays, the next read proves the same range", async () => {
    const { launchd, failProbe, unfailProbe, setNow, calls } = await setup();
    const first = await launchd.read();
    failProbe();
    setNow(NOW + 5 * M);
    const failed = await launchd.read();
    expect(failed.seen).toEqual(first.seen);
    expect(failed.warnings).toEqual([
      expect.stringContaining("How far back the unified log reaches could not be read"),
    ]);
    // Loaded-since does not start over on a failed probe.
    expect(failed.jobs.find((job) => job.label === "com.broomva.kg-compile")?.loadedSince).toBe(NOW);
    unfailProbe();
    setNow(NOW + 10 * M);
    const next = await launchd.read();
    const starts = calls.filter((call) => call[0] === LOG && !call.includes("(first line)")).map((call) => call[3]);
    // The failed read's start, read again: it proves the range the failed one could not.
    expect(starts.at(-1)).toBe(starts.at(-2));
    expect(next.seen).toEqual({ from: first.seen?.from ?? 0, to: NOW + 10 * M });
  });

  test("rows kept through a failed list say no run is going: the log's run ends say how it ended", async () => {
    const { launchd, setNow, setShown, failList } = await setup();
    const first = await launchd.read();
    expect(first.jobs.find((job) => job.label === "com.broomva.moltbook-loop")?.running).toBe(true);
    setNow(NOW + H);
    failList();
    setShown(
      exitLine("com.broomva.moltbook-loop", 4321, localStamp(NOW + 30 * M), "exited due to exit(1), ran for 600000ms"),
    );
    const read = await launchd.read();
    const molt = read.jobs.find((job) => job.label === "com.broomva.moltbook-loop");
    expect(molt).toMatchObject({ running: false, runningSince: null, loadedSince: null });
    expect(read.exits.some((exit) => exit.label === "com.broomva.moltbook-loop" && exit.exit === 1)).toBe(true);
  });

  test("a run going at the last list is going still through a failed list, until the log records its end", async () => {
    const { launchd, setNow, setShown, failList } = await setup();
    await launchd.read();
    setNow(NOW + 5 * M);
    failList();
    setShown("");
    const read = await launchd.read();
    // No end of it in the log: still going, so launchd's last exit (the run before) never stands in for it.
    expect(read.jobs.find((job) => job.label === "com.broomva.moltbook-loop")).toMatchObject({
      running: true,
      loadedSince: null,
    });
    // The run before's end (another pid), logged after the list began, is not this run's.
    setNow(NOW + 10 * M);
    setShown(
      exitLine("com.broomva.moltbook-loop", 4320, localStamp(NOW + M), "exited due to exit(1), ran for 600000ms"),
    );
    const before = await launchd.read();
    expect(before.jobs.find((job) => job.label === "com.broomva.moltbook-loop")?.running).toBe(true);
  });

  test("an unload the log shows on a read whose list fails still starts loaded-since again", async () => {
    const { launchd, setNow, setShown, failList, unfailList } = await setup();
    await launchd.read();
    setNow(NOW + H);
    failList();
    setShown(
      JSON.stringify({
        subsystem: "gui/501 [100024]",
        eventMessage: "removing service: com.broomva.moltbook-loop",
        timestamp: localStamp(NOW + 30 * M),
      }),
    );
    const failing = await launchd.read();
    // While the list fails, the jobs show as the last list read them, and it is said.
    expect(failing.jobs.map((job) => job.label)).toContain("com.broomva.moltbook-loop");
    expect(failing.warnings).toContain("launchd's jobs are shown as the last list read them.");
    unfailList();
    setShown("");
    setNow(NOW + 2 * H);
    const read = await launchd.read();
    expect(read.jobs.find((job) => job.label === "com.broomva.moltbook-loop")?.loadedSince).toBe(NOW + 2 * H);
    expect(read.jobs.find((job) => job.label === "com.broomva.kg-compile")?.loadedSince).toBe(NOW);
  });

  test("an unload the log shows between two reads that both saw the job loaded starts its loaded-since again", async () => {
    const { launchd, setNow, setShown } = await setup();
    const first = await launchd.read();
    expect(first.jobs.find((job) => job.label === "com.broomva.moltbook-loop")?.loadedSince).toBe(NOW);
    setNow(NOW + H);
    setShown(
      [
        JSON.stringify({
          subsystem: "gui/501/com.broomva.moltbook-loop",
          eventMessage: "bootout initiated by: launchctl[1]<-zsh[2]",
          timestamp: localStamp(NOW + 30 * M),
        }),
        JSON.stringify({
          subsystem: "gui/501 [100024]",
          eventMessage: "removing service: com.broomva.moltbook-loop",
          timestamp: localStamp(NOW + 30 * M),
        }),
      ].join("\n"),
    );
    const read = await launchd.read();
    expect(read.jobs.find((job) => job.label === "com.broomva.moltbook-loop")?.loadedSince).toBe(NOW + H);
    expect(read.jobs.find((job) => job.label === "com.broomva.kg-compile")?.loadedSince).toBe(NOW);
    // The next read overlaps this one and sees the same unload: it is not new, so nothing starts again.
    setNow(NOW + 2 * H);
    const again = await launchd.read();
    expect(again.jobs.find((job) => job.label === "com.broomva.moltbook-loop")?.loadedSince).toBe(NOW + H);
  });

  test("a stretch that starts again (a gap the log no longer holds) starts every job's loaded-since again", async () => {
    const { launchd, setNow } = await setup();
    await launchd.read();
    setNow(NOW + 26 * H);
    const read = await launchd.read();
    expect(read.jobs.find((job) => job.label === "com.broomva.kg-compile")?.loadedSince).toBe(NOW + 26 * H);
  });

  test("loaded-since is the first read that saw a job loaded; an unload and a reload start it again", async () => {
    const { launchd, setNow, setListed } = await setup();
    const since = (read: Awaited<ReturnType<typeof launchd.read>>, label: string) =>
      read.jobs.find((job) => job.label === label)?.loadedSince;
    const first = await launchd.read();
    expect(since(first, "com.broomva.moltbook-loop")).toBe(NOW);
    expect(since(first, "com.broomva.old-job")).toBeNull();
    setNow(NOW + H);
    setListed(["com.broomva.kg-compile"]);
    const unloaded = await launchd.read();
    expect(since(unloaded, "com.broomva.moltbook-loop")).toBeNull();
    expect(since(unloaded, "com.broomva.kg-compile")).toBe(NOW);
    setNow(NOW + 2 * H);
    setListed(["com.broomva.kg-compile", "com.broomva.moltbook-loop"]);
    const reloaded = await launchd.read();
    expect(since(reloaded, "com.broomva.moltbook-loop")).toBe(NOW + 2 * H);
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

  test("a log show that exits non-zero is a failed read: said, and what was seen stays put", async () => {
    const { launchd, exitShow, setNow } = await setup();
    const first = await launchd.read();
    expect(first.seen?.to).toBe(NOW);
    exitShow(1);
    setNow(NOW + 60 * 60_000);
    const second = await launchd.read();
    expect(second.warnings).toEqual([expect.stringContaining("The unified log could not be read")]);
    expect(second.seen).toEqual(first.seen);
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

  test("print failing, the list's non-zero exit is the last exit; its 0 is not", async () => {
    const { launchd, failPrint, listStatus } = await setup();
    failPrint();
    listStatus(1);
    const failing = await launchd.read();
    expect(failing.jobs.find((job) => job.label === "com.broomva.kg-compile")?.lastExit).toBe(1);
    listStatus(0);
    const quiet = await launchd.read();
    expect(quiet.jobs.find((job) => job.label === "com.broomva.kg-compile")?.lastExit).toBeNull();
  });

  test("a prefix that is not a label prefix is refused before anything runs", () => {
    expect(() => new Launchd({ prefix: 'com.broomva." OR process == "x' })).toThrow("Not a launchd label prefix");
    expect(() => new Launchd({ prefix: "" })).toThrow("Not a launchd label prefix");
  });
});

/** A small seeded random, so a failing sequence can be run again. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("what was seen is what the log held", () => {
  test("over many reads, gaps longer than the log keeps, and a job unloaded and reloaded, no run it did not see is called missed", async () => {
    const label = "com.broomva.job";
    // Hourly, six-hourly, daily, weekdays and weekly: a long period is what lets a gap, or a run let go, swallow
    // the only run since the last.
    const cadences = [
      { Minute: 0 },
      [0, 6, 12, 18].map((Hour) => ({ Hour, Minute: 0 })),
      { Hour: 4, Minute: 0 },
      [1, 2, 3, 4, 5].map((Weekday) => ({ Weekday, Hour: 9, Minute: 0 })),
      { Weekday: 0, Hour: 9, Minute: 0 },
    ];
    let found = 0;
    for (let seed = 1; seed <= 90; seed += 1) {
      const random = mulberry32(seed);
      const calendar = cadences[seed % cadences.length];
      const specs = calendarSpecs(calendar);
      if (!specs) throw new Error("did not read");
      const t0 = Date.parse("2026-10-01T00:00:00Z");
      const end = t0 + 10 * 24 * H;
      // Half the seeds read as a daemon with a client open does, every few minutes for days; half sparsely.
      const dense = random() < 0.5;
      const retain = (12 + random() * 12) * H;
      // The truth: due every hour; unloaded over one stretch; a few due times skipped while loaded. No log file.
      // Unloaded once: half the time for hours; half the time for minutes around one of its own due times,
      // which reads mostly fall either side of, so only the log's "removing service" line shows it.
      const own = dueTimes(specs, undefined, t0 + 24 * H, t0 + 9 * 24 * H, 1000);
      const around = own[Math.floor(random() * own.length)] ?? t0 + 2 * 24 * H;
      const short = random() < 0.5;
      const unloadAt = short ? around - (1 + random() * 20) * M : t0 + random() * 9 * 24 * H;
      const unloadUntil = short ? around + (5 + random() * 25) * M : unloadAt + random() * 10 * H;
      const loadedAt = (at: number) => !(at >= unloadAt && at < unloadAt + (unloadUntil - unloadAt));
      const due = dueTimes(specs, undefined, t0 - 25 * H, end, 100_000);
      const skipped = new Set(due.filter(() => random() < 0.1));
      const ends = due.filter((at) => loadedAt(at) && !skipped.has(at)).map((at) => at + 5000);
      let now = t0;
      let listFails = false;
      const run: Runner = async (command, args, options) => {
        if (command === LAUNCHCTL && args[0] === "list") {
          // Now and then the list itself fails.
          if (listFails) throw new Error("launchctl is unhappy");
          return { stdout: `PID\tStatus\tLabel\n${loadedAt(now) ? `-\t0\t${label}\n` : ""}`, code: 0 };
        }
        if (command === LAUNCHCTL) return { stdout: "x = {\n\tstate = not running\n\tlast exit code = 0\n}", code: 0 };
        if (command === PLUTIL) return { stdout: JSON.stringify({ StartCalendarInterval: calendar }), code: 0 };
        if (command === LOG) {
          const begins = heldFrom(startOf(args, now), now, retain);
          if (options.firstLine) return { stdout: JSON.stringify({ timestamp: localStamp(begins) }), code: 0 };
          const lines = ends
            .filter((at) => at >= begins && at <= now)
            .map((at) => exitLine(label, at % 99_991, localStamp(at), "exited due to exit(0), ran for 20ms"));
          // launchd logs the unload on the domain, as it does: "removing service: <label>".
          if (unloadAt >= begins && unloadAt <= now) {
            lines.push(
              JSON.stringify({
                subsystem: "gui/501 [100024]",
                eventMessage: `removing service: ${label}`,
                timestamp: localStamp(unloadAt),
              }),
            );
          }
          return { stdout: lines.join("\n"), code: 0 };
        }
        throw new Error(`unexpected ${command} ${args.join(" ")}`);
      };
      const launchd = new Launchd({ run, uid: 501, agentsDir: "/nonexistent/LaunchAgents", now: () => now });
      while (now < end) {
        // The next read: dense, every 2 to 20 minutes with a rare gap past what the log keeps; or sparse.
        const gap = random() < (dense ? 0.01 : 0.15);
        const step = gap ? (retain / H + random() * 8) * H : dense ? (2 + random() * 18) * M : (1 + random() * 120) * M;
        now = Math.min(end, now + step);
        listFails = random() < 0.05;
        const read = await launchd.read();
        const job = read.jobs.find((one) => one.label === label);
        if (!job) continue;
        const source = launchdSource(
          job,
          { exits: read.exits, seen: read.seen, awake: sleptThrough(now), prefix: "com.broomva." },
          { now, from: now - 24 * H, to: now + 24 * H },
        );
        if (source.status === "ok") {
          // "On time" never hides a true miss: no due time after its newest known run, past its grace and
          // inside what was seen, when the job was loaded and did not run.
          const newest = read.exits.reduce((latest, exit) => Math.max(latest, exit.endedAt), 0);
          const horizon = read.seen?.to ?? 0;
          const hidden = dueTimes(specs, undefined, newest, horizon - 30 * M, 1000).filter(
            (at) => loadedAt(at) && !ends.includes(at + 5000),
          );
          expect({
            seed,
            at: new Date(now).toISOString(),
            hidden: hidden.map((at) => new Date(at).toISOString()),
          }).toEqual({
            seed,
            at: new Date(now).toISOString(),
            hidden: [],
          });
          continue;
        }
        if (source.status !== "missed") continue;
        // Every miss called, and every missed run drawn, is a true one: due then, loaded, and it did not run.
        const drawn = source.runs.filter((one) => one.status === "missed").map((one) => Date.parse(one.at));
        for (const at of [Date.parse(source.since ?? ""), ...drawn]) {
          expect({ seed, at: new Date(at).toISOString(), loaded: loadedAt(at), ran: ends.includes(at + 5000) }).toEqual(
            {
              seed,
              at: new Date(at).toISOString(),
              loaded: true,
              ran: false,
            },
          );
        }
        found += 1;
      }
    }
    // Not vacuous: real misses were called.
    expect(found).toBeGreaterThan(10);
  }, 180_000);
});

describe("the real runner", () => {
  test("answers a command's output and exit code, with no shell", async () => {
    expect(await execRunner("/bin/echo", ["a b", "$HOME"], { timeoutMs: 5000 })).toEqual({
      stdout: "a b $HOME\n",
      code: 0,
    });
    expect((await execRunner("/usr/bin/false", [], { timeoutMs: 5000 })).code).toBe(1);
  });

  test("kills a command at its timeout and says so", async () => {
    const started = Date.now();
    await expect(execRunner("/bin/sleep", ["5"], { timeoutMs: 200 })).rejects.toThrow("took longer than 0 s");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("answers with the first line and stops the command, when that is all it wants", async () => {
    // `yes` writes forever: only the first line is read, and it is stopped.
    expect(await execRunner("/usr/bin/yes", ["first"], { timeoutMs: 5000, firstLine: true })).toEqual({
      stdout: "first",
      code: 0,
    });
  });

  test("refuses output past 32 MB, and a command that cannot start", async () => {
    await expect(execRunner("/usr/bin/yes", [], { timeoutMs: 20_000 })).rejects.toThrow("wrote more than 32 MB");
    await expect(execRunner("/nonexistent/binary", [], { timeoutMs: 5000 })).rejects.toThrow();
  }, 30_000);
});
