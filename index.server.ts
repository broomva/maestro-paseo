import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentMethods, keepServing } from "./server/agent-socket";
import { AnswerRouter } from "./server/answer-routes";
import { AnswersLander, ghForge } from "./server/answers-landing";
import { answersStatus, landingNow } from "./server/answers-status";
import { Approvals } from "./server/approvals";
import { attentionOf } from "./server/attention";
import { Callers } from "./server/callers";
import { loadConfig, saveConfig } from "./server/config";
import { WorkspaceAsks } from "./server/control-home";
import { Engine, UserError } from "./server/engine";
import { AwakeClock, Fleet, wallClock } from "./server/fleet";
import { inspectFolder as inspect } from "./server/folders";
import { GhaSchedules } from "./server/gha";
import { FetchGate } from "./server/git";
import { createInboxProvider, Inbox } from "./server/inbox";
import { agentIds, driverRelay, ghRun, ideaWork, prStates, workspaceInitiatives } from "./server/initiatives";
import { paseoLabel } from "./server/labels";
import { Launchd, launchdPresence } from "./server/launchd";
import { Loop } from "./server/loop";
import { homeWriter, Loops } from "./server/loops";
import { gitLedger, loopPaths, loopReposPath, multiLedger } from "./server/loops-ledger";
import { firstSeenMemory, handledOf, readNeeds } from "./server/needs";
import { NoticeSnoozes } from "./server/notice-snoozes";
import { noticesOf } from "./server/notices";
import { OwnerVerbs } from "./server/owner-verbs";
import {
  approvalsPath,
  controlAskPaths,
  controlRepoPaths,
  expandHome,
  launchdPrefix,
  noticeSnoozesPath,
  p9Dir,
  paseoAgentsDir,
  paseoSchedulesDir,
  socketPath,
  verbsPath,
  verbWindowMs,
  wakeLogPath,
} from "./server/paths";
import { Records } from "./server/records";
import { ReviewReceipts, reviewId } from "./server/reviews";
import { readAttachment } from "./server/rich-ask";
import type { Paseo } from "./server/runs";
import { SessionCards } from "./server/session-cards";
import { fetchEvery, Sweep, sweepEvery } from "./server/sweep";
import { Timeline } from "./server/timeline";
import {
  decideApprovalHandler,
  promptSessionHandler,
  registerApprovalVerbs,
  registerWorkVerbs,
  workVerbHandlers,
} from "./server/verb-specs";
import { WAKE_LOG_MAX, WakeLog } from "./server/wake-log";
import { answersNotice, decideConductor, getAnswersStatus, undoConductor } from "./shared/answers";
import {
  adoptAgent,
  attentionWork,
  cancelWork,
  createWork,
  decideWork,
  dispatchWork,
  getConfig,
  getLoop,
  getWork,
  inspectFolder,
  leaveRunning,
  listWork,
  type MaestroConfig,
  setConfig,
  stopWork,
  unblockWork,
  undoWork,
  type WorkItem,
  wakeLoop,
  workForAgent,
} from "./shared/contracts";
import {
  type AnswerInput,
  answerAsk,
  type DecisionAsk,
  getFleet,
  getFleetTick,
  getWorkspaceAsks,
  homeKey,
  type ReviewVerdict,
  reviewProposal,
} from "./shared/fleet";
import {
  fileIdeaWork,
  getInitiatives,
  type Initiative,
  ideaRef,
  type ReviewAnswer,
  reviewInitiative,
  type WorkRef,
} from "./shared/initiatives";
import { galleryEnabled, kitGallery } from "./shared/kit";
import { getLoops } from "./shared/loops";
import { askHoldKey, listHandled, listNeeds, type NeedKind, type Needs, workKey } from "./shared/needs";
import { listNotices, snoozeNotice } from "./shared/notices";
import { historyWork, readWorkFile, workFiles } from "./shared/records";
import { getAskAttachment } from "./shared/rich-ask";
import { getTimeline, getTimelineLog } from "./shared/timeline";
import { decideApproval, listVerbs, promptSession, undoVerb } from "./shared/verbs";

const log = (message: string) => console.log(`[maestro] ${message}`);

/** What a decision at the gate says while it waits: what you did, in the past tense. */
function gateLabel(title: string, pending: { verdict: "approve" | "revise" | "block"; note: string }): string {
  const short = title.length > 50 ? `${title.slice(0, 47)}...` : title;
  if (pending.verdict === "block") return `Canceled ${short}`;
  if (pending.verdict === "revise") return `Changed course on ${short}: ${pending.note}`;
  return `Approved ${short}`;
}

export default function contribute(host: PluginServerContext) {
  // What holds you, a run that lands at your gate and work that stops each leave a card in the session that asked
  // (server/session-cards.ts, BRO-3008), through the latest client below. It reads what needs you and the work
  // as every read does (pure), a little after something changes and on every sweep.
  const cards = new SessionCards(
    () => latest,
    {
      holds: async () => (await needsNow()).rows,
      work: () => engine.list().then(({ items }) => items),
    },
    log,
  );

  // The host hands the plugin its daemon client only inside handlers and hooks,
  // never at startup: one client for the life of the plugin process. The agent
  // socket needs it outside both, so every handler and hook below keeps it. Until
  // the first event arrives, socket verbs that start or read a session refuse and
  // say why. On shutdown the host disposes the client before calling the cleanup
  // below, so a request answered in that window can fail; it fails with an answer.
  //
  // A decision at the gate applies on a timer, outside any handler, so the engine
  // reads the same client. One that came due before the first client (a restart
  // inside the undo window) applies as soon as the first one arrives.
  let latest: Paseo | null = null;
  // And the inbox tells you through Paseo's own push (server/inbox.ts): its provider, and the one session on it.
  // A host without providers cannot carry it: Maestro then works as before, with no push of its own.
  if (typeof host.registerProvider === "function") host.registerProvider(createInboxProvider());
  else log("this Paseo takes no plugin providers, so Maestro's inbox cannot push; Needs you still shows in Maestro");
  const inbox: Inbox = new Inbox(
    () => latest,
    async () => expandHome((await engine.settings()).workRoot),
    log,
    undefined,
    undefined,
    undefined,
    // An orchestrator's own landing pushes only if it is still at your gate on that landing after the grace.
    async (workId, landing) => {
      const { item } = await engine.get(workId);
      return item.state === "review" && item.landing === landing;
    },
    undefined,
    // The push says how many need you: needs.list's total, the header's number (BRO-3001).
    async () => (await needsNow()).summary.total,
  );
  const engine: Engine = new Engine({
    client: () => latest,
    // Paseo is the harness registry (BRO-2908): an adopted session is labelled with its work, as a dispatched one is.
    label: paseoLabel,
    landed: (before, after) => Promise.all([cards.landed(before, after), inbox.landed(before, after)]),
  });
  // Every verb of yours that changes state takes effect 8 s after you make it, and leaves a receipt (B4,
  // server/owner-verbs.ts); what agents asked leave for waits in its own file (server/approvals.ts).
  const verbs = new OwnerVerbs({ path: verbsPath(), client: () => latest, windowMs: verbWindowMs(), log });
  const approvals = new Approvals({ path: approvalsPath(), raised: () => cards.nudge() });
  const verbDeps = { verbs, engine, approvals };
  registerApprovalVerbs(verbDeps);
  registerWorkVerbs(verbDeps);
  const work = workVerbHandlers(verbDeps);
  // The workspace's own asks: the control repo's ledgers, at their homes (spec #861 §5.2).
  const control = controlRepoPaths();
  const askPaths = controlAskPaths();
  // origin is fetched once, for the asks and the loop ledger both (server/git.ts).
  const fetchGate = new FetchGate();
  const workspace = control.repo
    ? new WorkspaceAsks({
        controlRepo: control.repo,
        answersPath: control.answers,
        lockRoot: askPaths.locks,
        receipts: askPaths.receipts,
        fetchEveryMs: fetchEvery(),
        fetchGate,
        log,
      })
    : null;
  // Your answers after you give them (BRO-2827): the batch landed through one gated PR, each answer routed once.
  const lander =
    workspace && control.repo
      ? new AnswersLander({
          asks: workspace,
          controlRepo: control.repo,
          answersPath: control.answers,
          statePath: join(dirname(askPaths.receipts), "answers-landing.json"),
          forge: ghForge(),
          log,
        })
      : null;
  // Session ids to agents, one listing shared by the initiatives tab and answer routing.
  const sessionIds = agentIds(Date.now, log);
  const router =
    workspace && control.repo
      ? new AnswerRouter({
          receipts: askPaths.receipts,
          asks: workspace,
          engine,
          client: () => latest,
          controlRepo: control.repo,
          // An answer whose asker is gone may go to its initiative's driver, when that names a session (BRO-2918).
          driver: driverRelay(async (id) => (await initiatives?.one(id)) ?? null, sessionIds),
          log,
        })
      : null;
  // Where routing begins: an answer given before this is never routed (it was acted on, or not, by hand).
  void router?.begin().catch((error) => log(`answers: marking where routing begins: ${(error as Error).message}`));
  // Your decisions on answers for the conductor survive a restart: the due are applied, the rest armed again.
  void router?.resume().catch((error) => log(`answers: resuming your decisions: ${(error as Error).message}`));
  // The loop wakes on its own timer, outside any handler, so it reads the same client (server/loop.ts).
  const loop: Loop = new Loop({
    engine,
    client: () => latest,
    log,
    answers: lander && router ? { land: () => lander.land(), route: () => router.route() } : undefined,
    // Its wake sweeps first, under the sweep's lease (below), so what it reads is current.
    sweep: { run: () => sweep.run() },
  });
  // A handler only keeps the client: a read, however often it comes, starts nothing (BRO-2995). The first client
  // a hook brings sweeps now and runs the wake that had none; one a read brings waits for the next sweep.
  const keep = (paseo: Paseo | undefined, hook: boolean) => {
    // A call without one (a test's) leaves the client kept.
    if (!paseo) return;
    const first = !latest;
    latest = paseo;
    if (!first || !hook) return;
    void sweep.run();
    void loop.connected();
  };
  const server: Pick<PluginServerContext, "handle" | "on"> = {
    handle: (contract, handler) =>
      host.handle(contract, (input, context) => {
        keep(context.paseo, false);
        return handler(input, context);
      }),
    on: (name, handler) =>
      host.on(name, (event, context) => {
        keep(context.paseo, true);
        return handler(event, context);
      }),
  };

  /** A gate decision's answer: the work, and the receipt and time of the decision it now holds. */
  const receipted = (item: WorkItem) => ({
    item,
    ...(item.pending?.receipt ? { receipt: item.pending.receipt, appliesAt: item.pending.effectiveAt } : {}),
  });
  // History, a work folder's files and each run's changed line: read-only, and never on the agent socket.
  const records = new Records(() => engine.settings());
  server.handle(listWork, (_input, { paseo }) => engine.list(paseo).then((list) => records.withChanged(paseo, list)));
  server.handle(getWork, ({ id }, { paseo }) => engine.get(id).then((got) => records.withChangedItem(paseo, got)));
  // fleet-reconcile's runs (server/fleet.ts): read from the fleet's files, with the work it raised read from ours.
  // One awake clock for the plugin, so the Fleet view and the Timeline count the same awake time
  // (wall time for a test, as the Fleet view takes it: MAESTRO_PASEO_FLEET_AWAKE_CLOCK=wall).
  const awakeClock = process.env.MAESTRO_PASEO_FLEET_AWAKE_CLOCK === "wall" ? null : new AwakeClock();
  awakeClock?.start();
  const clock = awakeClock ?? wallClock();
  const fleet = new Fleet({ items: () => engine.list().then(({ items }) => items), clock, log });
  // The workspace's initiatives and their ideas (server/initiatives.ts), read under the same home rule.
  const initiatives = control.repo
    ? workspaceInitiatives({
        controlRepo: control.repo,
        answersPath: control.answers,
        asks: workspace,
        prs: prStates(ghRun, Date.now, log),
        agents: sessionIds,
        log,
      })
    : null;
  /**
   * An idea you chose to develop: a queued work item in its initiative's
   * folder, briefed from the initiative file and the idea, held for you to
   * start (`hold`: the loop and sessions leave it), and naming the idea
   * (`idea: <ledger>#<id>`) so it is filed once: an idea that has its work
   * item gets that one back. The answer is in already, so a work item that
   * cannot be filed is said, never thrown; Initiatives offers to file it again.
   */
  const filing = new Map<string, Promise<{ work: WorkRef | null; warning: string | null }>>();
  const develop = (
    ask: DecisionAsk,
    paseo: Paseo | null,
  ): Promise<{ work: WorkRef | null; warning: string | null }> => {
    const idea = ask.idea;
    if (!idea || ask.answerOption !== "develop" || !control.repo) return Promise.resolve({ work: null, warning: null });
    const ref = ideaRef(ask);
    const pending = filing.get(ref);
    if (pending) return pending;
    const run = (async () => {
      try {
        const existing = (await engine.developed()).get(ref);
        if (existing) return { work: existing, warning: null };
        const initiative = idea.initiative && initiatives ? await initiatives.one(idea.initiative) : null;
        const { title, brief } = ideaWork(initiative, ask);
        const item = await engine.create(paseo, {
          title,
          brief,
          repo: control.repo as string,
          gate: "human",
          check: "",
          initiative: idea.initiative ?? "",
          dispatch: false,
          hold: `You chose to develop the idea ${ask.ledger} ${ask.id}; it starts when you start it.`,
          idea: ref,
        });
        log(`initiatives: you chose develop for ${ask.ledger} ${ask.id}: queued ${item.id}, held for you`);
        return { work: { id: item.id, title: item.title, path: item.path }, warning: null };
      } catch (error) {
        const message = `You chose develop, and that is in ${ask.ledger}, but its work item could not be filed (${(error as Error).message}). File it again from Initiatives.`;
        log(`initiatives: ${message}`);
        return { work: null, warning: message };
      } finally {
        filing.delete(ref);
      }
    })();
    filing.set(ref, run);
    return run;
  };
  // Every scheduled thing on one axis (server/timeline.ts): Paseo's schedules, launchd, the loop, the fleet. Read-only.
  const wakes = new WakeLog(wakeLogPath(), log);
  const prefix = launchdPrefix();
  const chosen = process.env.MAESTRO_PASEO_LAUNCHD?.trim();
  if (!prefix && chosen && chosen !== "off") {
    log(`MAESTRO_PASEO_LAUNCHD=${JSON.stringify(chosen)} is not a label prefix, so the Timeline reads no launchd job`);
  }
  const timeline = new Timeline({
    launchd: prefix ? new Launchd({ prefix }) : null,
    launchdPrefix: prefix ?? undefined,
    schedulesDir: paseoSchedulesDir(),
    loop: () => loop.get(),
    wakes: () => wakes.recent(WAKE_LOG_MAX),
    wakeLogPath: wakes.path,
    fleet,
    clock,
    log,
  });
  // Every loop beside its intent (BRO-2911): the ledger on the control repo's origin/main, the Timeline's own
  // observations plus GitHub Actions and p9, reconciled; drift transitions go to ~/.broomva/ledger/loops/drift.jsonl.
  const loopHome = loopPaths();
  const loops = new Loops({
    // Plus every repo loop-repos.json names, each at its own ref (BRO-2942): one orchestrator per owning repo.
    ledger: control.repo
      ? multiLedger(gitLedger(control.repo, { fetch: true, fetchEveryMs: fetchEvery(), fetchGate, log }), {
          reposPath: loopReposPath(),
          fetchGate,
          log,
        })
      : null,
    timeline,
    schedulesDir: paseoSchedulesDir(),
    presence: prefix ? (labels) => launchdPresence(labels) : null,
    gha: control.repo ? new GhaSchedules() : null,
    p9Dir: p9Dir(),
    streams: loopHome.streams,
    notes: loopHome.notes,
    // A bound loop's session, as Paseo has it now: one that will not read is not judged (no false gone).
    agents: async (ids) => {
      const paseo = latest;
      const found = new Map<string, { found: boolean; archivedAt: string | null }>();
      if (!paseo) return found;
      for (const id of ids) {
        try {
          const agent = (await paseo.agents.ref(id).refresh())?.agent ?? null;
          // An empty answer (a client reconnecting) says nothing: only a session read is judged.
          if (agent) found.set(id, { found: true, archivedAt: agent.archivedAt ?? null });
        } catch (error) {
          const said = (error as Error).message;
          // Only Paseo's own word that the session does not exist is "not found".
          if (/not found|unknown agent|no such agent/i.test(said)) found.set(id, { found: false, archivedAt: null });
          else log(`loops: reading session ${id}: ${said}`);
        }
      }
      return found;
    },
    writer: control.repo ? homeWriter(control.repo) : null,
    log,
  });
  // The header count and pills poll this. A pure read, as every read here is (BRO-2995): the sweep writes.
  // A fleet or a timeline that cannot be read costs the count its notices, never the work's.
  server.handle(attentionWork, async () => {
    const { items } = await engine.list();
    const [notices, scheduled, workspaceAsks, fleetAsks, initiativeNotices, landing] = await Promise.all([
      fleet.notices(items).catch((error) => {
        log(`reading the fleet for the header count: ${(error as Error).message}`);
        return [];
      }),
      timeline.notices().catch((error) => {
        log(`reading the timeline for the header count: ${(error as Error).message}`);
        return [];
      }),
      (workspace?.waiting() ?? Promise.resolve([])).catch((error) => {
        log(`reading the workspace's asks for the header count: ${(error as Error).message}`);
        return [];
      }),
      fleet.waitingAsks().catch((error) => {
        log(`reading the fleet's asks for the header count: ${(error as Error).message}`);
        return [];
      }),
      (initiatives?.notices() ?? Promise.resolve([])).catch((error) => {
        log(`reading the initiatives for the header count: ${(error as Error).message}`);
        return [];
      }),
      (lander?.state() ?? Promise.resolve(null)).catch(() => null),
    ]);
    // Loop drift with its pinned fix (loopNeeds()), beside what attentionOf counts: BRO-2909 folds it into needs.list.
    const loopNotices = await loops.notices().catch((error) => {
      log(`reading the loops for the header count: ${(error as Error).message}`);
      return [];
    });
    const batch = answersNotice(landing);
    return {
      ...attentionOf(
        items,
        Date.now(),
        notices,
        scheduled,
        [...workspaceAsks, ...fleetAsks],
        initiativeNotices,
        batch ? [batch] : [],
      ),
      loops: loopNotices,
    };
  });
  // What needs you and what was handled for you (server/needs.ts, BRO-3001): the one projection every count,
  // badge, section and push reads. Pure: the work is read with no client, so no session is reconciled and no
  // decision applied (BRO-2995); the asks, as every read, with no fetch of origin/main (the sweep fetches);
  // every other source is a cached read.
  // A source that cannot be read costs its own rows, never the rest.
  const workspaceName = control.repo ? basename(control.repo) : "workspace";
  // A pure read (BRO-2995): no client, so no reconcile; the plugin sweep keeps the work true, at most SWEEP_MS stale.
  const workItems = (): Promise<WorkItem[] | null> =>
    engine
      .list()
      .then(({ items }) => items)
      .catch((error) => {
        log(`needs: reading the work: ${(error as Error).message}`);
        return null;
      });
  /** Every ask read, the workspace's and each fleet root's, and whether both were read. */
  const allAsks = async (): Promise<[DecisionAsk[], boolean]> => {
    let read = true;
    const [mine, scoped] = await Promise.all([
      (workspace?.read().then((view) => view.all) ?? Promise.resolve([])).catch((error) => {
        read = false;
        log(`needs: reading the workspace's asks: ${(error as Error).message}`);
        return [];
      }),
      fleet
        .scopeDecisions()
        .then((view) => view.asks)
        .catch((error) => {
          read = false;
          log(`needs: reading the fleet's asks: ${(error as Error).message}`);
          return [];
        }),
    ]);
    return [[...mine, ...scoped], read];
  };
  // Your answers to due reviews are receipts in the asks' log (server/reviews.ts): a review answered for the date it
  // was due is not due any more, until its date moves.
  const reviewReceipts = new ReviewReceipts(askPaths.receipts);
  const dueReviews = async (): Promise<Initiative[]> => {
    const [due, answered] = await Promise.all([
      initiatives?.reviews() ?? Promise.resolve([]),
      reviewReceipts.read().catch(() => new Map()),
    ]);
    return due.filter(
      (initiative) => !initiative.stale || !answered.has(reviewId(initiative.id, initiative.stale.date)),
    );
  };
  const snoozes = new NoticeSnoozes(noticeSnoozesPath());
  // When an undated hold was first seen (an undated ask, the answers batch), in memory only: its `since`
  // holds still across reads, and a hold that went is forgotten, so one that comes back starts again.
  const firstSeen = firstSeenMemory();
  const needsNow = (kind?: NeedKind): Promise<Needs> =>
    readNeeds(
      {
        work: workItems,
        asks: allAsks,
        reviews: dueReviews,
        landing: () => lander?.state() ?? Promise.resolve(null),
        // Which Paseo agent each Claude session is, from the fleet's reports: one prompt counts once.
        sessionAgents: () => fleet.sessionAgents(),
        // What agents asked leave for, and your decisions still in their window: files, read as they stand.
        approvals: () => approvals.open(),
        decisions: () => verbs.list(),
      },
      { workspace: workspaceName, now: Date.now(), kind, firstSeen, landing: landingNow, log },
    );
  server.handle(listNeeds, ({ kind }) => needsNow(kind));
  server.handle(listHandled, async () => {
    const [read, [asks]] = await Promise.all([workItems(), allAsks()]);
    const items = read ?? [];
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    return handledOf(items, asks, now.getTime(), dayStart.getTime());
  });
  // What you watch that went wrong (server/notices.ts): one projection, so the Health tab, the Feed's Health section
  // and J7 are the same rows. A pure read; a source that cannot be read costs its own rows, never the rest.
  const noticesNow = async () => {
    const unread: string[] = [];
    // Unread work is not no work: the stuck and quiet notices come from it, so the gap is named.
    const read = await workItems();
    if (read === null) unread.push("the work");
    const items = read ?? [];
    const quietly = <T>(what: string, read: Promise<T[]>): Promise<T[]> =>
      read.catch((error) => {
        log(`notices: reading ${what}: ${(error as Error).message}`);
        unread.push(what);
        return [];
      });
    const [fleetNotices, timelineNotices, loopNotices, reviews, snoozed] = await Promise.all([
      quietly("the fleet", fleet.notices(items)),
      quietly("the timeline", timeline.notices()),
      quietly("the loops", loops.notices()),
      quietly("the initiatives", dueReviews()),
      snoozes.read().catch((error) => {
        log(`notices: reading the snoozes: ${(error as Error).message}`);
        return new Map<string, string>();
      }),
    ]);
    return noticesOf(
      { items, fleet: fleetNotices, timeline: timelineNotices, loops: loopNotices, reviews, snoozed, unread },
      Date.now(),
    );
  };
  server.handle(listNotices, noticesNow);
  // Snooze takes effect when its undo window closes (B4); a notice that no longer holds cannot be snoozed.
  // Only a notice whose verb is Snooze can be snoozed (a quiet run): the rest close when their source does, and
  // snoozing `initiatives:due` would hide every due review. Held to this when it is sent and when the window closes.
  const snoozable = async (key: string) => {
    const row = (await noticesNow()).rows.find((one) => one.key === key);
    if (!row) throw new UserError("That notice no longer holds, so there is nothing to snooze.");
    if (row.verb.id !== "snooze") throw new UserError("That notice is not snoozed: it closes when its source does.");
    return row;
  };
  verbs.register<{ key: string; hours: number }>("notice.snooze", {
    check: async ({ key }) => void (await snoozable(key)),
    apply: async ({ key, hours }) => {
      // Checked again as the window closes: a notice that went away meanwhile is not snoozed.
      await snoozable(key);
      await snoozes.snooze(key, new Date(Date.now() + hours * 3_600_000), new Date());
      return `Snoozed for ${hours} h.`;
    },
  });
  server.handle(snoozeNotice, async ({ key, hours }) => {
    const row = await snoozable(key);
    return verbs.schedule("notice.snooze", { key, label: `Snoozed ${row.title} for ${hours} h`, args: { key, hours } });
  });
  // Your answer to a due review: a receipt in the asks' log when the window closes (server/reviews.ts); an
  // initiative file is never edited here (A8). It is checked now and again then against the date you read.
  type ReviewArgs = { id: string; date: string; answer: ReviewAnswer; note: string };
  const stillDue = async ({ id, date }: ReviewArgs) => {
    const due = (await dueReviews()).find((initiative) => initiative.id === id);
    if (!due?.stale || due.stale.date !== date)
      throw new UserError("That review is not due for that date any more: it was answered or its date moved.");
  };
  verbs.register<ReviewArgs>("initiative.review", {
    check: stillDue,
    apply: async (args) => {
      await stillDue(args);
      await reviewReceipts.record({
        initiative: args.id,
        date: args.date,
        answer: args.answer,
        note: args.note.trim(),
        at: new Date().toISOString(),
      });
      return `Recorded: ${args.answer} ${args.id}; the conductor moves its file.`;
    },
  });
  server.handle(reviewInitiative, async ({ id, date, answer, note }) => {
    const due = (await dueReviews()).find((initiative) => initiative.id === id);
    return verbs.schedule<ReviewArgs>("initiative.review", {
      key: `review:${id}`,
      label: `Review of ${due?.title ?? id}: ${answer}`,
      args: { id, date, answer, note },
    });
  });
  server.handle(getLoops, () => loops.get());
  // The component gallery's flag (shared/kit.ts): read-only, from the daemon's environment.
  server.handle(kitGallery, async () => ({ enabled: galleryEnabled(process.env) }));
  server.handle(getTimeline, () => timeline.get());
  // A launchd job's log end, only when you open its row: never in the polled view.
  server.handle(getTimelineLog, ({ id }) => timeline.logOf(id));
  server.handle(historyWork, ({ days }) => records.history(days));
  server.handle(workFiles, ({ id }) => records.files(id));
  server.handle(readWorkFile, ({ id, name }) => records.file(id, name));
  server.handle(createWork, async (input, { paseo }) => {
    const gate = input.gate ?? (await engine.settings()).defaultGate;
    return engine.createWork(paseo, { ...input, gate });
  });
  server.handle(dispatchWork, ({ id }, { paseo }) => engine.dispatch(paseo, id).then((item) => ({ item })));
  server.handle(decideWork, ({ id, verdict, note }, { paseo }) =>
    engine.verdict(paseo, id, verdict, note).then(receipted),
  );
  // Allow or Deny one held action, with the 8 s undo (A1, B4): yours alone, never on the agent socket.
  server.handle(decideApproval, decideApprovalHandler(verbDeps));
  // Send a prompt to an existing session (Continue, Change course): never creates one (A8).
  server.handle(promptSession, promptSessionHandler(verbDeps));
  // Take back any verb inside its window: the ledger's, or a gate decision's (its receipt is the decision's token).
  server.handle(undoVerb, async ({ receipt }) => {
    if (await verbs.knows(receipt)) return verbs.undo(receipt);
    await engine.undoDecision(receipt);
    return { undone: true };
  });
  // What waits in the ledger, and the decisions at your gate waiting in their own window: one list, one Undo.
  server.handle(listVerbs, async () => {
    const [held, listed] = await Promise.all([verbs.list(), engine.list().catch(() => null)]);
    const gate = (listed?.items ?? []).flatMap((item) =>
      item.pending?.receipt
        ? [
            {
              receipt: item.pending.receipt,
              verb: "work.verdict" as const,
              key: workKey(item.id),
              label: gateLabel(item.title, item.pending),
              at: item.pending.decidedAt,
              appliesAt: item.pending.effectiveAt,
              remainingMs: item.pending.remainingMs,
            },
          ]
        : [],
    );
    return { pending: [...held.pending, ...gate].sort((a, b) => b.at.localeCompare(a.at)), recent: held.recent };
  });
  server.handle(unblockWork, ({ id, note }) => work.unblock(id, note));
  // Work at your gate is canceled there (a decision with its own window); everything else waits 8 s here.
  server.handle(
    cancelWork,
    async ({ id }, { paseo }) => (await work.cancel(id)) ?? receipted(await engine.cancel(id, paseo)),
  );
  server.handle(undoWork, ({ id }) => engine.undo(id).then((item) => ({ item })));
  // Yours alone, like the gate: never on the agent socket (server/agent-socket.ts GATE_METHODS).
  server.handle(leaveRunning, ({ id }) => work.leaveRunning(id));
  server.handle(stopWork, ({ id, discard }) => work.stop(id, discard === true));
  server.handle(adoptAgent, ({ agentId, title, ticket }, { paseo }) =>
    engine.adopt(paseo, agentId, title, undefined, { ticket }).then((item) => ({ item })),
  );
  server.handle(workForAgent, ({ agentId }) => engine.forAgent(agentId).then((item) => ({ item })));
  server.handle(inspectFolder, ({ path }) => inspect(path));
  // The Fleet view, and your verdict on a proposal: yours alone, never on the agent socket.
  server.handle(getFleet, ({ scope, ticks }) => fleet.get(scope, ticks));
  // Your verdict is written when its undo window closes (B4); the keys are checked now and again then.
  type Review = { scope: string; keys: string[]; verdict: ReviewVerdict; note: string };
  verbs.register<Review>("fleet.review", {
    check: async ({ scope, keys }) => {
      const view = await fleet.get(scope, 1);
      const proposed = new Set(
        (view.detail?.id === scope ? view.detail.proposals : []).map((proposal) => proposal.key),
      );
      if (keys.some((key) => !proposed.has(key))) {
        throw new UserError(
          "The fleet no longer proposes this: its latest report changed. Look at the Fleet view again.",
        );
      }
    },
    apply: async (input) => {
      const { proposals } = await fleet.review(input);
      return `${input.verdict === "accept" ? "Accepted" : "Rejected"} ${proposals.length} proposal(s): ${proposals[0]?.action ?? ""}`;
    },
  });
  server.handle(reviewProposal, async ({ scope, keys, verdict, note }) => {
    const input: Review = { scope, keys, verdict, note };
    const made = await verbs.schedule("fleet.review", {
      key: `fleet:${scope}:${createHash("sha256")
        .update([...new Set(keys)].sort().join("\n"))
        .digest("hex")
        .slice(0, 12)}`,
      label: `${verdict === "accept" ? "Accepted" : "Rejected"} ${keys.length} fleet proposal${keys.length === 1 ? "" : "s"} in ${scope}`,
      args: input,
    });
    // Nothing is written yet: the proposals stand as they are, and the receipt is what undoes your verdict.
    const view = await fleet.get(scope, 1);
    const wanted = new Set(keys);
    return { proposals: (view.detail?.proposals ?? []).filter((proposal) => wanted.has(proposal.key)), ...made };
  });
  server.handle(getFleetTick, ({ scope, tick }) => fleet.tick(scope, tick));
  // The workspace's asks, each read at its home (server/control-home.ts).
  // Each fleet scope's own root asks ride along, so Decisions lists every ask Maestro reads.
  server.handle(getWorkspaceAsks, async () => {
    const [view, scoped] = await Promise.all([
      workspace ? workspace.view() : Promise.resolve({ controlRepo: "", main: null, decisions: [], warnings: [] }),
      fleet.scopeDecisions().catch((error) => ({
        asks: [],
        warnings: [`The fleet's asks could not be read: ${(error as Error).message}`],
      })),
    ]);
    // An answered ask says what became of your answer: waiting to land, landed, or acted on (shared/answers.ts).
    const decisions = router
      ? await router.fates(view.decisions, await (lander?.state() ?? Promise.resolve(null)).catch(() => null))
      : view.decisions;
    return { ...view, decisions, fleet: scoped.asks, warnings: [...view.warnings, ...scoped.warnings] };
  });
  // Where your answers went (J5): a pure read of the same fates and the batch as the last wake left it.
  server.handle(getAnswersStatus, async () => {
    const landing = await (lander?.state() ?? Promise.resolve(null)).catch(() => null);
    const view = workspace ? await workspace.read().then((read) => read.all) : [];
    return answersStatus(router ? await router.fates(view, landing) : view, landing);
  });
  // Your answer to a decision ask, at its home: written under the ledger lock when its undo window closes (B4),
  // and never on the agent socket. An idea answered develop also files its held work item (above); park writes
  // the wake you chose.
  /** The ask as it reads now, or why it can no longer be answered: the refusals the write itself makes, said at the call. */
  const openAsk = async ({
    where,
    ledger,
    uid,
    id,
    hash,
  }: Pick<AnswerInput, "where" | "ledger" | "uid" | "id" | "hash">) => {
    const all =
      where.kind === "fleet"
        ? (await fleet.scopeDecisions()).asks.filter((ask) => ask.scope === where.scope)
        : workspace
          ? (await workspace.read()).all.filter((ask) => homeKey(ask.home) === where.home)
          : [];
    const found = all.find((ask) => ask.ledger === ledger && (uid ? ask.uid === uid : !ask.uid && ask.id === id));
    if (!found)
      throw new UserError(`The workspace no longer holds the ask ${id} in ${ledger}. Look at Decisions again.`);
    if (found.state !== "open")
      throw new UserError(`The ask ${id} was already answered or retired; your answer was not written.`);
    if (found.refusal) throw new UserError(found.refusal);
    if (found.hash !== hash)
      throw new UserError(`The ask ${id} changed since you read it; look at it again before answering.`);
    return found;
  };
  async function answerNowAt(
    { where, ...input }: AnswerInput,
    paseo: Paseo | null,
  ): Promise<{ ask: DecisionAsk; warning: string | null; work: WorkRef | null }> {
    if (where.kind === "fleet") {
      if (input.wake) throw new UserError("Only an idea in your workspace takes a wake date.");
      return { ...(await fleet.answer({ ...input, scope: where.scope })), work: null };
    }
    if (!workspace) throw new UserError("Maestro reads no control repo here (MAESTRO_PASEO_CONTROL_REPO is off).");
    const answered = await workspace.answer({ ...input, home: where.home });
    // An answer in its checkout is where it belongs already: routed now, not at the next wake. Never awaited.
    if (answered.ask.home.kind === "checkout") void router?.route();
    const filed = await develop(answered.ask, paseo);
    return {
      ask: answered.ask,
      warning: [answered.warning, filed.warning].filter(Boolean).join(" ") || null,
      work: filed.work,
    };
  }
  verbs.register<AnswerInput>("ask.answer", {
    check: async (input) => {
      if (input.where.kind === "fleet" && input.wake)
        throw new UserError("Only an idea in your workspace takes a wake date.");
      if (input.where.kind === "workspace" && !workspace) {
        throw new UserError("Maestro reads no control repo here (MAESTRO_PASEO_CONTROL_REPO is off).");
      }
      await openAsk(input);
    },
    apply: async (input, paseo) => {
      const done = await answerNowAt(input, paseo);
      const said = input.option ?? "your words";
      return [`Answered ${done.ask.id} in ${done.ask.ledger}: ${said}.`, done.warning].filter(Boolean).join(" ");
    },
  });
  server.handle(answerAsk, async (input) => {
    const found = await openAsk(input);
    const made = await verbs.schedule("ask.answer", {
      key: askHoldKey(found),
      label: `Answered ${found.headline ?? found.question ?? found.id}`,
      args: input,
    });
    return { ask: found, warning: null, work: null, ...made };
  });
  // A file an ask names (decision layer v2, BRO-3167), read when you look: by the ask's handle and the file's
  // position in it, never by a path, so nothing an ask does not name is read (server/rich-ask.ts).
  server.handle(getAskAttachment, async ({ where, ledger, uid, id, ref }) => {
    const all =
      where.kind === "fleet"
        ? (await fleet.scopeDecisions()).asks.filter((ask) => ask.scope === where.scope)
        : workspace
          ? (await workspace.read()).all.filter((ask) => homeKey(ask.home) === where.home)
          : [];
    const found = all.find((ask) => ask.ledger === ledger && (uid ? ask.uid === uid : !ask.uid && ask.id === id));
    if (!found)
      throw new UserError(`The workspace no longer holds the ask ${id} in ${ledger}. Look at Decisions again.`);
    return readAttachment(found, ref);
  });
  // The workspace's initiatives, each with its ideas (server/initiatives.ts): read-only but for the answers above.
  server.handle(getInitiatives, async (_input, { paseo }) => {
    if (!initiatives) return { controlRepo: "", today: "", initiatives: [], ideas: [], developed: [], warnings: [] };
    const [view, developed] = await Promise.all([
      initiatives.view(paseo),
      engine.developed().catch((error) => {
        log(`initiatives: reading the work filed for ideas: ${(error as Error).message}`);
        return null;
      }),
    ]);
    // Only for ideas shown: a work item names an idea by its ref, which is all it is joined on.
    const shown = new Set(view.ideas.map(ideaRef));
    return {
      ...view,
      developed: developed
        ? [...developed].filter(([ref]) => shown.has(ref)).map(([ref, work]) => ({ ref, ...work }))
        : [],
      warnings: developed ? view.warnings : [...view.warnings, "The work filed for ideas could not be read."],
    };
  });
  // An idea answered develop with no work item: file it now (idempotent). Only an answered develop qualifies.
  server.handle(fileIdeaWork, async ({ ledger, id, home }, { paseo }) => {
    if (!workspace) throw new UserError("Maestro reads no control repo here (MAESTRO_PASEO_CONTROL_REPO is off).");
    const { decisions } = await workspace.view();
    const ask = decisions.find(
      (entry) => entry.ledger === ledger && entry.id === id && homeKey(entry.home) === home && entry.idea,
    );
    if (!ask) throw new UserError(`No idea ${id} in ${ledger} at ${home}.`);
    if (ask.state !== "answered" || ask.answerOption !== "develop") {
      throw new UserError(`${ledger} ${id} is not answered develop, so no work is filed for it.`);
    }
    return develop(ask, paseo);
  });
  server.handle(getConfig, () => loadConfig());
  // Saved Settings may turn the loop on or off, or change its period: arm it again from them.
  verbs.register<MaestroConfig>("config.set", {
    supersedes: true,
    apply: async (input) => {
      await saveConfig(input);
      await loop.reschedule();
      return "Saved Settings.";
    },
  });
  server.handle(setConfig, async (input) => ({
    ...input,
    ...(await verbs.schedule("config.set", { key: "config", label: "Saved Settings", args: input })),
  }));
  // The loop's state and a wake now: yours, never on the agent socket.
  server.handle(getLoop, () => loop.get());
  verbs.register<Record<string, never>>("loop.wake", {
    apply: async () => {
      const entry = await loop.wake("manual");
      return entry.skipped ? `Not woken: ${entry.skipped}` : entry.narrative.join(" ") || "Woke the loop.";
    },
  });
  server.handle(wakeLoop, () => verbs.schedule("loop.wake", { key: "loop", label: "Woke the loop", args: {} }));
  // Your decision on an answer that waits for the conductor, and its undo: yours, never on the agent socket.
  server.handle(decideConductor, ({ key, verb }) => {
    if (!router) throw new UserError("Maestro reads no control repo here (MAESTRO_PASEO_CONTROL_REPO is off).");
    return router.decide(key, verb);
  });
  server.handle(undoConductor, ({ receipt }) => {
    if (!router) throw new UserError("Maestro reads no control repo here (MAESTRO_PASEO_CONTROL_REPO is off).");
    return router.undo(receipt);
  });

  server.on("agent.turn_started", (event) => engine.onTurnStarted(event.agent));
  // A session's turn ended: Maestro's own bookkeeping first, then any answer that waited for it to go idle.
  server.on("agent.turn_ended", async (event) => {
    await engine.onTurnEnded(event.agent, event.outcome, event.timeline, event.turnId);
    void router?.route({ agentId: event.agent.id });
  });
  server.on("agent.permission_requested", async (event) => {
    await engine.onPermissionRequested(event.agent, event.request);
    // The prompt is a hold now: its card goes into the session that is paused on it.
    cards.nudge();
  });
  server.on("agent.permission_resolved", (event) => engine.onPermissionResolved(event.agent, event.requestId));
  server.on("agent.archived", (event, { paseo }) => engine.onArchived(event.agent, paseo));
  // Heard only for its client: the socket can then start runs as soon as any session exists.
  server.on("agent.created", () => undefined);

  // Sessions reach Maestro through a socket of its own (server/agent-socket.ts).
  // If it cannot open, Maestro's own screens still work, and it keeps trying.
  // Every verb that writes checks its caller against Paseo's registry of sessions first (server/callers.ts, BRO-2996).
  const callers = new Callers({ dir: paseoAgentsDir() });
  const stopSocket = keepServing({
    path: socketPath(),
    methods: agentMethods(engine, () => latest, approvals, callers),
    log,
  });

  // The plugin sweep (server/sweep.ts): what the reads above no longer do, on its own cadence, whoever looks.
  // Its first sweep runs now: decisions made before a restart are armed, or applied when overdue.
  const sweep: Sweep = new Sweep({
    client: () => latest,
    everyMs: sweepEvery(),
    log,
    steps: [
      {
        name: "the work",
        run: async (paseo) => {
          if (await engine.upkeep(paseo)) log("sweep: the work moved to match its sessions, or a decision came due");
        },
      },
      // What holds you, in the session that asked: a hold raised while the daemon was down, or an agent's
      // approval.request, gets its card here when no event said so (server/session-cards.ts).
      { name: "session cards", background: true, run: () => cards.reconcile() },
      // Your verbs in their window are armed again after a restart, and those overdue apply (server/owner-verbs.ts).
      {
        name: "your decisions",
        run: async () => {
          if (await verbs.resume()) log("sweep: a decision of yours came due");
        },
      },
      // In the background (never waited for, one at a time): a fetch or the loops' whole view may take a while.
      // The control repo's two in turn, so their fetches never race for one ref: the asks' origin/main, then the
      // loops' drift (its ledger fetched first). With no control repo there is nothing to fetch or record.
      ...(workspace
        ? [
            {
              name: "the control repo's asks and loops",
              background: true,
              run: async () => {
                await workspace.fetchDue();
                await loops.sweep();
              },
            },
          ]
        : []),
      { name: "the fleet's leftover locks", background: true, run: () => fleet.sweepLocks() },
    ],
    // A wake that found no client runs again once a sweep has one (Loop.connected).
    after: (run) => {
      if (run.connected) void loop.connected();
    },
  });
  sweep.start();
  // The loop's next wake, from Settings and its log: a restart keeps its cadence.
  void loop.reschedule();

  return async () => {
    sweep.stop();
    cards.stop();
    loop.stop();
    // Before a reload's new router resumes your decisions: this one applies none of them any more.
    router?.stop();
    verbs.stop();
    fleet.stop();
    awakeClock?.stop();
    engine.stop();
    await stopSocket();
  };
}
