// The work the dogfood sandbox starts with: every state Maestro can show,
// across two initiatives and four projects. Folders are written in the
// on-disk contract (`_work.md` frontmatter plus `_events.jsonl`), the same
// files the engine writes, with event histories the engine could have
// produced. Three items are dispatched live by up.ts to the stand-in agent, so
// Running and the gate's "asking" phase come from real sessions.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";

/** In a repo holding this file the stand-in agent asks for permission (fake-acp.ts reads the same name). */
export const ASK_MARKER = ".dogfood-ask";

export type SeedState = "proposed" | "running" | "blocked" | "review" | "done" | "canceled";
export type SeedGroup = "review" | "blocked" | "running" | "queued" | "done";

export interface SeedExpect {
  group: SeedGroup;
  phase?: "working" | "checking" | "asking" | null;
  reason?: string;
  verdict?: string;
  /** The gate shows a look with this many decisions. */
  decided?: number;
  initiative: string | null;
  project: string | null;
}

export interface Seed {
  key: string;
  id: string;
  /** Folder under the work root: initiative / project / item. */
  folder: string[];
  title: string;
  brief: string;
  repo: string;
  gate: "human" | "auto";
  checks: Array<{ name: string; run: string }>;
  state: SeedState;
  events: Array<Record<string, unknown>>;
  /** Dispatched by up.ts once the daemon is up; written as queued. */
  live?: "running" | "asking";
  /** How the item reads once up.ts has finished (after any live dispatch). */
  expect: SeedExpect;
}

export interface SeedRepos {
  checkout: string;
  platform: string;
  /** Holds ASK_MARKER. */
  infra: string;
}

/** Built at up time: the look item and the gate verbs read naturally only for recent history. */
export function buildSeeds(now: Date, repos: SeedRepos): Seed[] {
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const human = { actor: "human" } as const;

  const run = (options: { from: number; repo: string; branch?: string }) => {
    const agentId = randomUUID();
    const branch = options.branch ?? `run/${agentId.slice(0, 8)}`;
    return {
      agentId,
      events: [
        {
          ts: at(options.from),
          type: "dispatched",
          ...human,
          agentId,
          workspaceId: `ws-${agentId.slice(0, 8)}`,
          provider: "claude/sonnet",
          branch,
          cwd: join(options.repo, ".worktrees", branch.replace("/", "-")),
        },
        { ts: at(options.from), type: "state", ...human, from: "proposed", to: "running", reason: null },
        { ts: at(options.from), type: "turn.started", actor: "agent", agentId },
      ],
    };
  };
  const ended = (agentId: string, minutesAgo: number, summary: string, error: string | null = null) => ({
    ts: at(minutesAgo),
    type: "turn.ended",
    actor: "agent",
    agentId,
    outcome: error ? "failed" : "completed",
    error,
    summary,
    turnId: "foreground-turn-1",
  });
  const checked = (
    agentId: string,
    minutesAgo: number,
    results: Array<{ name: string; run: string; ok: boolean; tail?: string }>,
  ) => {
    const token = `${agentId}:${at(minutesAgo)}:seed`;
    return [
      { ts: at(minutesAgo), type: "checks.started", actor: "maestro", token },
      {
        ts: at(minutesAgo - 1),
        type: "checks.finished",
        actor: "maestro",
        token,
        results: results.map((result) => ({
          name: result.name,
          run: result.run,
          required: true,
          ok: result.ok,
          exit: result.ok ? 0 : 1,
          durationMs: 41_000,
          timedOut: false,
          tail: result.tail ?? "",
        })),
      },
    ];
  };
  const moved = (minutesAgo: number, from: SeedState, to: SeedState, reason: string | null, actor = "maestro") => ({
    ts: at(minutesAgo),
    type: "state",
    actor,
    from,
    to,
    reason,
  });
  const created = (minutesAgo: number) => ({ ts: at(minutesAgo), type: "created", ...human });

  const look = run({ from: 180, repo: repos.checkout });
  const stuck = run({ from: 250, repo: repos.checkout });
  const approved = run({ from: 320, repo: repos.checkout });
  const failedChecks = run({ from: 140, repo: repos.platform });
  const auto = run({ from: 495, repo: repos.platform });

  const seeds: Array<Omit<Seed, "id">> = [
    {
      key: "needs-you",
      folder: ["checkout-v2", "payments", "retry-failed-card-charges"],
      title: "Retry failed card charges with backoff",
      brief:
        "Card charges that fail with a transient processor error are dropped today. Retry them with exponential backoff, three attempts with jitter, and never retry a hard decline.",
      repo: repos.checkout,
      gate: "human",
      checks: [{ name: "check", run: "bun test" }],
      state: "review",
      events: [
        created(190),
        ...look.events,
        ended(
          look.agentId,
          133,
          [
            "Charges that fail with a transient processor error now retry up to three times with jittered backoff. Hard declines are never retried.",
            "",
            "## Decided",
            "- Retry only on 5xx responses and network timeouts, because a 4xx from the processor is a real decline",
            "- Keep the retry inside the charge job, so nobody ever sees a half-retried charge",
            "- Cap the total wait at 30 seconds, so checkout never hangs on a slow processor",
            "",
            "## Ask",
            "Confirm that 30 seconds is an acceptable upper bound before a customer sees an error.",
          ].join("\n"),
        ),
        ...checked(look.agentId, 133, [{ name: "check", run: "bun test", ok: true, tail: "128 pass, 0 fail" }]),
        moved(132, "running", "review", null),
      ],
      expect: { group: "review", phase: null, decided: 3, initiative: "checkout-v2", project: "payments" },
    },
    {
      key: "stuck",
      folder: ["checkout-v2", "payments", "migrate-webhooks-to-v3-signing"],
      title: "Migrate webhooks to the v3 signing scheme",
      brief:
        "Sign outgoing webhooks with the v3 scheme and keep verifying v2 signatures for one release, so partners can move at their own pace.",
      repo: repos.checkout,
      gate: "human",
      checks: [],
      state: "blocked",
      events: [
        created(262),
        ...stuck.events,
        ended(stuck.agentId, 228, "", "The provider stopped the turn: the context window is full"),
        moved(228, "running", "blocked", "The provider stopped the turn: the context window is full"),
      ],
      expect: {
        group: "blocked",
        reason: "The provider stopped the turn: the context window is full",
        initiative: "checkout-v2",
        project: "payments",
      },
    },
    {
      key: "done",
      folder: ["checkout-v2", "cart", "show-tax-lines-in-order-summary"],
      title: "Show tax lines in the order summary",
      brief: "List each tax line under the subtotal in the order summary, with its rate, instead of one lump sum.",
      repo: repos.checkout,
      gate: "human",
      checks: [{ name: "check", run: "bun test" }],
      state: "done",
      events: [
        created(335),
        ...approved.events,
        ended(
          approved.agentId,
          290,
          "Each tax line now renders under the subtotal with its rate.\n\n## Decided\n- Round per line, then sum, to match the invoice\n\n## Ask\nApprove if the rounding rule matches finance.",
        ),
        ...checked(approved.agentId, 290, [{ name: "check", run: "bun test", ok: true, tail: "131 pass, 0 fail" }]),
        moved(289, "running", "review", null),
        { ts: at(270), type: "gate", ...human, verdict: "approve", note: "Rounding matches the invoice." },
        moved(270, "review", "done", null, "human"),
      ],
      expect: { group: "done", verdict: "Check passed · you approved", initiative: "checkout-v2", project: "cart" },
    },
    {
      key: "canceled",
      folder: ["checkout-v2", "cart", "one-page-checkout-experiment"],
      title: "Try a one-page checkout experiment",
      brief: "Prototype a one-page checkout behind a flag and compare completion rates for a week.",
      repo: repos.checkout,
      gate: "human",
      checks: [],
      state: "canceled",
      events: [created(410), moved(385, "proposed", "canceled", null, "human")],
      expect: { group: "done", verdict: "You canceled it", initiative: "checkout-v2", project: "cart" },
    },
    {
      key: "queued",
      folder: ["checkout-v2", "cart", "persist-the-cart-across-devices"],
      title: "Persist the cart across devices",
      brief: "Store the cart server-side for signed-in customers, so a cart started on a phone is there on a laptop.",
      repo: repos.checkout,
      gate: "human",
      checks: [],
      state: "proposed",
      events: [created(35)],
      expect: { group: "queued", initiative: "checkout-v2", project: "cart" },
    },
    {
      key: "running",
      folder: ["platform", "observability", "add-request-tracing-to-gateway"],
      title: "Add request tracing to the API gateway",
      brief:
        "Propagate a trace id through the gateway and log it with every upstream call, so one request can be followed end to end.",
      repo: repos.platform,
      gate: "human",
      checks: [],
      state: "proposed",
      events: [created(20)],
      live: "running",
      expect: { group: "running", phase: "working", initiative: "platform", project: "observability" },
    },
    {
      key: "checks-failed",
      folder: ["platform", "observability", "alert-on-p95-latency-regressions"],
      title: "Alert on p95 latency regressions",
      brief: "Page the on-call engineer when p95 latency rises 20% over the weekly baseline for ten minutes.",
      repo: repos.platform,
      gate: "auto",
      checks: [
        { name: "unit", run: "cargo test" },
        { name: "lint", run: "cargo clippy -- -D warnings" },
      ],
      state: "blocked",
      events: [
        created(150),
        ...failedChecks.events,
        ended(
          failedChecks.agentId,
          101,
          "The alert rule and its test are in place.\n\n## Ask\nNothing: checks decide.",
        ),
        ...checked(failedChecks.agentId, 101, [
          { name: "unit", run: "cargo test", ok: true, tail: "test result: ok. 42 passed" },
          {
            name: "lint",
            run: "cargo clippy -- -D warnings",
            ok: false,
            tail: "error: unused variable: `threshold`\n  --> src/alerts.rs:88:9",
          },
        ]),
        moved(100, "running", "blocked", "Checks failed"),
      ],
      expect: {
        group: "blocked",
        reason: "Checks failed",
        verdict: "1 of 2 checks failed",
        initiative: "platform",
        project: "observability",
      },
    },
    {
      key: "asking",
      folder: ["platform", "ci", "publish-build-cache-to-shared-bucket"],
      title: "Publish the build cache to the shared bucket",
      brief: "Upload the release build cache after each main build, so CI runners start warm.",
      repo: repos.infra,
      gate: "human",
      checks: [],
      state: "proposed",
      events: [created(15)],
      live: "asking",
      expect: { group: "review", phase: "asking", initiative: "platform", project: "ci" },
    },
    {
      key: "asking-second",
      folder: ["platform", "ci", "rotate-the-staging-deploy-key"],
      title: "Rotate the staging deploy key",
      brief: "Replace the staging deploy key and update the CI secret, so the old one stops working.",
      repo: repos.infra,
      gate: "human",
      checks: [],
      state: "proposed",
      events: [created(14)],
      live: "asking",
      expect: { group: "review", phase: "asking", initiative: "platform", project: "ci" },
    },
    {
      key: "auto-done",
      folder: ["platform", "ci", "pin-the-node-version-in-ci"],
      title: "Pin the Node version in CI",
      brief: "Pin Node 22 in every CI workflow so builds stop drifting with the runner image.",
      repo: repos.platform,
      gate: "auto",
      checks: [{ name: "check", run: "grep -rq 'node-version: 22' .github/workflows" }],
      state: "done",
      events: [
        created(500),
        ...auto.events,
        ended(auto.agentId, 470, "Every workflow now pins Node 22.\n\n## Ask\nNothing: the check decides."),
        ...checked(auto.agentId, 470, [
          { name: "check", run: "grep -rq 'node-version: 22' .github/workflows", ok: true },
        ]),
        moved(469, "running", "done", null),
      ],
      expect: { group: "done", verdict: "Check passed", initiative: "platform", project: "ci" },
    },
    {
      key: "queued-ci",
      folder: ["platform", "ci", "cache-the-rust-build"],
      title: "Cache the Rust build in CI",
      brief: "Cache the cargo registry and target directory between CI runs, keyed on Cargo.lock.",
      repo: repos.platform,
      gate: "human",
      checks: [{ name: "check", run: "cargo build --release" }],
      state: "proposed",
      events: [created(45)],
      expect: { group: "queued", initiative: "platform", project: "ci" },
    },
  ];

  return seeds.map((seed) => ({ ...seed, id: randomUUID() }));
}

export function workSource(seed: Seed, day: string): string {
  const data: Record<string, unknown> = { id: seed.id, kind: "task", state: seed.state, gate: seed.gate };
  if (seed.checks.length === 1) data.done = { check: seed.checks[0]?.run };
  else if (seed.checks.length > 1) data.done = { check: seed.checks };
  data.created = day;
  data.updated = day;
  data.repo = seed.repo;
  const yaml = YAML.stringify(data, { lineWidth: 0 }).replace(/\n+$/, "");
  return `---\n${yaml}\n---\n\n# ${seed.title}\n\n${seed.brief}\n`;
}

export async function writeSeeds(root: string, seeds: readonly Seed[], now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  for (const seed of seeds) {
    const dir = join(root, ...seed.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "_work.md"), workSource(seed, day), "utf8");
    await writeFile(join(dir, "_events.jsonl"), seed.events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  }
}

/** The one item created over RPC by up.ts, as the New work form would: an initiative, no project. */
export const RPC_SEED = {
  key: "created-over-rpc",
  title: "Write the Q4 reliability review",
  brief: "Summarize incidents, error budgets and the top three fixes for the quarter.",
  initiative: "platform",
  expect: { group: "queued", initiative: "platform", project: null } satisfies SeedExpect,
};
