// The dialog launchers the commands and keys open: palette, new agent, themes, usage, Roblox,
// help, agents, tasks and the close-tab confirmation.
import fs from "node:fs";
import path from "node:path";
import React from "react";
import type { Agent } from "../../core/agent.js";
import type { Hub } from "../../core/hub.js";
import type { Project } from "../../core/project.js";
import { formatModelRef } from "../../providers/models.js";
import { installPlugin, robloxPluginsDir } from "../../roblox/install.js";
import { bridgeToken } from "../../roblox/token.js";
import { openExternal } from "../../platform/process.js";
import { tildify } from "../../platform/paths.js";
import { resolvePath } from "../../tools/fs.js";
import { COMMANDS, type CommandContext, type DialogLaunchers } from "../commands.js";
import { formatCost, formatTokens, sparkline } from "../format.js";
import type { UiServices } from "../store.js";
import { ConfirmDialog, InputDialog, MessageDialog } from "./InputDialog.js";
import { ListDialog, type ListItem } from "./ListDialog.js";
import { openLoginDialog } from "./login.js";
import { openModelPicker } from "./models.js";
import { openNewTabDialog } from "./newtab.js";
import { UsageDialog } from "./usage.js";
import { openCloudDialog } from "./cloud.js";

const ROBLOX_DOCS = "https://github.com/Luna-OS/lu-minal/blob/main/docs/roblox.md";

const MAX_PICKER_FILES = 3000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "target", "__pycache__", ".venv", "dist-bin"]);

/** The project's files for the attach picker (relative paths, ignored folders skipped). */
export function projectFiles(root: string, max = MAX_PICKER_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) return;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  };
  walk(root, "");
  return out;
}

export function createLaunchers(
  hub: Hub,
  ui: UiServices,
  getCtx: () => CommandContext,
): DialogLaunchers {
  const theme = () => hub.theme;
  const launchers: DialogLaunchers = {
    newTab: () => openNewTabDialog(hub, ui),
    login: (provider) => openLoginDialog(hub, ui, provider === "claude" ? "claude-code" : provider),
    model: (agent: Agent) => {
      const project = hub.projects.find((p) => p.agents.includes(agent));
      if (!project) return;
      openModelPicker(hub, ui, {
        title: `Model for ${agent.name}`,
        current: agent.model,
        onPick: (ref) => void hub.changeModel(project, agent, ref),
      });
    },
    newAgent: () => {
      const project = hub.activeProject;
      if (!project) return hub.toast("Open a project first (ctrl+t).", "warning");
      openModelPicker(hub, ui, {
        title: "New agent: pick its model",
        current: hub.defaultWorkerModel(project, project.lead ?? null),
        onPick: (model) => {
          ui.openDialog({
            id: "new-agent-task",
            render: (close) => (
              <InputDialog
                theme={theme()}
                title={`New agent on ${formatModelRef(model)}`}
                lines={[
                  "What should it work on? Start with a short area label in brackets to name its panel, e.g. \"[voice] add text-to-speech to the player\".",
                  "Leave it empty to start it idle.",
                ]}
                allowEmpty
                placeholder="[label] task"
                onCancel={close}
                onSubmit={async (value) => {
                  close();
                  const m = /^\s*\[([^\]]{1,24})\]\s*([\s\S]*)$/.exec(value);
                  const label = m ? m[1].trim() : undefined;
                  const task = (m ? m[2] : value).trim() || undefined;
                  const agent = await project.addAgent({ name: label ?? "", role: "worker", label, model, task, spawnedBy: "you" });
                  project.focus(agent);
                }}
              />
            ),
          });
        },
      });
    },
    theme: () => {
      const original = hub.theme.name;
      let picked = false;
      const items: ListItem[] = [
        ...hub.themes.list().map((t) => ({
          id: `theme:${t.name}`,
          label: t.label,
          hint: `${t.name} · ${t.dark ? "dark" : "light"}${t.builtin ? "" : " · custom"}`,
          group: t.builtin ? "Themes" : "Your themes",
          badge: t.name === original ? { text: "✓", color: hub.theme.colors.success } : undefined,
        })),
        { id: "ask", label: "✦ Ask an agent to design a new theme…", hint: "it uses create_theme", group: "Make one" },
      ];
      ui.openDialog({
        id: "themes",
        render: (close) => (
          <ListDialog
            theme={theme()}
            title="Themes"
            subtitle="previews while you move"
            items={items}
            initialId={`theme:${original}`}
            onHighlight={(item) => {
              if (item?.id.startsWith("theme:")) hub.themes.set(item.id.slice(6));
            }}
            onCancel={() => {
              if (!picked) hub.themes.set(original);
              close();
            }}
            onSelect={(item) => {
              picked = true;
              if (item.id === "ask") {
                hub.themes.set(original);
                close();
                getCtx().setPrompt("Design a new lu-minal theme for me with create_theme and switch to it: ");
                return;
              }
              hub.themes.set(item.id.slice(6));
              close();
            }}
          />
        ),
      });
    },
    usage: () => {
      ui.openDialog({ id: "usage", render: (close) => <UsageDialog hub={hub} onClose={close} /> });
    },
    cloud: () => openCloudDialog(hub, ui),
    attach: () => {
      const project = hub.activeProject;
      if (!project) return hub.toast("Open a project first (ctrl+t).", "warning");
      const files = projectFiles(project.cwd);
      ui.openDialog({
        id: "attach",
        render: (close) => (
          <ListDialog
            theme={theme()}
            title="Attach a file"
            subtitle={`${files.length}${files.length >= MAX_PICKER_FILES ? "+" : ""} files in ${project.name} · or type a path`}
            items={files.map((f) => ({ id: f, label: f, keywords: path.basename(f) }))}
            placeholder="Filter, or type a path like ~/Desktop/shot.png"
            onCancel={close}
            onSelect={(item) => {
              close();
              getCtx().attach([path.resolve(project.cwd, item.id)]);
            }}
            onKey={(_input, key, item, query) => {
              // Enter on a typed path that isn't in the list attaches it as typed.
              if (key.return && !item && query.trim()) {
                close();
                getCtx().attach([resolvePath(project.cwd, query.trim())]);
                return true;
              }
              return false;
            }}
            empty="No file matches - press enter to attach what you typed as a path."
          />
        ),
      });
    },
    stats: () => {
      ui.openDialog({
        id: "stats",
        render: (close) => <StatsDialog hub={hub} onClose={close} />,
      });
    },
    roblox: () => {
      ui.openDialog({
        id: "roblox",
        render: (close) => {
          const s = hub.roblox.status();
          const c = theme().colors;
          const dir = robloxPluginsDir();
          const items: ListItem[] = [
            { id: "install", label: "Install the Studio plugin", hint: dir ? tildify(dir) : "no Roblox plugins folder found - set LU_MINAL_ROBLOX_PLUGINS" },
            { id: "docs", label: "How it works", hint: "docs/roblox.md" },
            { id: "restart", label: "Restart the bridge", hint: `127.0.0.1:${s.port}` },
          ];
          const status = s.connected
            ? `connected · ${s.place?.name ?? "a place"}${s.studioVersion ? ` · Studio ${s.studioVersion}` : ""}${s.pluginOutdated ? " · ▲ plugin outdated, install again" : ""}`
            : s.needsReinstall
              ? "▲ a Studio plugin without this lu-minal's token tried to connect - install the plugin again"
              : s.listening
                ? `waiting for Studio on port ${s.port} - open Studio and click Connect on the lu-minal toolbar`
                : `not listening${s.error ? `: ${s.error}` : ""}`;
          return (
            <ListDialog
              theme={theme()}
              title="Roblox Studio"
              subtitle={status}
              filter={false}
              items={items.map((i) => (i.id === "install" && s.connected ? { ...i, badge: { text: "✓ connected", color: c.success } } : i))}
              onCancel={close}
              onSelect={async (item) => {
                if (item.id === "install") {
                  try {
                    // The token the running bridge accepts (the file may have changed since it started).
                    const file = await installPlugin({ port: s.port, token: hub.robloxToken ?? bridgeToken() });
                    hub.toast(`Plugin installed: ${tildify(file)} - restart Studio or reload plugins.`, "success");
                  } catch (err) {
                    hub.toast(err instanceof Error ? err.message : String(err), "error");
                  }
                } else if (item.id === "docs") {
                  void openExternal(ROBLOX_DOCS);
                } else if (item.id === "restart") {
                  await hub.roblox.stop();
                  await hub.roblox.start();
                  hub.toast(hub.roblox.status().listening ? "Bridge restarted." : `Bridge: ${hub.roblox.status().error ?? "not listening"}`, "info");
                }
              }}
            />
          );
        },
      });
    },
    help: () => {
      const keys: Array<[string, string]> = [
        ["enter", "send to the focused agent  (end a line with \\ for a new line)"],
        ["@name text", "message a teammate directly, @* for everyone"],
        ["tab, ctrl+↑ ↓", "focus the next / previous agent"],
        ["shift+tab", "cycle the permission mode: edits on → ask → do everything → plan"],
        ["/ in the prompt", "slash commands (tab completes)"],
        ["ctrl+t / ctrl+w", "new tab / close tab (empty prompt)"],
        ["alt+1..9, alt+← →", "switch tabs (also ctrl+pageup / pagedown)"],
        ["ctrl+n", "add an agent (any provider)"],
        ["ctrl+o", "switch the focused agent's model"],
        ["ctrl+l", "sign in (Claude, OpenRouter, keys, GitHub, Forgejo)"],
        ["ctrl+k", "command palette"],
        ["ctrl+f", "zoom the focused agent"],
        ["pgup / pgdn", "scroll the focused log"],
        ["y / a / n", "allow / always allow / deny a request"],
        ["esc", "interrupt the focused agent"],
        ["ctrl+c twice, ctrl+q", "quit"],
      ];
      const items: ListItem[] = [
        ...keys.map(([k, d], i) => ({ id: `k${i}`, label: k.padEnd(22), hint: d, group: "Keys" })),
        ...COMMANDS.map((cmd) => ({
          id: `c:${cmd.name}`,
          label: `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`,
          hint: cmd.description,
          group: "Commands",
        })),
      ];
      ui.openDialog({
        id: "help",
        render: (close) => (
          <ListDialog
            theme={theme()}
            title="lu-minal"
            subtitle="keys and commands"
            items={items}
            width={100}
            onCancel={close}
            onSelect={(item) => {
              if (!item.id.startsWith("c:")) return;
              close();
              getCtx().setPrompt(`/${item.id.slice(2)} `);
            }}
          />
        ),
      });
    },
    agents: () => {
      const project = hub.activeProject;
      if (!project) return;
      ui.openDialog({
        id: "agents",
        render: (close) => (
          <ListDialog
            theme={theme()}
            title={`Agents in ${project.name}`}
            subtitle="enter focus · m model · x remove"
            items={project.agents.map((a) => ({
              id: a.id,
              label: `${a.name}${a.label ? ` (${a.label})` : ""}`,
              hint: `${a.role} · ${a.modelLabel} · ${a.status}${a.activity ? ` · ${a.activity}` : ""}`,
              badge: a.busy ? { text: "●", color: theme().colors.success } : undefined,
            }))}
            onCancel={close}
            onKey={(input, _key, item) => {
              const agent = item && project.agents.find((a) => a.id === item.id);
              if (!agent) return false;
              if (input === "m") {
                close();
                launchers.model(agent);
                return true;
              }
              if (input === "x" && agent.role !== "lead") {
                void project.removeAgent(agent);
                return true;
              }
              return false;
            }}
            onSelect={(item) => {
              project.focus(project.agents.find((a) => a.id === item.id));
              close();
            }}
          />
        ),
      });
    },
    tasks: () => {
      const project = hub.activeProject;
      if (!project) return;
      ui.openDialog({
        id: "tasks",
        render: (close) => (
          <ListDialog
            theme={theme()}
            title={`Task board · ${project.name}`}
            subtitle="agents keep it with task_add / task_update"
            items={project.tasks.map((t) => ({
              id: t.id,
              label: `#${t.id} ${t.title}`,
              hint: `${t.status}${t.owner ? ` · ${t.owner}` : ""}${t.note ? ` · ${t.note}` : ""}`,
              group: t.status === "done" ? "Done" : t.status === "doing" ? "Doing" : t.status === "blocked" ? "Blocked" : "To do",
            }))}
            empty="No tasks yet - the lead puts them here when it plans."
            onCancel={close}
            onSelect={() => undefined}
          />
        ),
      });
    },
    palette: () => {
      ui.openDialog({
        id: "palette",
        render: (close) => (
          <ListDialog
            theme={theme()}
            title="Commands"
            items={COMMANDS.filter((c) => c.name !== "palette").map((cmd) => ({
              id: cmd.name,
              label: `/${cmd.name}`,
              hint: cmd.description,
              keywords: (cmd.aliases ?? []).join(" "),
              badge: cmd.keys ? { text: cmd.keys, color: theme().colors.faint } : undefined,
            }))}
            onCancel={close}
            onSelect={(item) => {
              close();
              const cmd = COMMANDS.find((c) => c.name === item.id);
              if (!cmd) return;
              if (cmd.args && cmd.args.startsWith("<")) {
                getCtx().setPrompt(`/${cmd.name} `);
                return;
              }
              void Promise.resolve(cmd.run(getCtx(), "")).catch((err) => hub.toast(String(err), "error"));
            }}
          />
        ),
      });
    },
    closeTab: (project: Project) => {
      const busy = project.agents.some((a) => a.busy);
      if (!busy) return void hub.closeProject(project);
      ui.openDialog({
        id: "close-tab",
        render: (close) => (
          <ConfirmDialog
            theme={theme()}
            title={`Close ${project.name}?`}
            lines={["Agents are still working in this tab. Closing stops them."]}
            yes="close"
            no="keep"
            onYes={() => {
              close();
              void hub.closeProject(project);
            }}
            onNo={close}
          />
        ),
      });
    },
  };
  return launchers;
}

function StatsDialog({ hub, onClose }: { hub: Hub; onClose: () => void }) {
  const [confirmReset, setConfirmReset] = React.useState(false);
  const c = hub.theme.colors;
  const s = hub.stats.summary();
  // A table: label, total, read, written, cost, turns.
  const cut = (t: string, w: number) => (t.length > w ? `${t.slice(0, w - 1)}…` : t);
  const W = 26;
  const cols = (label: string, a: string, b: string, d: string, e: string, f: string) =>
    `${cut(label, W).padEnd(W)}${a.padStart(9)}${b.padStart(9)}${d.padStart(9)}${e.padStart(10)}${f.padStart(7)}`;
  const row = (label: string, u: { input: number; output: number; costUsd: number; turns: number }) =>
    cols(label, formatTokens(u.input + u.output), formatTokens(u.input), formatTokens(u.output), formatCost(u.costUsd), String(u.turns));
  const header = { text: cols("", "total", "read", "written", "cost", "turns"), color: c.faint };
  const section = <T extends { input: number; output: number; costUsd: number; turns: number }>(
    title: string,
    list: T[],
    label: (x: T) => string,
    limit: number,
  ): Array<string | { text: string; color?: string }> => [
    "",
    { text: title, color: c.accent },
    ...(list.length ? list.slice(0, limit).map((x) => row(label(x), x)) : [{ text: "–", color: c.faint }]),
    ...(list.length > limit ? [{ text: `… and ${list.length - limit} more`, color: c.faint }] : []),
  ];
  const lines: Array<string | { text: string; color?: string }> = [
    { text: "Tokens", color: c.accent },
    header,
    row("Today", s.today),
    row("Last 7 days", s.week),
    row("Last 30 days", s.month),
    { text: row("All time", s.allTime), color: c.text },
    { text: s.since ? `counting since ${s.since}` : "nothing counted yet", color: c.faint },
    "",
    { text: "Last 14 days", color: c.accent },
    { text: `${sparkline(s.daily.map((d) => d.input + d.output))}   ${s.daily[0]?.day ?? ""} → today`, color: c.accent2 },
    ...section("By model", s.models, (m) => m.model, 8),
    ...section("By provider", s.providers, (p) => p.provider, 8),
    ...section("By project", s.projects, (p) => p.name, 6),
    "",
    {
      text: `Agents started: ${Object.entries(s.agents).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`,
      color: c.muted,
    },
    { text: `Lines written by agents: +${s.lines.added.toLocaleString("en-US")} -${s.lines.removed.toLocaleString("en-US")}`, color: c.muted },
  ];
  if (confirmReset) {
    lines.push("", { text: "Reset all statistics? y = yes, any other key = no", color: c.warning });
  }
  return (
    <MessageDialog
      theme={hub.theme}
      title="Statistics"
      lines={lines}
      hints="x reset · enter / esc close"
      onKey={(input) => {
        if (confirmReset) {
          setConfirmReset(false);
          if (input === "y") {
            hub.stats.reset();
            hub.toast("Statistics reset.", "info");
          }
          return true;
        }
        if (input === "x") {
          setConfirmReset(true);
          return true;
        }
        return false;
      }}
      onClose={onClose}
    />
  );
}
