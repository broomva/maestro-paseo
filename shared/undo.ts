// The undo window: how long an owner's decision waits before it takes effect,
// so a slip can be taken back. One value for every surface — the gate, the
// desktop and phone toasts, and the cards in sessions — decided by the owner
// on 2026-10-10 (B4 in .control/asks/maestro-next-design.yaml: "8 s everywhere").
export const UNDO_MS = 8_000;
