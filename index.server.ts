import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentMethods, keepServing } from "./server/agent-socket";
import { attentionOf } from "./server/attention";
import { loadConfig, saveConfig } from "./server/config";
import { Engine } from "./server/engine";
import { Fleet } from "./server/fleet";
import { inspectFolder as inspect } from "./server/folders";
import { GateCards } from "./server/gate-card";
import { Loop } from "./server/loop";
import { socketPath } from "./server/paths";
import { Records } from "./server/records";
import type { Paseo } from "./server/runs";
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
import { getFleet, reviewProposal } from "./shared/fleet";
import { historyWork, readWorkFile, workFiles } from "./shared/records";

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
  const fleet = new Fleet({ items: () => engine.list().then(({ items }) => items), log });
  fleet.start();
  // No client handed to list: the header count and pills poll this, and must not reconcile sessions.
  // A fleet that cannot be read costs the count its fleet notices, never the work's.
  server.handle(attentionWork, async () => {
    const { items } = await engine.list();
    const notices = await fleet.notices(items).catch((error) => {
      log(`reading the fleet for the header count: ${(error as Error).message}`);
      return [];
    });
    return attentionOf(items, Date.now(), notices);
  });
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
  server.handle(reviewProposal, ({ scope, key, verdict, note }) => fleet.review({ scope, key, verdict, note }));
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
    engine.stop();
    await stopSocket();
  };
}
