import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentMethods, keepServing } from "./server/agent-socket";
import { AnswerRouter } from "./server/answer-routes";
import { AnswersLander, ghForge } from "./server/answers-landing";
import { attentionOf } from "./server/attention";
import { loadConfig, saveConfig } from "./server/config";
import { WorkspaceAsks } from "./server/control-home";
import { Engine, UserError } from "./server/engine";
import { AwakeClock, Fleet, wallClock } from "./server/fleet";
import { inspectFolder as inspect } from "./server/folders";
import { GateCards } from "./server/gate-card";
import { GhaSchedules } from "./server/gha";
import { createInboxProvider, Inbox } from "./server/inbox";
import { agentIds, driverRelay, ghRun, ideaWork, prStates, workspaceInitiatives } from "./server/initiatives";
import { Launchd, launchdPresence } from "./server/launchd";
import { Loop } from "./server/loop";
import { homeWriter, Loops } from "./server/loops";
import { gitLedger, loopPaths } from "./server/loops-ledger";
import {
  controlAskPaths,
  controlRepoPaths,
  expandHome,
  launchdPrefix,
  paseoSchedulesDir,
  socketPath,
  wakeLogPath,
} from "./server/paths";
import { Records } from "./server/records";
import type { Paseo } from "./server/runs";
import { Timeline } from "./server/timeline";
import { WAKE_LOG_MAX, WakeLog } from "./server/wake-log";
import { answersNotice } from "./shared/answers";
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
  setConfig,
  stopWork,
  unblockWork,
  undoWork,
  wakeLoop,
  workForAgent,
} from "./shared/contracts";
import {
  answerAsk,
  type DecisionAsk,
  getFleet,
  getFleetTick,
  getWorkspaceAsks,
  homeKey,
  reviewProposal,
} from "./shared/fleet";
import { fileIdeaWork, getInitiatives, ideaRef, type WorkRef } from "./shared/initiatives";
import { getLoops } from "./shared/loops";
import { historyWork, readWorkFile, workFiles } from "./shared/records";
import { getTimeline, getTimelineLog } from "./shared/timeline";

const log = (message: string) => console.log(`[maestro] ${message}`);

export default function contribute(host: PluginServerContext) {
  // A run that lands at your gate leaves an approval card in its session, through the latest client below.
  const cards = new GateCards(() => latest, log);

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
  );
  const engine: Engine = new Engine({
    client: () => latest,
    landed: (before, after) => Promise.all([cards.landed(before, after), inbox.landed(before, after)]),
  });
  // The workspace's own asks: the control repo's ledgers, at their homes (spec #861 §5.2).
  const control = controlRepoPaths();
  const askPaths = controlAskPaths();
  const workspace = control.repo
    ? new WorkspaceAsks({
        controlRepo: control.repo,
        answersPath: control.answers,
        lockRoot: askPaths.locks,
        receipts: askPaths.receipts,
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
  // The loop wakes on its own timer, outside any handler, so it reads the same client (server/loop.ts).
  const loop = new Loop({
    engine,
    client: () => latest,
    log,
    answers: lander && router ? { land: () => lander.land(), route: () => router.route() } : undefined,
  });
  const keep = (paseo: Paseo) => {
    const first = !latest && Boolean(paseo);
    latest = paseo;
    if (!first) return;
    void engine.sweep(paseo).catch((error) => log(`applying due decisions: ${(error as Error).message}`));
    void loop.connected();
  };
  const server: Pick<PluginServerContext, "handle" | "on"> = {
    handle: (contract, handler) =>
      host.handle(contract, (input, context) => {
        keep(context.paseo);
        return handler(input, context);
      }),
    on: (name, handler) =>
      host.on(name, (event, context) => {
        keep(context.paseo);
        return handler(event, context);
      }),
  };

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
    ledger: control.repo ? gitLedger(control.repo, { fetch: true, log }) : null,
    timeline,
    schedulesDir: paseoSchedulesDir(),
    presence: prefix ? (labels) => launchdPresence(labels) : null,
    gha: control.repo ? new GhaSchedules() : null,
    p9Dir: join(homedir(), ".config", "broomva", "p9"),
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
  // No client handed to list: the header count and pills poll this, and must not reconcile sessions.
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
  server.handle(getLoops, () => loops.get());
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
    engine.verdict(paseo, id, verdict, note).then((item) => ({ item })),
  );
  server.handle(unblockWork, ({ id, note }, { paseo }) => engine.unblock(paseo, id, note).then((item) => ({ item })));
  server.handle(cancelWork, ({ id }, { paseo }) => engine.cancel(id, paseo).then((item) => ({ item })));
  server.handle(undoWork, ({ id }) => engine.undo(id).then((item) => ({ item })));
  // Yours alone, like the gate: never on the agent socket (server/agent-socket.ts GATE_METHODS).
  server.handle(leaveRunning, ({ id }) => engine.leaveRunning(id).then((item) => ({ item })));
  server.handle(stopWork, ({ id, discard }, { paseo }) =>
    engine.stopRun(paseo, id, { discard: discard === true }).then((item) => ({ item })),
  );
  server.handle(adoptAgent, ({ agentId, title }, { paseo }) =>
    engine.adopt(paseo, agentId, title).then((item) => ({ item })),
  );
  server.handle(workForAgent, ({ agentId }) => engine.forAgent(agentId).then((item) => ({ item })));
  server.handle(inspectFolder, ({ path }) => inspect(path));
  // The Fleet view, and your verdict on a proposal: yours alone, never on the agent socket.
  server.handle(getFleet, ({ scope, ticks }) => fleet.get(scope, ticks));
  server.handle(reviewProposal, ({ scope, keys, verdict, note }) => fleet.review({ scope, keys, verdict, note }));
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
  // Your answer to a decision ask, at its home: written under the ledger lock, and never on the agent socket.
  // An idea answered develop also files its held work item (above); park writes the wake you chose.
  server.handle(answerAsk, async ({ where, ...input }, { paseo }) => {
    if (where.kind === "fleet") {
      if (input.wake) throw new UserError("Only an idea in your workspace takes a wake date.");
      return fleet.answer({ ...input, scope: where.scope });
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
  server.handle(setConfig, async (input) => {
    const saved = await saveConfig(input);
    await loop.reschedule();
    return saved;
  });
  // The loop's state and a wake now: yours, never on the agent socket.
  server.handle(getLoop, () => loop.get());
  server.handle(wakeLoop, () => loop.wake("manual"));

  server.on("agent.turn_started", (event) => engine.onTurnStarted(event.agent));
  // A session's turn ended: Maestro's own bookkeeping first, then any answer that waited for it to go idle.
  server.on("agent.turn_ended", async (event) => {
    await engine.onTurnEnded(event.agent, event.outcome, event.timeline, event.turnId);
    void router?.route({ agentId: event.agent.id });
  });
  server.on("agent.permission_requested", (event) => engine.onPermissionRequested(event.agent, event.request));
  server.on("agent.permission_resolved", (event) => engine.onPermissionResolved(event.agent, event.requestId));
  server.on("agent.archived", (event, { paseo }) => engine.onArchived(event.agent, paseo));
  // Heard only for its client: the socket can then start runs as soon as any session exists.
  server.on("agent.created", () => undefined);

  // Sessions reach Maestro through a socket of its own (server/agent-socket.ts).
  // If it cannot open, Maestro's own screens still work, and it keeps trying.
  const stopSocket = keepServing({ path: socketPath(), methods: agentMethods(engine, () => latest), log });

  // Decisions made before a restart: arm the ones still inside their window, apply the overdue ones.
  void engine.sweep().catch((error) => log(`applying due decisions: ${(error as Error).message}`));
  // The loop's next wake, from Settings and its log: a restart keeps its cadence.
  void loop.reschedule();

  return async () => {
    loop.stop();
    fleet.stop();
    awakeClock?.stop();
    engine.stop();
    await stopSocket();
  };
}
