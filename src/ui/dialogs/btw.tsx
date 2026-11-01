// /btw: a quick side question to the focused agent. The answer shows here, with the conversation as
// context and no tools, and neither the question nor the answer joins the conversation; the agent's
// running turn goes on. Esc closes (and stops a question still waiting).
import React, { useEffect, useState } from "react";
import type { Agent } from "../../core/agent.js";
import type { Hub } from "../../core/hub.js";
import type { UiServices } from "../store.js";
import { MessageDialog } from "./InputDialog.js";

export function openBtwDialog(hub: Hub, ui: UiServices, agent: Agent, question: string): void {
  ui.openDialog({ id: "btw", render: (close) => <BtwDialog hub={hub} agent={agent} question={question} close={close} /> });
}

type State = { kind: "waiting" } | { kind: "answer"; text: string } | { kind: "error"; text: string };

function BtwDialog({ hub, agent, question, close }: { hub: Hub; agent: Agent; question: string; close: () => void }) {
  const c = hub.theme.colors;
  const [state, setState] = useState<State>({ kind: "waiting" });
  useEffect(() => {
    const controller = new AbortController();
    hub.askAside(agent, question, controller.signal).then(
      (text) => setState({ kind: "answer", text }),
      (err: unknown) => {
        if (!controller.signal.aborted) setState({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => controller.abort();
  }, [hub, agent, question]);
  const body =
    state.kind === "waiting"
      ? [{ text: `${agent.name} is thinking…`, color: c.faint }]
      : state.kind === "error"
        ? [{ text: state.text, color: c.error }]
        : state.text.split(/\r?\n/).map((text) => ({ text, color: c.text }));
  return (
    <MessageDialog
      theme={hub.theme}
      title={`btw · ${agent.name}`}
      lines={[{ text: `› ${question}`, color: c.accent }, "", ...body, "", { text: "Not added to the conversation.", color: c.faint }]}
      hints={state.kind === "waiting" ? "esc cancel" : "enter / esc close"}
      onClose={close}
    />
  );
}
