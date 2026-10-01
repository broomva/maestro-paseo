// Request state for the surfaces. The work list polls: the daemon side moves
// work on agent events, and polling keeps every open client honest without a
// second subscription channel.

import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  adoptAgent,
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
import { LOOP_DUE_POLL_MS, LOOP_POLL_MS, type LoopState, loopDue } from "./loop-model";

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
 * running; React Query stops asking once nothing that reads it is mounted.
 */
export function useLoop() {
  const get = useRpc(getLoop);
  return useQuery({
    queryKey: [...KEY, "loop"],
    queryFn: (): Promise<LoopState> => get({}),
    refetchInterval: (query) => (loopDue(query.state.data ?? null, Date.now()) ? LOOP_DUE_POLL_MS : LOOP_POLL_MS),
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
