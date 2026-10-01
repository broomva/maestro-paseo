import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentMethods, keepServing } from "./server/agent-socket";
import { attentionOf } from "./server/attention";
import { loadConfig, saveConfig } from "./server/config";
import { Engine } from "./server/engine";
import { GateCards } from "./server/gate-card";
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
  getWork,
  listWork,
  setConfig,
  unblockWork,
  workForAgent,
} from "./shared/contracts";
import { historyWork, readWorkFile, workFiles } from "./shared/records";

const log = (message: string) => console.log(`[maestro] ${message}`);

export default function contribute(host: PluginServerContext) {
  // A run that lands at your gate leaves an approval card in its session, through the latest client below.
  const cards = new GateCards(() => latest, log);
  const engine = new Engine({ landed: (before, after) => cards.landed(before, after) });

  // The host hands the plugin its daemon client only inside handlers and hooks,
  // never at startup: one client for the life of the plugin process. The agent
  // socket needs it outside both, so every handler and hook below keeps it. Until
  // the first event arrives, socket verbs that start or read a session refuse and
  // say why. On shutdown the host disposes the client before calling the cleanup
  // below, so a request answered in that window can fail; it fails with an answer.
  let latest: Paseo | null = null;
  const server: Pick<PluginServerContext, "handle" | "on"> = {
    handle: (contract, handler) =>
      host.handle(contract, (input, context) => {
        latest = context.paseo;
        return handler(input, context);
      }),
    on: (name, handler) =>
      host.on(name, (event, context) => {
        latest = context.paseo;
        return handler(event, context);
      }),
  };

  // History, a work folder's files and each run's changed line: read-only, and never on the agent socket.
  const records = new Records(() => engine.settings());
  server.handle(listWork, (_input, { paseo }) => engine.list(paseo).then((list) => records.withChanged(paseo, list)));
  server.handle(getWork, ({ id }, { paseo }) => engine.get(id).then((got) => records.withChangedItem(paseo, got)));
  // No client handed to list: the header count and pills poll this, and must not reconcile sessions.
  server.handle(attentionWork, () => engine.list().then(({ items }) => attentionOf(items, Date.now())));
  server.handle(historyWork, ({ days }) => records.history(days));
  server.handle(workFiles, ({ id }) => records.files(id));
  server.handle(readWorkFile, ({ id, name }) => records.file(id, name));
  server.handle(createWork, (input, { paseo }) => engine.create(paseo, input).then((item) => ({ item })));
  server.handle(dispatchWork, ({ id }, { paseo }) => engine.dispatch(paseo, id).then((item) => ({ item })));
  server.handle(decideWork, ({ id, verdict, note }, { paseo }) =>
    engine.verdict(paseo, id, verdict, note).then((item) => ({ item })),
  );
  server.handle(unblockWork, ({ id, note }, { paseo }) => engine.unblock(paseo, id, note).then((item) => ({ item })));
  server.handle(cancelWork, ({ id }) => engine.cancel(id).then((item) => ({ item })));
  server.handle(adoptAgent, ({ agentId, title }, { paseo }) =>
    engine.adopt(paseo, agentId, title).then((item) => ({ item })),
  );
  server.handle(workForAgent, ({ agentId }) => engine.forAgent(agentId).then((item) => ({ item })));
  server.handle(getConfig, () => loadConfig());
  server.handle(setConfig, (input) => saveConfig(input));

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

  return async () => {
    engine.stop();
    await stopSocket();
  };
}
