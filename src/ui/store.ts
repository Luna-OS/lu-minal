// How components reach the Hub: one context, one subscription. Every change notification
// re-renders the tree (they are coalesced per macrotask and Ink caps the frame rate).
import { createContext, useContext, useSyncExternalStore } from "react";
import type { Hub, TerminalRunner } from "../core/hub.js";
import type { Theme } from "../themes/types.js";

export const HubContext = createContext<Hub | null>(null);

export function useHub(): Hub {
  const hub = useContext(HubContext);
  if (!hub) throw new Error("useHub outside <HubContext>");
  useSyncExternalStore(
    (cb) => hub.notifier.subscribe(cb),
    () => hub.notifier.snapshot,
  );
  return hub;
}

export function useTheme(): Theme {
  return useHub().theme;
}

/** UI services that only exist while the app is mounted. */
export interface UiServices {
  /** Hands the terminal to a program (sign-ins, installers) and comes back. */
  runInTerminal: TerminalRunner;
  /** Opens a dialog on top of everything. */
  openDialog: (dialog: DialogSpec) => void;
  /** Closes the top dialog. */
  closeDialog: () => void;
  /** Quits lu-minal. */
  quit: () => void;
}

export interface DialogSpec {
  id: string;
  /** Renders the dialog; `close` closes this one. */
  render: (close: () => void) => React.ReactNode;
}

export const UiContext = createContext<UiServices | null>(null);

export function useUi(): UiServices {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi outside <UiContext>");
  return ui;
}
