// Host registrations kept in step with what should exist. Paseo has no global
// header slot and no global composer slot: a header button is registered per
// workspace and a composer pill per agent. So each refresh hands `sync` the
// full set it wants, keyed, and it adds the new keys, updates in place the ones
// whose spec changed, and removes the ones that went away. Pure: the host calls
// are passed in, and a spec is flat data compared field by field.

export type Spec = Readonly<Record<string, string | number | boolean | null>>;

export interface Removable {
  remove(): void;
}

export interface RegistrationHost<S extends Spec, H extends Removable> {
  add(key: string, spec: S): H;
  update(handle: H, spec: S): void;
}

export function sameSpec(a: Spec, b: Spec): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

export class Registrations<S extends Spec, H extends Removable> {
  private readonly live = new Map<string, { spec: S; handle: H }>();
  /** The last refusal logged per key, so a refusal that lasts is logged once, not on every sync. */
  private readonly refused = new Map<string, string>();

  constructor(
    private readonly host: RegistrationHost<S, H>,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  sync(next: ReadonlyMap<string, S>): void {
    for (const key of [...this.refused.keys()]) if (!next.has(key)) this.refused.delete(key);
    for (const [key, entry] of [...this.live]) {
      if (next.has(key)) continue;
      this.live.delete(key);
      entry.handle.remove();
    }
    // The host validates what it is given; one refusal must not cost any other registration.
    for (const [key, spec] of next) {
      const entry = this.live.get(key);
      try {
        if (!entry) {
          this.live.set(key, { spec, handle: this.host.add(key, spec) });
        } else if (!sameSpec(entry.spec, spec)) {
          this.host.update(entry.handle, spec);
          // Recorded only once the host took it, so a refused update is tried again next time.
          entry.spec = spec;
        } else {
          continue;
        }
        this.refused.delete(key);
      } catch (error) {
        const message = `Could not ${entry ? "update" : "add"} ${key}: ${(error as Error).message}`;
        if (this.refused.get(key) !== message) this.log(message);
        this.refused.set(key, message);
      }
    }
  }

  clear(): void {
    const entries = [...this.live.values()];
    this.live.clear();
    this.refused.clear();
    for (const entry of entries) entry.handle.remove();
  }

  keys(): string[] {
    return [...this.live.keys()];
  }
}
