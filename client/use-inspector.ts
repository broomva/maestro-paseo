// The inspector's state and its verbs, once for every desktop screen that opens one (BRO-3036: the Feed, Work's
// board, Initiatives): which hold or item is selected and open, the inspector's own item for it, every verb it
// sends through client/verbs.ts (one in flight per hold, the undo toast for what leaves a receipt), "Cancel
// work…" armed by its first press, and the keys, which are Maestro's only while focus is inside `root`.

import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import type { WorkItem } from "../shared/contracts";
import { DRAFTS_KEY, type Drafts } from "./decision-card";
import type { NeedEntry } from "./feed-model";
import { errorText } from "./format";
import {
  CANCEL_ARM_MS,
  cancelStep,
  holdInspector,
  holdKindOf,
  keyAction,
  type Selection,
  stepHold,
  workInspector,
} from "./home-model";
import { requestIntent } from "./intent";
import type { InspectorItem } from "./kit/inspector";
import { undoEntry } from "./kit/undo-model";
import { useUndoToast } from "./kit/undo-toast";
import { useOpenUrl } from "./open-url";
import { typingIn } from "./ui";
import { planVerb, useVerbs, type VerbId, type VerbTarget } from "./verbs";

type KeyEvent = {
  key: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: unknown;
  preventDefault?: () => void;
};

export interface Inspector {
  /** The screen's root: keys act only for a target inside it (the page's body is not Maestro's). */
  root: MutableRefObject<unknown>;
  selection: Selection | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  entry: NeedEntry | null;
  item: WorkItem | null;
  inspected: InspectorItem | null;
  /** The inspector is on screen: something is selected, open, and has a body. */
  showing: boolean;
  selectHold: (key: string) => void;
  selectWork: (id: string) => void;
  /** Send a verb on a target through the one adapter; true when it was sent (or opened), false when it failed or one was already in flight. */
  act: (verb: VerbId, target: VerbTarget, choice?: string, words?: string, confirmed?: boolean) => Promise<boolean>;
  targetOf: (hold: NeedEntry | null) => VerbTarget;
  /** A card's own verb: Deny and Answer open the inspector, the rest are sent. */
  onCardVerb: (hold: NeedEntry, id: string) => void;
  /** The inspector's verb, with the option chosen and the words typed. */
  onVerb: (id: string, choice?: string, words?: string) => Promise<boolean>;
  /** Walk to the next (1) or previous (-1) hold. */
  walk: (step: 1 | -1) => void;
  undo: ReturnType<typeof useUndoToast>;
}

/**
 * `entries` are every hold joined to its work or ask (the selection survives a filter); `holdKeys` the order J and
 * K walk. `onOpenWork` is where work this screen has no row for opens.
 */
export function useInspector({
  items,
  entries,
  holdKeys,
  navigation,
  onOpenWork,
  now,
}: {
  items: readonly WorkItem[];
  entries: readonly NeedEntry[];
  holdKeys: readonly string[];
  navigation?: { openAgent: (input: { agentId: string }) => void };
  onOpenWork: (id: string) => void;
  now: number;
}): Inspector {
  const toast = useToast();
  const client = useQueryClient();
  const openUrl = useOpenUrl();
  const verbs = useVerbs();
  const undo = useUndoToast((receipt) => {
    verbs.undo(receipt).catch((error: unknown) => toast.error(errorText(error)));
  });
  const root = useRef<unknown>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [open, setOpen] = useState(false);

  const entry = selection?.kind === "hold" ? (entries.find((one) => one.row.key === selection.key) ?? null) : null;
  const item = selection?.kind === "work" ? (items.find((one) => one.id === selection.id) ?? null) : null;
  const inspected = entry ? holdInspector(entry, now) : item ? workInspector(item, now) : null;
  const kind: Parameters<typeof keyAction>[0] = entry
    ? holdKindOf(entry.row)
    : item?.state === "blocked"
      ? "notice"
      : "work";

  const selectHold = (key: string) => {
    setSelection({ kind: "hold", key });
    setOpen(true);
  };
  const selectWork = (id: string) => {
    setSelection({ kind: "work", id });
    setOpen(true);
  };

  const env = {
    openUrl,
    openAgent: (agentId: string) => navigation?.openAgent({ agentId }),
  };
  // One verb at a time on a hold: it cannot be acted on again until the call has answered and every read has landed.
  const inFlight = useRef(new Set<string>());
  const act = async (
    verb: VerbId,
    target: VerbTarget,
    choice?: string,
    words?: string,
    confirmed = false,
  ): Promise<boolean> => {
    const id =
      target.row?.key ?? (target.item ? `work:${target.item.id}` : (target.proposal ?? target.notice?.key ?? verb));
    if (inFlight.current.has(id)) return false;
    inFlight.current.add(id);
    let landed: Promise<void> = Promise.resolve();
    let sent = true;
    try {
      const plan = planVerb(verb, target, choice, words, confirmed);
      const out = await verbs.run(plan, env);
      landed = out.settled;
      // Work this screen has no hold or row for opens in its own detail; the rest is for the tab that owns it.
      if (out.go?.kind === "select") onOpenWork(out.go.id);
      else if (out.go) {
        // An answer that Decisions confirms starts from what you chose and typed here, never from nothing.
        const { draft } = out;
        const decided = out.go.kind === "decisions" ? out.go.key : null;
        if (draft && decided) client.setQueryData<Drafts>(DRAFTS_KEY, (now) => ({ ...now, [decided]: draft }));
        requestIntent(out.go);
      }
      if (out.receipt) undo.show(undoEntry(out.receipt, out.done, Date.now(), out.appliesAt, "applies in"));
      else toast.show(out.done);
      // A prompt that changed since it was read answers nothing: it says so and reads again, and was not sent.
      if (plan.call === "stale") sent = false;
    } catch (error) {
      sent = false;
      toast.error(errorText(error));
    } finally {
      void landed.catch(() => undefined).then(() => inFlight.current.delete(id));
    }
    return sent;
  };
  const targetOf = (hold: NeedEntry | null): VerbTarget =>
    hold ? { row: hold.row, item: hold.item, ask: hold.ask } : { item };

  const onCardVerb = (hold: NeedEntry, id: string) => {
    if (id === "deny" || id === "answer") selectHold(hold.row.key);
    else void act(id as VerbId, targetOf(hold));
  };
  const armedCancel = useRef<{ key: string; at: number } | null>(null);
  const onVerb = (id: string, choice?: string, words?: string): Promise<boolean> => {
    if (id === "cancel" && item) {
      // "Cancel work…": the first press arms it, the second on the same item does it.
      const step = cancelStep(armedCancel.current, item.id, Date.now());
      if (step === "arm") {
        armedCancel.current = { key: item.id, at: Date.now() };
        toast.show(`Press Cancel work… again within ${CANCEL_ARM_MS / 1000} s to cancel it`);
        return Promise.resolve(false);
      }
      armedCancel.current = null;
    }
    return act(id as VerbId, targetOf(entry), choice, words);
  };

  const walk = (step: 1 | -1) => {
    const next = stepHold([...holdKeys], selection?.kind === "hold" ? selection.key : null, step);
    if (next) selectHold(next);
  };
  const walkRef = useRef(walk);
  walkRef.current = walk;
  const keyRef = useRef({ kind, open, inspected: inspected !== null, onVerb });
  keyRef.current = { kind, open, inspected: inspected !== null, onVerb };
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const doc = (
      globalThis as {
        document?: {
          addEventListener(type: "keydown", fn: (event: KeyEvent) => void): void;
          removeEventListener(type: "keydown", fn: (event: KeyEvent) => void): void;
        };
      }
    ).document;
    if (!doc) return;
    const onInspectorKey = (event: KeyEvent) => {
      if (!keyRef.current.open || !keyRef.current.inspected) return;
      // Maestro's keys are Maestro's only while focus is inside its screen: the page's body is not Maestro's.
      const within = root.current as { contains?: (other: unknown) => boolean } | null;
      const target = event.target;
      if (!target || !within?.contains?.(target)) return;
      const action = keyAction(
        keyRef.current.kind,
        { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey },
        typingIn(target),
      );
      if (!action) return;
      event.preventDefault?.();
      if ("step" in action) walkRef.current(action.step);
      // A held key sends a verb once: only the first press acts.
      else if (!event.repeat) keyRef.current.onVerb(action.verb);
    };
    doc.addEventListener("keydown", onInspectorKey);
    return () => doc.removeEventListener("keydown", onInspectorKey);
  }, []);

  return {
    root,
    selection,
    open,
    setOpen,
    entry,
    item,
    inspected,
    showing: open && inspected !== null,
    selectHold,
    selectWork,
    act,
    targetOf,
    onCardVerb,
    onVerb,
    walk,
    undo,
  };
}
