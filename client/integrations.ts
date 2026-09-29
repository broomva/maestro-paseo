// Maestro inside the rest of Paseo: the header count in every workspace and a
// pill beside the composer of every session Maestro tracks. Both are refreshed
// from work.list on a timer, like the surfaces poll, and kept in step with the
// workspaces and sessions that exist. Stopping removes every registration and
// the timer, and a refresh still in flight when it stops registers nothing.

import type { PaseoApi } from "@getpaseo/client";
import type { PluginButtonContentProps, PluginButtonIcon, PluginClientContext } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { listWork, type WorkItem } from "../shared/contracts";
import type { OrchState } from "../shared/states";
import { type HeaderSpec, headerFace, headerSpecs, needsYou, needsYouTarget } from "./header-count";
import { type MaestroIntent, requestIntent } from "./intent";
import { type PillSpec, pillFace, pillSpecs } from "./pills";
import { Registrations } from "./registrations";

export const REFRESH_MS = 10_000;
const PAGE = 200;
const MAX_PAGES = 10;

export type IntegrationClient = Pick<
  PluginClientContext,
  "paseo" | "rpc" | "openSurface" | "addHeaderButton" | "addComposerPill"
>;

export interface IntegrationViews {
  /** The pill's icon for a state: the state dot, so the colour always sits beside its word. */
  pillIcon(state: OrchState): PluginButtonIcon;
  /** The pill's popover, one component for every pill; it reads its session's work itself. */
  PillContent: ComponentType<PluginButtonContentProps>;
}

export interface IntegrationOptions {
  everyMs?: number;
  /** Runs `tick` every `ms` and returns how to stop it. */
  every?: (tick: () => void, ms: number) => () => void;
  log?: (message: string) => void;
}

/** Opens Maestro at a target: leaves the intent, then opens the surface, which takes it. */
export function opener(client: Pick<PluginClientContext, "openSurface">): (intent: MaestroIntent) => void {
  return (intent) => {
    requestIntent(intent);
    client.openSurface("maestro");
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

const interval = (tick: () => void, ms: number) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export function startIntegrations(
  client: IntegrationClient,
  views: IntegrationViews,
  options: IntegrationOptions = {},
): { refresh(): Promise<void>; stop(): void } {
  const log = options.log ?? ((message: string) => console.warn(`[maestro] ${message}`));
  const open = opener(client);
  let items: WorkItem[] = [];
  let workspaces: string[] = [];
  let stopped = false;
  let busy = false;
  let lastError: string | null = null;

  const headers = new Registrations(
    {
      add: (workspaceId, spec: HeaderSpec) =>
        client.addHeaderButton({
          id: "needs-you",
          workspaceId,
          // Read at press time, so the target always matches the count on the button.
          button: {
            ...headerFace(spec.count),
            behavior: { kind: "action", onPress: () => open(needsYouTarget(items)) },
          },
        }),
      update: (handle, spec) => handle.update(headerFace(spec.count)),
    },
    log,
  );
  const pills = new Registrations(
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

  /** Logs a failure once, not on every tick while it lasts. */
  const report = (error: unknown) => {
    const message = error === null ? null : error instanceof Error ? error.message : String(error);
    if (message !== null && message !== lastError) log(`Could not refresh the header count and pills: ${message}`);
    lastError = message;
  };

  const refresh = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const [work, spaces] = await Promise.allSettled([client.rpc(listWork, {}), workspaceIds(client.paseo)]);
      if (stopped) return;
      // A failed read keeps what was last known rather than hiding everything until the next tick.
      if (work.status === "fulfilled") items = work.value.items;
      if (spaces.status === "fulfilled") workspaces = spaces.value;
      report(work.status === "rejected" ? work.reason : spaces.status === "rejected" ? spaces.reason : null);
      headers.sync(headerSpecs(workspaces, needsYou(items).length));
      pills.sync(pillSpecs(items));
    } finally {
      busy = false;
    }
  };

  void refresh();
  const cancel = (options.every ?? interval)(() => void refresh(), options.everyMs ?? REFRESH_MS);

  return {
    refresh,
    stop: () => {
      stopped = true;
      cancel();
      headers.clear();
      pills.clear();
    },
  };
}
