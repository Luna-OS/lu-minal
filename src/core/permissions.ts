// What each permission mode does with each kind of action.
import type { PermissionMode, RiskKind } from "./types.js";

export type PermissionVerdict = "allow" | "ask" | "deny";

/** The verdict for an action of `risk` under `mode`, before any "always allow" rule. */
export function verdictFor(mode: PermissionMode, risk: RiskKind): PermissionVerdict {
  if (risk === "read") return "allow";
  switch (mode) {
    case "yolo":
      return "allow";
    case "plan":
      return risk === "network" ? "allow" : "deny";
    case "auto-edit":
      return risk === "edit" || risk === "network" ? "allow" : "ask";
    case "ask":
    default:
      return "ask";
  }
}

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  "auto-edit": "edits on",
  ask: "ask first",
  yolo: "do everything",
  plan: "plan only",
};

export const PERMISSION_HINTS: Record<PermissionMode, string> = {
  "auto-edit": "Edits inside the project run on their own; commands ask first.",
  ask: "Edits and commands ask first.",
  yolo: "Everything runs without asking.",
  plan: "Read-only: agents plan and talk, but edit and run nothing.",
};

/** The next mode in the cycle (Shift+Tab / /perm). */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const order: PermissionMode[] = ["auto-edit", "ask", "yolo", "plan"];
  return order[(order.indexOf(mode) + 1) % order.length];
}
