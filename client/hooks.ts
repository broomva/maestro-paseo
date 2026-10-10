// Request state for the surfaces. The work list polls: the daemon side moves
// work on agent events, and polling keeps every open client honest without a
// second subscription channel. What needs you (needs.list) and what was
// handled (handled.list) are one query each, refetched when a session changes
// (useNeedsEvents) or a verb settles, and otherwise on a slow fallback.

import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
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
  leaveRunning,
  listWork,
  setConfig,
  stopWork,
  unblockWork,
  undoWork,
  wakeLoop,
  workForAgent,
} from "../shared/contracts";
import { listHandled, listNeeds, type Needs } from "../shared/needs";
import { type LoopState, loopPollMs } from "./loop-model";
import { onNeeds, publishNeeds, watchSessions } from "./needs-bus";

const KEY = ["maestro"] as const;
const POLL_MS = 4000;

export function useWorkList() {
  const list = useRpc(listWork);
  return useQuery({ queryKey: [...KEY, "list"], queryFn: () => list({}), refetchInterval: POLL_MS });
}

export function useWorkDetail(id: string | null) {
  const get = useRpc(getWork);
  return useQuery({
    queryKey: [...KEY, "item", id],
    queryFn: () => get({ id: id ?? "" }),
    enabled: id !== null,
    refetchInterval: POLL_MS,
  });
}

export function useAgentWork(agentId: string) {
  const find = useRpc(workForAgent);
  return useQuery({ queryKey: [...KEY, "agent", agentId], queryFn: () => find({ agentId }), refetchInterval: POLL_MS });
}

export function useConfig() {
  const get = useRpc(getConfig);
  return useQuery({ queryKey: [...KEY, "config"], queryFn: () => get({}) });
}

/**
 * The loop's state (loop.get): its period, its next wake, whether one runs,
 * and the newest wakes. Asked every 30 s, every 5 s while a wake is due or
 * running, and never later than the next wake (loopPollMs); React Query
 * stops asking once nothing that reads it is mounted.
 */
export function useLoop() {
  const get = useRpc(getLoop);
  return useQuery({
    queryKey: [...KEY, "loop"],
    queryFn: (): Promise<LoopState> => get({}),
    refetchInterval: (query) => loopPollMs(query.state.data ?? null, Date.now()),
  });
}

/** Refetch every Maestro query now, as when a decision's undo window closes. */
export function useRefresh() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: KEY }), [client]);
}

/** Every verb invalidates all Maestro queries: one change can move several views. */
export function useVerbs() {
  const refresh = useRefresh();
  const rpc = {
    create: useRpc(createWork),
    dispatch: useRpc(dispatchWork),
    verdict: useRpc(decideWork),
    unblock: useRpc(unblockWork),
    cancel: useRpc(cancelWork),
    undo: useRpc(undoWork),
    stop: useRpc(stopWork),
    adopt: useRpc(adoptAgent),
    leaveRunning: useRpc(leaveRunning),
    saveConfig: useRpc(setConfig),
    wake: useRpc(wakeLoop),
  };
  return {
    create: useMutation({ mutationFn: rpc.create, onSettled: refresh }),
    dispatch: useMutation({ mutationFn: rpc.dispatch, onSettled: refresh }),
    verdict: useMutation({ mutationFn: rpc.verdict, onSettled: refresh }),
    unblock: useMutation({ mutationFn: rpc.unblock, onSettled: refresh }),
    cancel: useMutation({ mutationFn: rpc.cancel, onSettled: refresh }),
    undo: useMutation({ mutationFn: rpc.undo, onSettled: refresh }),
    stop: useMutation({ mutationFn: rpc.stop, onSettled: refresh }),
    adopt: useMutation({ mutationFn: rpc.adopt, onSettled: refresh }),
    leaveRunning: useMutation({ mutationFn: rpc.leaveRunning, onSettled: refresh }),
    saveConfig: useMutation({ mutationFn: rpc.saveConfig, onSettled: refresh }),
    wake: useMutation({ mutationFn: () => rpc.wake({}), onSettled: refresh }),
  };
}

export const NEEDS_KEY = [...KEY, "needs"] as const;
export const HANDLED_KEY = [...KEY, "handled"] as const;
/** Between events: ask ledgers, the fleet's roots, initiatives and the answers batch send none. */
export const NEEDS_POLL_MS = 30_000;
/** After a session event: long enough for the daemon to record the change, and to make a burst one read. */
export const NEEDS_NUDGE_MS = 2_000;

/**
 * What needs you (needs.list, BRO-3001): the one projection every count,
 * badge and Needs you section reads. One query; useNeedsEvents refetches it
 * when a session changes, every verb when it settles (useVerbs).
 */
export function useNeeds() {
  const read = useRpc(listNeeds);
  return useQuery({ queryKey: NEEDS_KEY, queryFn: () => read({}), refetchInterval: NEEDS_POLL_MS });
}

/** What closed, and today's counts (handled.list): one query, refetched with needs.list. */
export function useHandled() {
  const read = useRpc(listHandled);
  return useQuery({ queryKey: HANDLED_KEY, queryFn: () => read({}), refetchInterval: NEEDS_POLL_MS });
}

/** Refetch needs.list and handled.list now. */
export function invalidateNeeds(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: NEEDS_KEY });
  void client.invalidateQueries({ queryKey: HANDLED_KEY });
}

/**
 * Keeps what needs you current on this screen: a session that changes
 * (Paseo's agent events: a turn ending, a permission asked, an archive)
 * refetches it, one read per burst NEEDS_NUDGE_MS after its first event
 * (client/needs-bus.ts watchSessions); every read this screen makes moves the
 * header button, and every read the header makes fills this screen, so the
 * two never show different numbers (publishNeeds). Mounted once by the screen.
 */
export function useNeedsEvents(): void {
  const paseo = usePaseo();
  const client = useQueryClient();
  useEffect(() => {
    const stopWatching = watchSessions({
      subscribe: (handler) => paseo.agents.subscribe(handler),
      nudge: () => invalidateNeeds(client),
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      ms: NEEDS_NUDGE_MS,
      log: (message) => console.warn(`[maestro] ${message}`),
    });
    const stopHearing = onNeeds((needs, from) => {
      if (from === "header") client.setQueryData(NEEDS_KEY, needs);
    });
    const key = JSON.stringify(NEEDS_KEY);
    const stopTelling = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      if (JSON.stringify(event.query.queryKey) !== key) return;
      const data = event.query.state.data as Needs | undefined;
      if (data) publishNeeds(data, "screen");
    });
    return () => {
      stopWatching();
      stopHearing();
      stopTelling();
    };
  }, [paseo, client]);
}

/**
 * What you watch beside what needs you (work.attention's fleet, timeline and
 * loop notices): the bands above the views read it, one query at one rate.
 * Nothing counts from it; notices.list replaces it (BRO-3036).
 */
export function useWatched() {
  const read = useRpc(attentionWork);
  return useQuery({ queryKey: [...KEY, "attention"], queryFn: () => read({}), refetchInterval: 30_000 });
}
