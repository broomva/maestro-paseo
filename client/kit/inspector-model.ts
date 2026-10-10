// The inspector's kinds and what each says and offers (JE rule "One inspector
// for every item"; J1, J2–J4, J6b, J8; M2–M4 on the phone). One container, a
// body per kind, and a frosted action bar of that kind's verbs. The kind
// decides the verbs, and no kind offers Approve: work never asks you to approve
// it (A0; BRO-2999 retires Approve on work), and a notice is a fact
// (M4: "Open or Unblock, never Approve"). Pure (client/kit/inspector.test.ts).

export const INSPECTOR_KINDS = ["approval", "ask", "notice", "work", "review"] as const;
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

/** The inspector's slide, in px: it enters from beyond the right edge (J1, J6b). */
export function inspectorHidden(width: number): number {
  return width + 24;
}
