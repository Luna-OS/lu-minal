// Claude Code cloud sessions from the terminal: start one for a task, browse every session of the
// account in Claude Code's own picker, message a session, teleport it into this terminal or watch
// it live. The browser is only a secondary key (o).
import React from "react";
import type { Hub } from "../../core/hub.js";
import type { Project } from "../../core/project.js";
import { cloudReadiness, CLOUD_HOME, shortCloudError, type CloudSession } from "../../cloud/claude-cloud.js";
import { samePath } from "../../platform/paths.js";
import { openExternal } from "../../platform/process.js";
import { formatAgo } from "../format.js";
import type { UiServices } from "../store.js";
import { InputDialog } from "./InputDialog.js";
import { ListDialog, type ListItem } from "./ListDialog.js";

// The two lines above the list (short enough for an 80-column terminal).
/** Where a cloud session's progress can be followed. */
export const LIVE_NOTE = "Live progress: claude.ai/code, the Claude app, or teleport it here (t).";
/** Under it, for a highlighted session. */
export const WATCH_NOTE = "w watches live - some accounts can't yet; t (teleport) works for everyone.";
const NOTES: Record<string, string> = {
  new: "Claude Code sets it up in this terminal, then it runs in the cloud.",
  all: "Claude Code's picker of every cloud session you have - pull one in here.",
  paste: "For a session started on the web, in the Claude app or on another computer.",
};

export interface CloudDialogDeps {
  /** Opens a link in the browser (tests pass a fake). */
  open?: (url: string) => unknown;
  /** Whether the folder is ready for the cloud (tests pass a fake instead of running git). */
  readiness?: (cwd: string) => Promise<string | null>;
}

export function openCloudDialog(hub: Hub, ui: UiServices, deps: CloudDialogDeps = {}): void {
  const project = hub.activeProject;
  if (!project) return hub.toast("Open a project first (ctrl+t).", "warning");
  ui.openDialog({ id: "cloud", render: (close) => <CloudDialog hub={hub} ui={ui} project={project} close={close} deps={deps} /> });
}

/** "started 2h ago · messaged 5m ago · ✗ Session archived": a remembered session's row. */
export function sessionDetails(s: CloudSession, now = Date.now()): string {
  const parts = [`started ${formatAgo(s.startedAt, now)}`, s.lastMessageAt ? `messaged ${formatAgo(s.lastMessageAt, now)}` : "no follow-up yet"];
  // The row already is that session: "cloud session session_x is archived" -> "cloud session is archived".
  if (s.lastError) parts.push(`✗ ${shortCloudError(s.lastError).replace(` ${s.id} `, " ")}`);
  return parts.join(" · ");
}

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function CloudDialog({ hub, ui, project, close, deps }: { hub: Hub; ui: UiServices; project: Project; close: () => void; deps: CloudDialogDeps }) {
  const [warning, setWarning] = React.useState<string | null>(null);
  const [composing, setComposing] = React.useState<CloudSession | null>(null);
  const [highlighted, setHighlighted] = React.useState<string | undefined>(undefined);
  const open = deps.open ?? openExternal;
  React.useEffect(() => {
    let live = true;
    void (deps.readiness ?? cloudReadiness)(project.cwd).then((w) => live && setWarning(w));
    return () => {
      live = false;
    };
  }, [project.cwd, deps.readiness]);
  const c = hub.theme.colors;
  const find = (id: string | undefined) => (id?.startsWith("s:") ? hub.cloudSessions.find((x) => `s:${x.id}` === id) : undefined);

  if (composing) {
    // The message is typed right here; esc goes back to the list.
    return (
      <InputDialog
        theme={hub.theme}
        title={`Message: ${short(composing.task, 50)}`}
        lines={[
          `Claude Code queues it as the next message of ${composing.id} and comes straight back (claude -p … --cloud).`,
          "The answer shows on claude.ai/code and in the Claude app - or teleport the session here (t).",
          ...(composing.lastError ? [`Last time: ✗ ${shortCloudError(composing.lastError)}`] : []),
        ]}
        placeholder="Also add a test for the empty list"
        onCancel={() => setComposing(null)}
        onSubmit={(text) => {
          const s = composing;
          setComposing(null);
          void hub.messageCloud(s, text);
        }}
      />
    );
  }

  const signedIn = Boolean(hub.claudeAccount?.loggedIn);
  const here = hub.cloudSessions.filter((s) => samePath(s.cwd, project.cwd));
  const elsewhere = hub.cloudSessions.filter((s) => !samePath(s.cwd, project.cwd));
  const item = (s: CloudSession, group: string): ListItem => ({
    id: `s:${s.id}`,
    label: short(s.task, 32),
    hint: sessionDetails(s),
    group,
    badge: hub.cloudSending.has(s.id)
      ? { text: "✦ sending", color: c.accent2 }
      : s.lastError
        ? { text: "✗", color: c.error }
        : { text: "☁", color: c.accent2 },
  });
  const group = "In this terminal";
  const items: ListItem[] = [
    { id: "new", label: "✦ New cloud session…", hint: 'claude --cloud "<task>"', group },
    { id: "all", label: "All my cloud sessions…", hint: "claude --teleport: browse them all, pull one in", group },
    { id: "paste", label: "Add a session by its link…", hint: "to message one started elsewhere", group },
    ...here.map((s) => item(s, `Sessions from ${project.name}`)),
    ...elsewhere.map((s) => item(s, "Other projects")),
  ];
  const current = find(highlighted);
  const subtitle = !signedIn
    ? "sign in to Claude first (ctrl+l)"
    : warning
      ? `▲ ${warning}`
      : "the cloud works on your pushed branch";
  const terminal = (action: () => Promise<unknown>) => void inTerminal(hub, action);
  return (
    <ListDialog
      theme={hub.theme}
      title="Claude cloud"
      subtitle={subtitle}
      items={items}
      filter={false}
      width={100}
      initialId={highlighted}
      notes={[
        { text: LIVE_NOTE, color: c.muted },
        { text: current ? WATCH_NOTE : (NOTES[highlighted ?? "new"] ?? ""), color: c.faint },
      ]}
      hints={
        current
          ? "enter message · t teleport · w watch · o browser · x forget · esc close"
          : "↑↓ move · enter pick · o claude.ai/code in the browser · esc close"
      }
      onHighlight={(picked) => setHighlighted(picked?.id)}
      onCancel={close}
      onKey={(input, _key, picked) => {
        const s = find(picked?.id);
        if (!s) {
          if (input !== "o") return false;
          void open(CLOUD_HOME);
          return true;
        }
        if (input === "m") setComposing(s);
        else if (input === "t") terminal(() => hub.teleport(project, s, ui.runInTerminal));
        else if (input === "w") terminal(() => hub.watchCloud(project, s, ui.runInTerminal));
        else if (input === "o") {
          hub.pickedCloudId = s.id;
          void open(s.url);
        } else if (input === "x") hub.forgetCloud(s.id);
        else return false;
        return true;
      }}
      onSelect={(picked) => {
        if (picked.id === "new") return askTask(hub, ui, project);
        if (picked.id === "all") return terminal(() => hub.browseCloud(project, ui.runInTerminal));
        if (picked.id === "paste") return askLink(hub, ui, project, "");
        const s = find(picked.id);
        if (s) setComposing(s);
      }}
    />
  );
}

/** Runs one of the hub's terminal actions; a thrown error (Claude Code missing) becomes a toast. */
async function inTerminal(hub: Hub, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    hub.toast(err instanceof Error ? err.message : String(err), "error");
  }
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
          "lu-minal steps aside while Claude Code sets the session up in this terminal, then comes back.",
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

/**
 * What the link dialog says. After "New cloud session" it appears when lu-minal couldn't read the
 * new session's link: always on Windows, which has no `script` to record what Claude Code printed.
 */
export function linkPromptLines(task: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!task) {
    return ["Paste a cloud session's link or id (https://claude.ai/code/session_…) - one started on the web, in the Claude app or on another computer."];
  }
  return [
    platform === "win32"
      ? "On Windows lu-minal can't read what Claude Code printed, so it needs the new session's link from you."
      : "lu-minal couldn't find the new session's link in what Claude Code printed.",
    "Copy the link Claude Code showed (https://claude.ai/code/session_…) or just its session_… id and paste it here: then /cloud can message, teleport and watch the session.",
    'Esc skips this - the session runs anyway, and "All my cloud sessions…" finds it later.',
  ];
}

function askLink(hub: Hub, ui: UiServices, project: Project, task: string): void {
  ui.openDialog({
    id: "cloud-link",
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title={task ? "Paste the new session's link" : "Add a cloud session"}
        lines={linkPromptLines(task)}
        placeholder="https://claude.ai/code/session_…"
        onCancel={close}
        onSubmit={(link) => {
          const s = hub.addCloudSession(project, task || "Cloud session", link);
          if (!s) {
            hub.toast("That doesn't look like a cloud session link (https://claude.ai/code/session_…).", "warning");
            return;
          }
          close();
        }}
      />
    ),
  });
}
