// Maestro inside the rest of Paseo: the header count in every workspace and a
// pill beside the composer of every session Maestro tracks.
//
// The count is needs.list's total (BRO-3001), the number every other surface
// says, and the button opens where those holds are (header-count.ts
// needsTarget). The pills list the sessions of live work (work.attention's
// sessions; nothing is counted from it).
//
// What they cost, with Maestro closed: two pure reads, which the daemon
// answers from what it holds, with no session reconcile. A read
// follows a few seconds after a session changes status or a workspace comes or
// goes (events this client already receives: listening asks the daemon for
// nothing new), and otherwise every 30 s, slowing to every 60 s once nothing
// shown has changed for four reads in a row. Stopping removes every
// registration, timer and listener, and a read still in flight when it stops
// registers nothing.

import type { PaseoAgentUpdate, PaseoApi, PaseoWorkspaceUpdate } from "@getpaseo/client";
import type { PluginButtonContentProps, PluginButtonIcon, PluginClientContext } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { attentionWork } from "../shared/contracts";
import { listNeeds, type Needs } from "../shared/needs";
import type { OrchState } from "../shared/states";
import { type HeaderSpec, headerFace, headerSpecs, needsTarget } from "./header-count";
import { type MaestroIntent, requestIntent } from "./intent";
import { type PillSpec, pillFace, pillSpecs } from "./pills";
import { createRegistrations } from "./registrations";

export const REFRESH = {
  /** Between reads while what is shown keeps changing. */
  everyMs: 30_000,
  /** Between reads once it has held still for `calmAfter` reads. */
  calmMs: 60_000,
  calmAfter: 4,
  /** After a session or workspace event: long enough to let the daemon record the change, and to batch a burst. */
  nudgeMs: 5_000,
} as const;

const PAGE = 200;
const MAX_PAGES = 10;

export type IntegrationClient = Pick<
  PluginClientContext,
  "paseo" | "rpc" | "openScreen" | "addHeaderButton" | "addComposerPill"
>;

export interface IntegrationViews {
  /** The pill's icon for a state: the state dot, so the colour always sits beside its word. */
  pillIcon(state: OrchState): PluginButtonIcon;
  /** The pill's popover, one component for every pill; it reads its session's work itself. */
  PillContent: ComponentType<PluginButtonContentProps>;
}

export interface IntegrationOptions {
  /** Runs `run` once after `ms` and returns how to cancel it. */
  later?: (run: () => void, ms: number) => () => void;
  log?: (message: string) => void;
}

/** The id Maestro's screen is registered under (index.client.tsx). */
export const MAESTRO_SCREEN = "maestro";

/** Opens Maestro at a target: leaves the intent, then opens the screen, which takes it. */
export function opener(client: Pick<PluginClientContext, "openScreen">): (intent: MaestroIntent) => void {
  return (intent) => {
    requestIntent(intent);
    client.openScreen({ screenId: MAESTRO_SCREEN });
  };
}

/** Every workspace id the host lists, page by page. */
export async function workspaceIds(paseo: Pick<PaseoApi, "workspaces">): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({ page: cursor ? { limit: PAGE, cursor } : { limit: PAGE } });
    for (const entry of result.entries) ids.push(entry.id);
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  return ids;
}

/** What about a session can move the count or a pill: its status, whether it is asking, whether it is archived. */
export function sessionSignal(agent: {
  status: string;
  pendingPermissions?: readonly unknown[];
  archivedAt?: string | null;
}): string {
  return `${agent.status}:${agent.pendingPermissions?.length ?? 0}:${agent.archivedAt ? "archived" : "live"}`;
}

const timeout = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export function startIntegrations(
  client: IntegrationClient,
  views: IntegrationViews,
  options: IntegrationOptions = {},
): { refresh(): Promise<void>; stop(): void } {
  const log = options.log ?? ((message: string) => console.warn(`[maestro] ${message}`));
  const later = options.later ?? timeout;
  const open = opener(client);
  let needs: Needs = { rows: [], summary: { total: 0, byKind: { ask: 0, approval: 0, owner_step: 0 } } };
  let workspaces: string[] = [];
  /** What the last good read showed, and for how many reads in a row it has held. */
  let shown: string | null = null;
  let calm = 0;
  let stopped = false;
  let busy = false;
  let lastError: string | null = null;
  let poll: (() => void) | null = null;
  let nudge: (() => void) | null = null;
  const sessions = new Map<string, string>();
  const listeners: Array<() => void> = [];

  const headers = createRegistrations(
    {
      add: (workspaceId, spec: HeaderSpec) =>
        client.addHeaderButton({
          id: "needs-you",
          workspaceId,
          // Read at press time, so the target always matches the count on the button.
          button: {
            ...headerFace(spec.count),
            behavior: {
              kind: "action",
              onPress: () => open(needsTarget(needs)),
            },
          },
        }),
      update: (handle, spec) => handle.update(headerFace(spec.count)),
    },
    log,
  );
  const pills = createRegistrations(
    {
      add: (_key, spec: PillSpec) =>
        client.addComposerPill({
          id: "work",
          workspaceId: spec.workspaceId,
          agentId: spec.agentId,
          button: {
            ...pillFace(spec),
            icon: views.pillIcon(spec.state),
            behavior: { kind: "popover", Content: views.PillContent },
          },
        }),
      // No behavior in the patch: replacing it would close a popover someone has open.
      update: (handle, spec) => handle.update({ ...pillFace(spec), icon: views.pillIcon(spec.state) }),
    },
    log,
  );

  /** Logs a failure once, not on every read while it lasts. */
  const report = (error: unknown) => {
    const message = error === null ? null : error instanceof Error ? error.message : String(error);
    if (message !== null && message !== lastError) log(`Could not refresh the header count and pills: ${message}`);
    lastError = message;
  };

  const schedule = () => {
    poll?.();
    poll = later(
      () => {
        poll = null;
        void refresh();
      },
      calm >= REFRESH.calmAfter ? REFRESH.calmMs : REFRESH.everyMs,
    );
  };

  const refresh = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const [needed, live, spaces] = await Promise.allSettled([
        client.rpc(listNeeds, {}),
        client.rpc(attentionWork, {}),
        workspaceIds(client.paseo),
      ]);
      if (stopped) return;
      // A failed read keeps what was last known rather than hiding everything until the next one.
      if (spaces.status === "fulfilled") workspaces = spaces.value;
      if (needed.status === "fulfilled") needs = needed.value;
      if (live.status === "fulfilled") pills.sync(pillSpecs(live.value.sessions));
      if (needed.status === "fulfilled" || live.status === "fulfilled") {
        const next = JSON.stringify([
          needed.status === "fulfilled" ? needed.value : null,
          live.status === "fulfilled" ? live.value.sessions : null,
        ]);
        calm = next === shown ? calm + 1 : 0;
        shown = next;
      }
      const failed = [needed, live, spaces].find((read) => read.status === "rejected");
      report(failed?.status === "rejected" ? failed.reason : null);
      headers.sync(headerSpecs(workspaces, needs.summary.total));
    } finally {
      busy = false;
      if (!stopped) schedule();
    }
  };

  /** One read soon after an event; events while it is pending join it. */
  const soon = () => {
    if (stopped || nudge) return;
    nudge = later(() => {
      nudge = null;
      if (busy) soon();
      else void refresh();
    }, REFRESH.nudgeMs);
  };

  const listen = (subscribe: () => () => void) => {
    try {
      listeners.push(subscribe());
    } catch (error) {
      log(`Could not listen for session changes; polling only: ${(error as Error).message}`);
    }
  };
  listen(() =>
    client.paseo.agents.subscribe((update: PaseoAgentUpdate) => {
      if (update.kind === "remove") {
        if (sessions.delete(update.agentId)) soon();
        return;
      }
      const signal = sessionSignal(update.agent);
      if (sessions.get(update.agent.id) === signal) return;
      sessions.set(update.agent.id, signal);
      soon();
    }),
  );
  listen(() =>
    client.paseo.workspaces.subscribe((update: PaseoWorkspaceUpdate) => {
      const known = workspaces.includes(update.kind === "remove" ? update.id : update.workspace.id);
      if (update.kind === "remove" ? known : !known) soon();
    }),
  );

  void refresh();

  return {
    refresh,
    stop: () => {
      stopped = true;
      poll?.();
      nudge?.();
      for (const unlisten of listeners) unlisten();
      headers.clear();
      pills.clear();
    },
  };
}
