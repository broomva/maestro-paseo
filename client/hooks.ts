// Request state for the surfaces. The work list polls: the daemon side moves
// work on agent events, and polling keeps every open client honest without a
// second subscription channel.

import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
} from "../shared/contracts";

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

/** Every verb invalidates all Maestro queries: one change can move several views. */
export function useVerbs() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: KEY });
  const rpc = {
    create: useRpc(createWork),
    dispatch: useRpc(dispatchWork),
    verdict: useRpc(decideWork),
    unblock: useRpc(unblockWork),
    cancel: useRpc(cancelWork),
    adopt: useRpc(adoptAgent),
    saveConfig: useRpc(setConfig),
  };
  return {
    create: useMutation({ mutationFn: rpc.create, onSettled: refresh }),
    dispatch: useMutation({ mutationFn: rpc.dispatch, onSettled: refresh }),
    verdict: useMutation({ mutationFn: rpc.verdict, onSettled: refresh }),
    unblock: useMutation({ mutationFn: rpc.unblock, onSettled: refresh }),
    cancel: useMutation({ mutationFn: rpc.cancel, onSettled: refresh }),
    adopt: useMutation({ mutationFn: rpc.adopt, onSettled: refresh }),
    saveConfig: useMutation({ mutationFn: rpc.saveConfig, onSettled: refresh }),
  };
}
