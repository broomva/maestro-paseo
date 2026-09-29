import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentMethods, keepServing } from "./server/agent-socket";
import { loadConfig, saveConfig } from "./server/config";
import { Engine } from "./server/engine";
import { socketPath } from "./server/paths";
import type { Paseo } from "./server/runs";
import {
  adoptAgent,
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

const log = (message: string) => console.log(`[maestro] ${message}`);

export default function contribute(host: PluginServerContext) {
  const engine = new Engine();

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

  server.handle(listWork, (_input, { paseo }) => engine.list(paseo));
  server.handle(getWork, ({ id }) => engine.get(id));
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
