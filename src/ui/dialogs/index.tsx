// The dialog launchers the commands and keys open: palette, new agent, themes, usage, Roblox,
// help, agents, tasks and the close-tab confirmation.
import React from "react";
import type { Agent } from "../../core/agent.js";
import type { Hub } from "../../core/hub.js";
import type { Project } from "../../core/project.js";
import { formatModelRef } from "../../providers/models.js";
import { installPlugin, robloxPluginsDir } from "../../roblox/install.js";
import { openExternal } from "../../platform/process.js";
import { tildify } from "../../platform/paths.js";
import { COMMANDS, type CommandContext, type DialogLaunchers } from "../commands.js";
import { formatCost, formatElapsed, formatTokens } from "../format.js";
import type { UiServices } from "../store.js";
import { formatResetIn } from "../components/MoonGauge.js";
import { ConfirmDialog, InputDialog, MessageDialog } from "./InputDialog.js";
import { ListDialog, type ListItem } from "./ListDialog.js";
import { openLoginDialog } from "./login.js";
import { openModelPicker } from "./models.js";
import { openNewTabDialog } from "./newtab.js";

const ROBLOX_DOCS = "https://github.com/Luna-OS/lu-minal/blob/main/docs/roblox.md";

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
      ui.openDialog({
        id: "usage",
        render: (close) => {
          const c = theme().colors;
          const u = hub.planUsage;
          const acc = hub.claudeAccount;
          const pct = (x: number) => `${Math.round(x * 100)}%`;
          const win = (label: string, w: { utilization: number; resetsAt: number | null } | null) =>
            w ? `${label}: ${pct(w.utilization)} used${w.resetsAt ? ` · resets in ${formatResetIn(w.resetsAt - Date.now())}` : ""}` : `${label}: –`;
          const lines: Array<string | { text: string; color?: string }> = [];
          lines.push({ text: "Claude plan", color: c.accent });
          if (!acc?.installed) lines.push("Claude Code is not installed - /login claude");
          else if (!acc.loggedIn) lines.push("Not signed in - /login claude");
          else {
            lines.push(`${acc.email ?? "signed in"}${acc.plan ? ` · ${acc.plan}` : ""}${acc.version ? ` · Claude Code ${acc.version}` : ""}`);
            lines.push(win("Session (5 hours)", u?.session ?? null));
            lines.push(win("Week", u?.week ?? null));
            for (const m of u?.models ?? []) lines.push(win(`Week · ${m.name}`, m));
            if (u?.extra?.enabled) {
              lines.push(`Extra usage: ${u.extra.used !== null ? (u.extra.used / 100).toFixed(2) : "?"} of ${u.extra.limit !== null ? (u.extra.limit / 100).toFixed(2) : "?"} ${u.extra.currency ?? ""}`);
            }
            if (u) lines.push({ text: `read ${formatElapsed(Date.now() - u.at)} ago`, color: c.faint });
            if (hub.usageError) lines.push({ text: hub.usageError, color: c.error });
          }
          const or = hub.balances.get("openrouter");
          if (or) {
            lines.push("", { text: "OpenRouter", color: c.accent });
            lines.push(`$${(or.used ?? 0).toFixed(2)} used${or.limit !== null ? ` of $${or.limit.toFixed(2)}` : ""}`);
          }
          const p = hub.activeProject;
          if (p) {
            lines.push("", { text: `This tab: ${p.name}`, color: c.accent });
            for (const a of p.agents) {
              lines.push(`${a.name.padEnd(10)} ${a.modelLabel.padEnd(34)} ↓ ${formatTokens(a.tokensIn + a.tokensOut).padStart(7)}  ${formatCost(a.costUsd)}`);
            }
          }
          return (
            <MessageDialog
              theme={theme()}
              title="Usage"
              lines={lines}
              hints="r refresh · enter / esc close"
              onKey={(input) => {
                if (input === "r") {
                  void hub.refreshUsage();
                  void hub.refreshBalances();
                  return true;
                }
                return false;
              }}
              onClose={close}
            />
          );
        },
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
            ? `connected · ${s.place?.name ?? "a place"}${s.studioVersion ? ` · Studio ${s.studioVersion}` : ""}`
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
                    const file = await installPlugin({ port: s.port });
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
