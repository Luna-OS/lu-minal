// The mouse on the main screen: the terminal reports it while /mouse is on (config `mouse`), the
// wheel scrolls the panel under the pointer (the focused one elsewhere, the recent folders on
// home), a click focuses a panel, and the first drag says how to select text.
import { useEffect, useRef } from "react";
import type { Agent } from "../core/agent.js";
import type { Hub } from "../core/hub.js";
import type { Project } from "../core/project.js";
import type { Layout } from "./layout.js";
import { isWheel, mouseReportingUseful, panelAt, SELECT_HINT, useMouse, useMouseInput, WHEEL_STEP } from "./mouse.js";

export function useScreenMouse(o: {
  hub: Hub;
  layout: Pick<Layout, "panels">;
  /** The project whose panels are drawn (none on home). */
  shown: Project | undefined;
  focused: Agent | undefined;
  home: boolean;
  /** Moves home's pick by one. */
  movePick: (step: 1 | -1) => void;
  scrollBy: (agent: Agent, delta: number) => void;
  /** Off while a dialog is open (dialogs read the wheel themselves). */
  isActive: boolean;
}): void {
  const input = useMouseInput();
  const on = o.hub.config.mouse !== false && mouseReportingUseful();
  useEffect(() => {
    if (!input) return;
    input.setMouse(on);
    return () => input.setMouse(false);
  }, [input, on]);

  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const dragHinted = useRef(false);
  const agentAt = (x: number, y: number) => {
    const slot = panelAt(o.layout, x, y);
    return slot ? o.shown?.agents.find((a) => a.id === slot.agentId) : undefined;
  };
  useMouse(
    (e) => {
      if (isWheel(e)) {
        const up = e.button === "wheelUp";
        if (o.home) return o.movePick(up ? -1 : 1);
        const agent = agentAt(e.x, e.y) ?? (o.shown ? o.focused : undefined);
        if (agent) o.scrollBy(agent, up ? WHEEL_STEP : -WHEEL_STEP);
        return;
      }
      if (e.button === "left" && e.action === "press") {
        pressedAt.current = { x: e.x, y: e.y };
        const agent = agentAt(e.x, e.y);
        if (agent && agent.id !== o.focused?.id) o.shown?.focus(agent);
        return;
      }
      const from = pressedAt.current;
      if (e.action !== "release" || !from) return;
      pressedAt.current = null;
      // A drag: the terminal leaves selecting to lu-minal while it reports the mouse. Say how, once.
      if ((from.x !== e.x || from.y !== e.y) && !dragHinted.current) {
        dragHinted.current = true;
        o.hub.toast(SELECT_HINT, "info");
      }
    },
    { isActive: o.isActive && on },
  );
}
