import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentMethods, keepServing } from "./server/agent-socket";
import { attentionOf } from "./server/attention";
import { loadConfig, saveConfig } from "./server/config";
import { WorkspaceAsks } from "./server/control-home";
import { Engine, UserError } from "./server/engine";
import { AwakeClock, Fleet, wallClock } from "./server/fleet";
import { inspectFolder as inspect } from "./server/folders";
import { GateCards } from "./server/gate-card";
import { agentIds, ghRun, ideaWork, prStates, workspaceInitiatives } from "./server/initiatives";
import { Launchd } from "./server/launchd";
import { Loop } from "./server/loop";
import {
  controlAskPaths,
  controlRepoPaths,
  launchdPrefix,
  paseoSchedulesDir,
  socketPath,
  wakeLogPath,
} from "./server/paths";
import { Records } from "./server/records";
import type { Paseo } from "./server/runs";
import { Timeline } from "./server/timeline";
import { WAKE_LOG_MAX, WakeLog } from "./server/wake-log";
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
  const engine = new Engine({ client: () => latest, landed: (before, after) => cards.landed(before, after) });
  // The loop wakes on its own timer, outside any handler, so it reads the same client (server/loop.ts).
  const loop = new Loop({ engine, client: () => latest, log });
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
  // The workspace's initiatives and their ideas (server/initiatives.ts), read under the same home rule.
  const initiatives = control.repo
    ? workspaceInitiatives({
        controlRepo: control.repo,
        answersPath: control.answers,
        asks: workspace,
        prs: prStates(ghRun, Date.now, log),
        agents: agentIds(Date.now, log),
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
  // No client handed to list: the header count and pills poll this, and must not reconcile sessions.
  // A fleet or a timeline that cannot be read costs the count its notices, never the work's.
  server.handle(attentionWork, async () => {
    const { items } = await engine.list();
    const [notices, scheduled, workspaceAsks, fleetAsks, initiativeNotices] = await Promise.all([
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
    ]);
    return attentionOf(items, Date.now(), notices, scheduled, [...workspaceAsks, ...fleetAsks], initiativeNotices);
  });
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
    return { ...view, fleet: scoped.asks, warnings: [...view.warnings, ...scoped.warnings] };
  });
  // Your answer to a decision ask, at its home: written under the ledger lock, and never on the agent socket.
  // An idea answered develop also files its held work item (above); park writes the wake you chose.
  server.handle(answerAsk, async ({ where, ...input }, { paseo }) => {
    if (where.kind === "fleet") {
      if (input.wake) throw new UserError("Only an idea in your workspace takes a wake date.");
      // Tagged as Decisions lists it, so the card and the list name the scope it was answered in.
      const answered = await fleet.answer({ ...input, scope: where.scope });
      return { ...answered, ask: { ...answered.ask, scope: where.scope } };
    }
    if (!workspace) throw new UserError("Maestro reads no control repo here (MAESTRO_PASEO_CONTROL_REPO is off).");
    const answered = await workspace.answer({ ...input, home: where.home });
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
  server.on("agent.turn_ended", (event) =>
    engine.onTurnEnded(event.agent, event.outcome, event.timeline, event.turnId),
  );
  server.on("agent.permission_requested", (event) => engine.onPermissionRequested(event.agent, event.request));
  server.on("agent.permission_resolved", (event) => engine.onPermissionResolved(event.agent, event.requestId));
  server.on("agent.archived", (event) => engine.onArchived(event.agent));
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
