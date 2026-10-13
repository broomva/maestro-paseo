// What every card reads and how it acts (BRO-3008): the live reads by key, and the one runner of the adapter's
// verbs. Apart from the components so the digest and the session page use them without importing each other.

import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getWork } from "../shared/contracts";
import { holdOf } from "../shared/needs";
import type { Ledger, Read } from "./card-model";
import { DRAFTS_KEY, type Drafts } from "./decision-card";
import { errorText } from "./format";
import { useVerbLedger } from "./hooks";
import type { MaestroIntent } from "./intent";
import { useOpenUrl } from "./open-url";
import { useVerbs, type VerbPlan } from "./verbs";

/** How Open in Maestro and a verb's "go" leave the card: this plugin's own screens (index.client.tsx). */
export interface CardActions {
  /** K2: the session's page (`openScreen({screenId: "session", params: {agentId}})`). */
  session(agentId: string): void;
  /** The hold's inspector on Maestro's Feed (`params.hold`, BRO-3033 fact 2). */
  hold(key: string): void;
  /** Maestro's home. */
  maestro(): void;
  /** Somewhere a verb sends you (Decisions, the item). */
  intent(intent: MaestroIntent): void;
}

/** How often a card that can still change reads again: the ledger sets its own 1 s beat while a verb waits. */
export const CARD_POLL_MS = 5_000;

/** A query as the model reads it: a failed read is an error, even when an older read is still held. */
export function readOf<T>(query: { data?: T; isError: boolean; error: unknown }): Read<T> {
  if (query.isError) return { status: "error", message: errorText(query.error) };
  return query.data !== undefined ? { status: "ok", value: query.data } : { status: "loading" };
}

/** The ledger as the cards read it: what waits out its window, and what settled in the last day. */
export function useCardLedger(): { read: Read<Ledger>; retry: () => void } {
  const query = useVerbLedger();
  return { read: readOf<Ledger>(query), retry: () => void query.refetch() };
}

/** The work behind a card, on the key every surface reads it by, so a verb anywhere refreshes it. */
export function useCardWork(key: string, live: boolean) {
  const get = useRpc(getWork);
  const hold = holdOf(key);
  const id = hold?.kind === "work" ? hold.id : null;
  return useQuery({
    queryKey: ["maestro", "item", id],
    queryFn: () => get({ id: id ?? "" }),
    enabled: id !== null,
    refetchInterval: live ? CARD_POLL_MS : false,
  });
}

// ── Verbs ────────────────────────────────────────────────────────────────────

/** Holds with a verb in flight, across every card: two cards of one hold (the session's and the inbox's) are one. */
const inFlight = new Set<string>();

/**
 * Runs the adapter's plan for a card: one verb at a time per hold (a second press, or the same hold's other
 * card, waits until the call has answered and everything has been read again), the failure said, the receipt
 * left to the ledger (the card reads it back as its undo window).
 */
export function useCardRunner(actions: CardActions, claim: string) {
  const verbs = useVerbs();
  const toast = useToast();
  const openUrl = useOpenUrl();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** `work` may hand `until` a promise (everything read again): the hold is released only once it settles. */
  const guarded = async (
    key: string,
    setWorking: (working: boolean) => void,
    work: (until: (landed: Promise<void>) => void) => Promise<void>,
  ) => {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    setWorking(true);
    let landed: Promise<void> = Promise.resolve();
    try {
      await work((next) => {
        landed = next;
      });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      void landed
        .catch(() => undefined)
        .then(() => {
          inFlight.delete(key);
          if (mounted.current) setWorking(false);
        });
    }
  };
  return {
    busy,
    undoing,
    act: (plan: VerbPlan) =>
      guarded(claim, setBusy, async (until) => {
        const out = await verbs.run(plan, { openUrl, openAgent: actions.session });
        until(out.settled);
        if (out.go) {
          // An answer Decisions confirms starts from what you chose and typed here, never from nothing.
          const decided = out.go.kind === "decisions" ? out.go.key : null;
          const { draft } = out;
          if (draft && decided) client.setQueryData<Drafts>(DRAFTS_KEY, (now) => ({ ...now, [decided]: draft }));
          actions.intent(out.go);
        } else if (!out.receipt) toast.show(out.done);
      }),
    // Its own claim: Undo is pressed inside the window, while the verb it takes back may still be reading
    // everything again (seconds, on a busy daemon), and a press that waited for that would be dropped.
    undo: (receipt: string) =>
      guarded(`${claim}#undo`, setUndoing, async () => {
        await verbs.undo(`verb:${receipt}`);
      }),
  };
}
