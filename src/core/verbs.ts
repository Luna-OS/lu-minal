// The moon-flavoured status verbs agents show while they work ("Charting… (23m 9s · ↓ 72.6k)").

export const WORK_VERBS = [
  "Charting",
  "Stargazing",
  "Orbiting",
  "Beaming",
  "Weaving",
  "Composing",
  "Patching",
  "Drifting",
  "Waxing",
  "Twinkling",
  "Moonwalking",
  "Glowing",
  "Tracing",
  "Mapping",
  "Gliding",
  "Kindling",
  "Spinning",
  "Shimmering",
] as const;

/** A verb for a new turn; `seed` keeps it stable for one turn (pass the turn's start time). */
export function workVerb(seed: number): string {
  const i = Math.abs(Math.floor(seed / 7) ^ Math.floor(seed / 1000)) % WORK_VERBS.length;
  return WORK_VERBS[i];
}

/** The lead's verb while it waits on its workers. */
export const DELEGATING = "Delegating";
