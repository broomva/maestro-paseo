import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadConfig, saveConfig } from "./server/config";
import { Engine } from "./server/engine";
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

export default function contribute(server: PluginServerContext) {
  const engine = new Engine();

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
  server.on("agent.turn_ended", (event) => engine.onTurnEnded(event.agent, event.outcome, event.timeline));
  server.on("agent.permission_requested", (event) => engine.onPermissionRequested(event.agent, event.request));
  server.on("agent.permission_resolved", (event) => engine.onPermissionResolved(event.agent, event.requestId));
  server.on("agent.archived", (event) => engine.onArchived(event.agent));

  return () => engine.stop();
}
