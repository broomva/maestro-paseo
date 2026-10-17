// The phone's place and drafts on the device (BRO-3180 B): client/phone/resume.ts's records kept through
// client/kit/durable.ts. The place is written at once; drafts are written 300 ms after the last keystroke, and at
// once when the screen unmounts (`flushDrafts`), since an unmount may be the host dropping the link.

import { type DurableStore, deviceStore } from "../kit/durable";
import { type Drafts, EMPTY_RESUME, parseDrafts, parseResume, type Resume } from "./resume";

const RESUME_KEY = "phone.resume";
const DRAFTS_KEY = "phone.drafts";
export const DRAFT_WRITE_MS = 300;

let store: () => DurableStore = deviceStore;
let pending: ReturnType<typeof setTimeout> | null = null;
let unsaved: Drafts | null = null;

/** Tests hand in their own store. */
export function setStoreForTests(next: DurableStore): void {
  store = () => next;
  pending = null;
  unsaved = null;
}

export function loadResume(): Resume {
  return store().get(RESUME_KEY, parseResume) ?? EMPTY_RESUME;
}

export function saveResume(patch: Partial<Resume>): Resume {
  const next = { ...loadResume(), ...patch };
  store().set(RESUME_KEY, next);
  return next;
}

export function loadDrafts(): Drafts {
  return unsaved ?? store().get(DRAFTS_KEY, parseDrafts) ?? {};
}

export function saveDrafts(next: Drafts): void {
  unsaved = next;
  if (pending) clearTimeout(pending);
  pending = setTimeout(flushDrafts, DRAFT_WRITE_MS);
}

export function flushDrafts(): void {
  if (pending) clearTimeout(pending);
  pending = null;
  if (unsaved === null) return;
  store().set(DRAFTS_KEY, unsaved);
  unsaved = null;
}
