// A tiny change notifier: state classes call `changed()`, the UI subscribes once and re-renders.
//
// Every notification is a whole frame: the UI renders again and Ink lays out and draws the whole
// screen (a few dozen ms on a big terminal). A busy Claude Code agent streams ~50 small deltas a
// second, so a few agents would ask for hundreds of frames a second and keep a CPU core busy. So
// notifications are coalesced: a change after a quiet spell goes out on the next macrotask (the
// UI stays as quick as before), but while changes keep coming at most one goes out every
// NOTIFY_INTERVAL_MS. User input skips the wait (urgent()), and flush() delivers right away.

export type Listener = () => void;

/** While changes keep coming (agents streaming), at most one notification this often: 10 a second. */
export const NOTIFY_INTERVAL_MS = 100;

export class Notifier {
  private listeners = new Set<Listener>();
  private version = 0;
  /** The delivery on the next macrotask, or the one waiting out the interval. */
  private immediate: NodeJS.Immediate | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastDeliveryAt = Number.NEGATIVE_INFINITY;

  /** `intervalMs`: the least time between two notifications while changes keep coming (0: none). */
  constructor(readonly intervalMs: number = NOTIFY_INTERVAL_MS) {}

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

  /** Whether a notification is waiting to go out. */
  get pending(): boolean {
    return this.immediate !== null || this.timer !== null;
  }

  changed(): void {
    this.version++;
    if (this.pending) return;
    // Clamped, so a clock set back can't hold the screen for longer than one interval.
    const wait = Math.min(this.intervalMs, this.lastDeliveryAt + this.intervalMs - Date.now());
    if (wait <= 0) this.immediate = setImmediate(this.deliver);
    else this.timer = setTimeout(this.deliver, wait);
  }

  /** For user input: a notification waiting out the interval goes out on the next macrotask. */
  urgent(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.immediate = setImmediate(this.deliver);
  }

  /** Notifies right away (tests, shutdown). */
  flush(): void {
    this.deliver();
  }

  private deliver = (): void => {
    if (this.immediate) clearImmediate(this.immediate);
    if (this.timer) clearTimeout(this.timer);
    this.immediate = null;
    this.timer = null;
    this.lastDeliveryAt = Date.now();
    for (const listener of [...this.listeners]) listener();
  };
}

let counter = 0;

/** A short unique id: "<prefix>_<time36><n36>". */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_679_616;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}
