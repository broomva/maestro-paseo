// The inspector's kinds and what each says and offers (JE rule "One inspector
// for every item"; J1, J2–J4, J6b, J8; M2–M4 on the phone). One container, a
// body per kind, and a frosted action bar of that kind's verbs. The kind
// decides the verbs, and no kind offers Approve: work never asks you to approve
// it (A0; BRO-2999 retires Approve on work), and a notice is a fact
// (M4: "Open or Unblock, never Approve"). Pure (client/kit/inspector.test.ts).

export const INSPECTOR_KINDS = ["approval", "ask", "owner_step", "notice", "work", "review"] as const;
export type InspectorKind = (typeof INSPECTOR_KINDS)[number];

export interface KindLook {
  /** The kind's name, as the kicker and the detail header say it. */
  label: string;
  /** A Lucide icon name. */
  icon: string;
  /** Whether it is a hold: Tidepool-ringed, never swiped (client/kit/swipe-model.ts). */
  hold: boolean;
}

export const KIND_LOOK: Record<InspectorKind, KindLook> = {
  approval: { label: "Approval", icon: "ShieldCheck", hold: true },
  ask: { label: "Ask", icon: "CircleHelp", hold: true },
  owner_step: { label: "Owner step", icon: "Hand", hold: true },
  notice: { label: "Notice", icon: "CircleAlert", hold: false },
  work: { label: "Work", icon: "LayoutList", hold: false },
  review: { label: "Review", icon: "Target", hold: true },
};

export interface VerbSpec {
  /** Stable id the screen maps to its RPC. */
  id: string;
  label: string;
  primary: boolean;
  /** The key cap shown beside it on the desktop, if any. */
  key?: string;
  /** Drawn as a plain text link at the bar's left, not a pill (J4's "Cancel work…"). */
  link?: boolean;
}

/** Each kind's verbs, secondary first and the one primary last (the order the bar draws them). */
export const KIND_VERBS: Record<InspectorKind, readonly VerbSpec[]> = {
  approval: [
    { id: "deny", label: "Deny…", primary: false },
    { id: "allow", label: "Allow", primary: true, key: "⌘↵" },
  ],
  ask: [
    { id: "skip", label: "Skip", primary: false, key: "S" },
    { id: "answer", label: "Answer", primary: true, key: "↵" },
  ],
  owner_step: [
    { id: "later", label: "Not now", primary: false },
    { id: "done", label: "Done", primary: true },
  ],
  notice: [
    { id: "open", label: "Open session", primary: false },
    { id: "unblock", label: "Unblock…", primary: true },
  ],
  work: [
    { id: "cancel", label: "Cancel…", primary: false },
    { id: "open", label: "Open session", primary: true },
  ],
  review: [
    { id: "skip", label: "Skip", primary: false, key: "S" },
    { id: "answer", label: "Answer", primary: true, key: "↵" },
  ],
};

/** A kind's verbs, with a screen's own label for the primary ("Allow merge") when it has one. */
export function verbsFor(kind: InspectorKind, primaryLabel?: string): VerbSpec[] {
  return KIND_VERBS[kind].map((verb) => (verb.primary && primaryLabel ? { ...verb, label: primaryLabel } : verb));
}

/**
 * The desktop panel's verbs (J2–J4, J8): the kinds' own, except a notice, which also offers to cancel the
 * work (a link at the bar's left) and says Unblock sends your prompt into the session. A notice is a fact:
 * it never offers Approve.
 */
export function panelVerbsFor(kind: InspectorKind, primaryLabel?: string, driver = false): VerbSpec[] {
  // A review is answered with one of its three, or left: there is no Skip (J8). Its driver's session, when it has
  // one here, opens from the bar's left.
  if (kind === "review") {
    const answer = verbsFor(kind, primaryLabel).filter((verb) => verb.primary);
    return [...(driver ? [{ id: "open", label: "Open the driver", primary: false, link: true }] : []), ...answer];
  }
  if (kind !== "notice") return verbsFor(kind, primaryLabel);
  return [
    { id: "cancel", label: "Cancel work…", primary: false, link: true },
    { id: "open", label: "Open session", primary: false },
    { id: "unblock", label: primaryLabel ?? "Unblock with a prompt…", primary: true },
  ];
}

/** The inspector's slide, in px: it enters from beyond the right edge (J1, J6b). */
export function inspectorHidden(width: number): number {
  return width + 24;
}

/** The primary of an ask or a review: "Answer with 2" names the option the answer takes (J3); "Answer" with none chosen. */
export function answerLabel(options: readonly { id: string }[], chosen: string | undefined): string {
  const at = chosen === undefined ? -1 : options.findIndex((option) => option.id === chosen);
  return at < 0 ? "Answer" : `Answer with ${at + 1}`;
}

/**
 * The Other row (BRO-3146): an answer that takes none of an ask's options, in your words. Its id is no ledger's
 * (a ledger's option ids carry no colon), so an answer with it chosen sends no option, and the server writes
 * your words as the ask's `answer_other`.
 */
export const OTHER_CHOICE = "maestro:other";

/** The Other row as every ask card draws it, after the ask's own options. */
export const OTHER_ROW = {
  id: OTHER_CHOICE,
  label: "Other…",
  note: "None of these fit: write your answer below.",
} as const;

/**
 * An ask's options with the Other row after them: only when it has options (one with none is answered in words
 * already), says nothing against it (`allow_other: false`), and is not an idea (develop, park or kill). Pure.
 */
export function withOther<C extends { id: string }>(
  options: readonly C[],
  ask: { allowOther?: boolean; idea?: unknown } | null,
): (C | typeof OTHER_ROW)[] {
  if (!ask || options.length === 0 || ask.allowOther === false || ask.idea) return [...options];
  return [...options, OTHER_ROW];
}

/**
 * What the words field under an ask's options is for, as its placeholder says it (BRO-3146): your answer when the
 * ask has no options or Other is chosen, else a note beside the option. Pure.
 */
export function wordsPlaceholder(options: readonly { id: string }[], chosen: string | undefined | null): string {
  if (options.length === 0) return "Your answer";
  if (chosen === OTHER_CHOICE) return "Your answer, since none of the options fit";
  return "Add a note: a condition or an instruction (optional)";
}

/** An ask that cannot be answered here offers no Answer (BRO-3111): its body says why. */
export function withoutRefused<V extends { id: string }>(
  item: { kind: string; refusal?: string },
  verbs: readonly V[],
): V[] {
  return item.kind === "ask" && item.refusal ? verbs.filter((verb) => verb.id !== "answer") : [...verbs];
}
