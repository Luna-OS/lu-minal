// Claude Code on the web from lu-minal: start a cloud session for a task, send it messages, open it
// in the browser, or teleport it into this terminal.
import React from "react";
import type { Hub } from "../../core/hub.js";
import type { Project } from "../../core/project.js";
import { cloudReadiness, CLOUD_HOME, type CloudSession } from "../../cloud/claude-cloud.js";
import { openExternal } from "../../platform/process.js";
import { formatAgo } from "../format.js";
import type { UiServices } from "../store.js";
import { InputDialog } from "./InputDialog.js";
import { ListDialog, type ListItem } from "./ListDialog.js";

export function openCloudDialog(hub: Hub, ui: UiServices): void {
  const project = hub.activeProject;
  if (!project) return hub.toast("Open a project first (ctrl+t).", "warning");
  ui.openDialog({ id: "cloud", render: (close) => <CloudDialog hub={hub} ui={ui} project={project} close={close} /> });
}

function CloudDialog({ hub, ui, project, close }: { hub: Hub; ui: UiServices; project: Project; close: () => void }) {
  const [warning, setWarning] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    void cloudReadiness(project.cwd).then((w) => live && setWarning(w));
    return () => {
      live = false;
    };
  }, [project.cwd]);
  const c = hub.theme.colors;
  const signedIn = Boolean(hub.claudeAccount?.loggedIn);
  const here = hub.cloudSessions.filter((s) => s.cwd === project.cwd);
  const elsewhere = hub.cloudSessions.filter((s) => s.cwd !== project.cwd);
  const item = (s: CloudSession, group: string): ListItem => ({
    id: `s:${s.id}`,
    label: s.task.length > 50 ? `${s.task.slice(0, 49)}…` : s.task,
    hint: `${s.id} · started ${formatAgo(s.startedAt)}${s.lastMessageAt ? ` · messaged ${formatAgo(s.lastMessageAt)}` : ""}`,
    group,
    badge: s.lastError ? { text: "✗", color: c.error } : { text: "☁", color: c.accent2 },
  });
  const items: ListItem[] = [
    { id: "new", label: "✦ New cloud session…", hint: "claude --cloud runs the task on claude.ai/code", group: "Claude on the web" },
    { id: "paste", label: "Add a session by its link…", hint: "for sessions started elsewhere", group: "Claude on the web" },
    { id: "web", label: "Open claude.ai/code", hint: "all your cloud sessions", group: "Claude on the web" },
    ...here.map((s) => item(s, `Sessions from ${project.name}`)),
    ...elsewhere.map((s) => item(s, "Other projects")),
  ];
  const subtitle = !signedIn
    ? "sign in to Claude first (ctrl+l)"
    : warning
      ? `▲ ${warning}`
      : "the cloud works on your pushed branch";
  return (
    <ListDialog
      theme={hub.theme}
      title="Claude cloud"
      subtitle={subtitle}
      items={items}
      hints="enter pick · m message · t teleport · o open · x forget · esc close"
      onCancel={close}
      onKey={(input, _key, picked) => {
        const s = picked?.id.startsWith("s:") ? hub.cloudSessions.find((x) => `s:${x.id}` === picked.id) : undefined;
        if (!s) return false;
        if (input === "m") askMessage(hub, ui, s);
        else if (input === "t") void teleport(hub, ui, project, s);
        else if (input === "o") void openExternal(s.url);
        else if (input === "x") hub.forgetCloud(s.id);
        else return false;
        return true;
      }}
      onSelect={(picked) => {
        if (picked.id === "new") return askTask(hub, ui, project);
        if (picked.id === "paste") return askLink(hub, ui, project, "");
        if (picked.id === "web") return void openExternal(CLOUD_HOME);
        const s = hub.cloudSessions.find((x) => `s:${x.id}` === picked.id);
        if (s) sessionActions(hub, ui, project, s);
      }}
    />
  );
}

function sessionActions(hub: Hub, ui: UiServices, project: Project, s: CloudSession): void {
  ui.openDialog({
    id: `cloud-${s.id}`,
    render: (close) => (
      <ListDialog
        theme={hub.theme}
        title={s.task.length > 60 ? `${s.task.slice(0, 59)}…` : s.task}
        subtitle={s.lastError ? `✗ ${s.lastError}` : s.url}
        filter={false}
        items={[
          { id: "open", label: "Open in the browser", hint: s.url },
          { id: "msg", label: "Send a message…", hint: "claude -p … --cloud" },
          { id: "teleport", label: "Teleport into this terminal", hint: `continue it locally in ${project.name}` },
          { id: "forget", label: "Forget it here", hint: "it keeps running on claude.ai" },
        ]}
        onCancel={close}
        onSelect={(picked) => {
          close();
          if (picked.id === "open") void openExternal(s.url);
          else if (picked.id === "msg") askMessage(hub, ui, s);
          else if (picked.id === "teleport") void teleport(hub, ui, project, s);
          else if (picked.id === "forget") hub.forgetCloud(s.id);
        }}
      />
    ),
  });
}

function askTask(hub: Hub, ui: UiServices, project: Project): void {
  ui.openDialog({
    id: "cloud-task",
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title="New cloud session"
        lines={[
          "Claude works on the task on claude.ai/code, in a fresh clone of this repository's pushed branch.",
          "lu-minal steps aside while Claude Code sets the session up, then comes back.",
        ]}
        placeholder="Fix the flaky login test and open a pull request"
        onCancel={close}
        onSubmit={async (task) => {
          close();
          try {
            const session = await hub.startCloud(project, task, ui.runInTerminal);
            if (!session) askLink(hub, ui, project, task);
          } catch (err) {
            hub.toast(err instanceof Error ? err.message : String(err), "error");
          }
        }}
      />
    ),
  });
}

function askLink(hub: Hub, ui: UiServices, project: Project, task: string): void {
  ui.openDialog({
    id: "cloud-link",
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title="Cloud session link"
        lines={[
          task
            ? "Paste the session link Claude Code showed (https://claude.ai/code/session_…) so lu-minal can message and teleport it."
            : "Paste a cloud session's link or id (https://claude.ai/code/session_…).",
        ]}
        placeholder="https://claude.ai/code/session_…"
        onCancel={close}
        onSubmit={(link) => {
          const s = hub.addCloudSession(project, task || "Cloud session", link);
          if (!s) {
            hub.toast("That doesn't look like a cloud session link.", "warning");
            return;
          }
          close();
        }}
      />
    ),
  });
}

function askMessage(hub: Hub, ui: UiServices, s: CloudSession): void {
  ui.openDialog({
    id: "cloud-msg",
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title={`Message ${s.id}`}
        lines={["Sent to the cloud session as its next message."]}
        onCancel={close}
        onSubmit={async (text) => {
          close();
          const r = await hub.sendCloud(s, text);
          hub.toast(r.ok ? "Sent to the cloud session." : `Cloud: ${r.error}`, r.ok ? "success" : "error");
        }}
      />
    ),
  });
}

async function teleport(hub: Hub, ui: UiServices, project: Project, s: CloudSession): Promise<void> {
  try {
    await hub.teleport(project, s, ui.runInTerminal);
  } catch (err) {
    hub.toast(err instanceof Error ? err.message : String(err), "error");
  }
}
