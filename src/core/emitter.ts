// A tiny change notifier: state classes call `changed()`, the UI subscribes once and re-renders.
// Notifications are coalesced to one per macrotask, so a burst of stream deltas costs one render.

export type Listener = () => void;

export class Notifier {
  private listeners = new Set<Listener>();
  private scheduled = false;
  private version = 0;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A number that changes on every notification (for useSyncExternalStore snapshots). */
  get snapshot(): number {
    return this.version;
  }

  changed(): void {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  /** Notifies right away (tests, shutdown). */
  flush(): void {
    this.scheduled = false;
    for (const listener of [...this.listeners]) listener();
  }
}

let counter = 0;

/** A short unique id: "<prefix>_<time36><n36>". */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_679_616;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}
