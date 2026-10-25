// The root component: lays out the sky, the tab bar, the agents' panels and the dialogs, and routes
// every key. State lives in the Hub; what lives here is purely about the screen (prompts, scroll,
// open dialogs).
import { Box, Text, useAnimation, useApp, useInput, usePaste, useWindowSize, type Key } from "ink";
import React, { useCallback, useMemo, useRef, useState } from "react";
import type { Agent } from "../core/agent.js";
import {
  attachmentFromPath,
  attachmentsDir,
  clipboardHint,
  clipboardImage,
  describeAttachment,
  droppedFiles,
  type Attachment,
} from "../core/attachments.js";
import type { Hub, TerminalRunner } from "../core/hub.js";
import type { Project } from "../core/project.js";
import { nextPermissionMode, PERMISSION_HINTS } from "../core/permissions.js";
import { spawnProgram } from "../platform/process.js";
import { commandSuggestions, findCommand, runCommandLine, type CommandContext } from "./commands.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { Axo } from "./components/Axo.js";
import { Footer, Header, TabBar, Toasts } from "./components/Chrome.js";
import { MoonGauge } from "./components/MoonGauge.js";
import { Sky } from "./components/Sky.js";
import { createLaunchers } from "./dialogs/index.js";
import { editKey, emptyEditor, insertText, type EditorState } from "./editor.js";
import { computeLayout, type Layout } from "./layout.js";
import type { Row } from "./log-lines.js";
import { HubContext, UiContext, useHub, type DialogSpec, type UiServices } from "./store.js";
import { truncate } from "./text.js";
import type { AxoMood } from "./axo/frames.js";

export interface AppProps {
  hub: Hub;
  onExit: () => void;
}

export function App(props: AppProps) {
  return (
    <HubContext value={props.hub}>
      <Screen onExit={props.onExit} />
    </HubContext>
  );
}

function Screen({ onExit }: { onExit: () => void }) {
  const hub = useHub();
  const { columns, rows } = useWindowSize();
  const { exit, suspendTerminal } = useApp();
  const theme = hub.theme;
  const c = theme.colors;

  const [dialogs, setDialogs] = useState<DialogSpec[]>([]);
  const [editors, setEditors] = useState<Record<string, EditorState>>({});
  const [scrolls, setScrolls] = useState<Record<string, number>>({});
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const history = useRef<Record<string, { items: string[]; index: number }>>({});
  const lastCtrlC = useRef(0);
  const lastBusy = useRef<{ busy: boolean; doneAt: number }>({ busy: false, doneAt: 0 });

  const project = hub.activeProject;
  const focused = project?.focused;
  const anyBusy = hub.projects.some((p) => p.agents.some((a) => a.busy));
  const { frame } = useAnimation({ interval: 140, isActive: anyBusy });
  const now = Date.now();

  // ---- UI services ---------------------------------------------------------------------------

  const quit = useCallback(() => {
    void hub.dispose().finally(() => {
      exit();
      onExit();
    });
  }, [hub, exit, onExit]);

  const runInTerminal: TerminalRunner = useCallback(
    async (exe, args, opts) => {
      let code: number | null = null;
      // Ctrl+C in the child's terminal reaches lu-minal too (the whole foreground group on POSIX,
      // every process on the console on Windows): ignore it here, the child handles it.
      const ignoreSigint = () => undefined;
      process.on("SIGINT", ignoreSigint);
      try {
        await suspendTerminal(
          () =>
            new Promise<void>((resolve) => {
              let child: ReturnType<typeof spawnProgram>;
              try {
                child = spawnProgram(exe, args, { stdio: "inherit", cwd: opts?.cwd ?? process.cwd(), env: opts?.env ?? process.env });
              } catch {
                // spawnProgram refuses a batch file whose arguments cmd.exe would cut (a line break).
                resolve();
                return;
              }
              child.on("error", () => resolve());
              child.on("exit", (exitCode) => {
                code = exitCode;
                resolve();
              });
            }),
        );
      } finally {
        process.off("SIGINT", ignoreSigint);
      }
      return code;
    },
    [suspendTerminal],
  );

  const ui: UiServices = useMemo(
    () => ({
      runInTerminal,
      openDialog: (d) => setDialogs((list) => [...list.filter((x) => x.id !== d.id), d]),
      closeDialog: () => setDialogs((list) => list.slice(0, -1)),
      quit,
    }),
    [runInTerminal, quit],
  );

  const editorOf = (agent: Agent | undefined): EditorState => (agent ? (editors[agent.id] ?? emptyEditor()) : emptyEditor());
  const setEditor = (agent: Agent, state: EditorState) => setEditors((e) => ({ ...e, [agent.id]: state }));
  const setPrompt = (text: string) => {
    if (focused) setEditor(focused, { value: text, cursor: text.length });
  };

  // ---- attachments -----------------------------------------------------------------------------

  const attachOf = (agent: Agent | undefined): Attachment[] => (agent ? (attachments[agent.id] ?? []) : []);
  const addAttachments = (agent: Agent, list: Attachment[]) => {
    if (!list.length) return;
    setAttachments((a) => ({ ...a, [agent.id]: [...(a[agent.id] ?? []), ...list].slice(-10) }));
  };
  /** Attaches files by path; says why when one can't be attached. */
  const attachPaths = (paths: string[]) => {
    if (!focused) return;
    const ok: Attachment[] = [];
    for (const p of paths) {
      const a = attachmentFromPath(p);
      if (typeof a === "string") hub.toast(a, "warning");
      else ok.push(a);
    }
    addAttachments(focused, ok);
  };
  const pasteImage = async (agent: Agent) => {
    const image = await clipboardImage(attachmentsDir(hub.stateDir)).catch(() => null);
    if (image) addAttachments(agent, [image]);
    else hub.toast(clipboardHint(), "info");
  };

  const ctxRef = useRef<CommandContext | null>(null);
  const launchers = useMemo(() => createLaunchers(hub, ui, () => ctxRef.current!), [hub, ui]);
  const toggleZoom = () => {
    if (!project) return;
    project.zoomed = !project.zoomed;
    project.changed();
  };
  const ctx: CommandContext = {
    hub,
    ui,
    project,
    agent: focused,
    setPrompt,
    toggleZoom,
    attach: attachPaths,
    dialogs: launchers,
  };
  ctxRef.current = ctx;

  // ---- submitting ------------------------------------------------------------------------------

  const submit = (agent: Agent, text: string) => {
    const value = text.trim();
    const files = attachOf(agent);
    if ((!value && !files.length) || !project) return;
    const h = (history.current[project.id] ??= { items: [], index: -1 });
    h.items = [value, ...h.items.filter((x) => x !== value)].slice(0, 100);
    h.index = -1;
    setEditor(agent, emptyEditor());
    setScrolls((s) => ({ ...s, [agent.id]: 0 }));
    if (value.startsWith("/")) {
      // Commands don't take attachments; they stay for the next message.
      const typed = /^\/(\S*)/.exec(value)?.[1] ?? "";
      const matches = commandSuggestions(typed);
      if (!findCommand(typed) && matches.length === 1) {
        void runCommandLine(ctx, `/${matches[0].name}${value.slice(typed.length + 1)}`);
      } else {
        void runCommandLine(ctx, value);
      }
      return;
    }
    setAttachments((a) => ({ ...a, [agent.id]: [] }));
    const at = /^@(\S+)\s+([\s\S]+)$/.exec(value);
    if (at) {
      const got = project.send("you", at[1], at[2], files);
      if (!got.length) hub.toast(`Nobody called "${at[1]}" here.`, "warning");
      return;
    }
    agent.deliver({ from: "you", text: value, attachments: files.length ? files : undefined });
  };

  // ---- keys ------------------------------------------------------------------------------------

  const slashMenu = (agent: Agent | undefined) => {
    const v = editorOf(agent).value;
    if (!v.startsWith("/") || /\s/.test(v)) return [];
    return commandSuggestions(v.slice(1)).slice(0, 6);
  };

  const scrollBy = (agent: Agent, delta: number) =>
    setScrolls((s) => ({ ...s, [agent.id]: Math.max(0, (s[agent.id] ?? 0) + delta) }));

  const handleKey = (input: string, key: Key) => {
    if (key.ctrl && input === "q") return quit();
    if (key.ctrl && input === "c") {
      if (focused?.busy) {
        focused.interrupt();
        return;
      }
      if (now - lastCtrlC.current < 1500) return quit();
      lastCtrlC.current = now;
      hub.toast("Press ctrl+c again to quit.", "info");
      return;
    }
    if (key.ctrl && input === "t") return launchers.newTab();
    if (key.ctrl && input === "k") return launchers.palette();
    if (key.ctrl && input === "l") return launchers.login();
    if (key.ctrl && input === "n") return launchers.newAgent();
    if (key.ctrl && input === "o" && focused) return launchers.model(focused);
    if (key.ctrl && input === "f") return toggleZoom();
    if (key.meta && /^[1-9]$/.test(input)) return hub.switchTo(Number(input) - 1);
    if ((key.meta && key.leftArrow) || (key.ctrl && key.pageUp)) return hub.cycleTab(-1);
    if ((key.meta && key.rightArrow) || (key.ctrl && key.pageDown)) return hub.cycleTab(1);
    if (!project) {
      if (input === "?") return launchers.help();
      return;
    }
    const agent = focused;
    const editor = editorOf(agent);
    if (key.ctrl && input === "w" && !editor.value) return launchers.closeTab(project);
    if (key.tab && key.shift) {
      const mode = nextPermissionMode(project.permissionMode);
      project.setPermissionMode(mode);
      hub.toast(`${mode}: ${PERMISSION_HINTS[mode]}`, mode === "yolo" ? "warning" : "info");
      return;
    }
    if (key.tab) {
      const menu = slashMenu(agent);
      if (menu.length && agent) {
        const text = `/${menu[0].name} `;
        setEditor(agent, { value: text, cursor: text.length });
        return;
      }
      project.cycleFocus(1);
      return;
    }
    if (key.ctrl && key.downArrow) return project.cycleFocus(1);
    if (key.ctrl && key.upArrow) return project.cycleFocus(-1);
    if (!agent) return;
    if (key.escape) {
      if (editor.value) return setEditor(agent, emptyEditor());
      if (project.zoomed) return toggleZoom();
      if (agent.busy) agent.interrupt();
      return;
    }
    if ((key.ctrl || key.meta) && input === "v") {
      // Ctrl+V (Alt+V where the terminal keeps Ctrl+V for pasting text, as Windows Terminal does).
      void pasteImage(agent);
      return;
    }
    if (key.backspace && !editor.value && attachOf(agent).length) {
      setAttachments((a) => ({ ...a, [agent.id]: (a[agent.id] ?? []).slice(0, -1) }));
      return;
    }
    if (agent.pendingApproval && !editor.value) {
      if (input === "y" || input === "Y") return agent.answerApproval("allow");
      if (input === "a" || input === "A") return agent.answerApproval("always");
      if (input === "n" || input === "N") return agent.answerApproval("deny");
    }
    if (key.pageUp) return scrollBy(agent, 10);
    if (key.pageDown) return scrollBy(agent, -10);
    if (key.shift && key.upArrow) return scrollBy(agent, 1);
    if (key.shift && key.downArrow) return scrollBy(agent, -1);
    if ((key.upArrow || key.downArrow) && !editor.value.includes("\n")) {
      const h = (history.current[project.id] ??= { items: [], index: -1 });
      if (!h.items.length) return;
      h.index = key.upArrow ? Math.min(h.items.length - 1, h.index + 1) : Math.max(-1, h.index - 1);
      const text = h.index < 0 ? "" : h.items[h.index];
      setEditor(agent, { value: text, cursor: text.length });
      return;
    }
    if (input === "?" && !editor.value) return launchers.help();
    const r = editKey(editor, input, key);
    if (r.kind === "submit") return submit(agent, editor.value);
    if (r.kind === "edit") setEditor(agent, r.state);
  };

  const dialogOpen = dialogs.length > 0;
  useInput(handleKey, { isActive: !dialogOpen });
  usePaste(
    (text) => {
      if (!focused) return;
      // Files dropped on the terminal arrive as a paste of their paths.
      const files = droppedFiles(text);
      if (files) attachPaths(files);
      else setEditor(focused, insertText(editorOf(focused), text));
    },
    { isActive: !dialogOpen },
  );

  // ---- layout ----------------------------------------------------------------------------------

  const showAxo = theme.axo && hub.config.axo;
  const layout: Layout = computeLayout({
    width: columns,
    height: rows,
    agents: project?.agents ?? [],
    focusedId: focused?.id ?? null,
    zoomed: project?.zoomed ?? false,
    axo: showAxo,
  });
  const glass = layout.panels.map((p) => ({ ...p.rect, focused: p.agentId === focused?.id }));

  // Axo's mood follows the team.
  const leadBusy = Boolean(project?.agents.some((a) => a.busy));
  if (lastBusy.current.busy && !leadBusy) lastBusy.current.doneAt = now;
  lastBusy.current.busy = leadBusy;
  const mood: AxoMood = leadBusy ? "work" : now - lastBusy.current.doneAt < 2500 ? "done" : hub.ready ? "idle" : "sleep";
  const leadAgent = project?.lead;

  const chipRows = (agent: Agent | undefined): Row[] => {
    const list = attachOf(agent);
    if (!list.length) return [];
    return [
      {
        key: "attachments",
        segs: [
          { text: "  ▣ ", color: c.accent2 },
          { text: list.map(describeAttachment).join("   "), color: c.text },
          { text: "   backspace removes", color: c.faint },
        ],
      },
    ];
  };

  const menuRows = (agent: Agent | undefined): Row[] =>
    slashMenu(agent).map((cmd, i) => ({
      key: `menu-${cmd.name}`,
      segs: [
        { text: i === 0 ? "  ⏵ " : "    ", color: c.accent },
        { text: `/${cmd.name}`, color: i === 0 ? c.accent : c.text, bold: i === 0 },
        { text: cmd.args ? ` ${cmd.args}` : "", color: c.faint },
        { text: `  ${cmd.description}`, color: c.muted },
      ],
    }));

  const top = dialogs[dialogs.length - 1];

  return (
    <UiContext value={ui}>
      <Box width={columns} height={rows}>
        <Sky width={columns} height={rows} theme={theme} glass={glass} fps={hub.config.sky.fps} animate={hub.config.sky.enabled && hub.config.sky.fps > 0} enabled={hub.config.sky.enabled} moonAt={project ? null : undefined} />
        <TabBar hub={hub} rect={layout.tabBar} frame={frame} />
        {project ? <Header hub={hub} project={project} rect={layout.header} now={now} /> : null}
        {project ? (
          layout.panels.map((slot) => {
            const agent = project.agents.find((a) => a.id === slot.agentId);
            if (!agent) return null;
            const isFocused = agent.id === focused?.id;
            const reserve = layout.axo && agent === leadAgent && !project.zoomed ? layout.axo.width + 1 : 0;
            return (
              <AgentPanel
                key={agent.id}
                agent={agent}
                project={project}
                rect={slot.rect}
                focused={isFocused}
                zoomed={project.zoomed}
                theme={theme}
                frame={frame}
                now={now}
                editor={isFocused ? editorOf(agent) : null}
                scroll={scrolls[agent.id] ?? 0}
                reserveRight={reserve}
                menu={isFocused ? [...chipRows(agent), ...menuRows(agent)] : undefined}
              />
            );
          })
        ) : (
          <Welcome hub={hub} layout={layout} />
        )}
        {project && !project.zoomed
          ? layout.connectors.map((line, i) => (
              <Box key={`conn${i}`} position="absolute" left={line.x} top={line.y1} width={1} height={line.y2 - line.y1 + 1}>
                <Text color={c.border} backgroundColor={c.bg}>
                  {`${"│\n".repeat(Math.max(0, line.y2 - line.y1))}◆`}
                </Text>
              </Box>
            ))
          : null}
        {project && layout.axo && leadAgent && !project.zoomed ? (
          <Box position="absolute" left={layout.axo.x} top={layout.axo.y} width={layout.axo.width} height={layout.axo.height} flexDirection="column" alignItems="center">
            <Axo
              mood={mood}
              bg={leadAgent.id === focused?.id ? c.surfaceFocus : c.surface}
              caption={leadBusy ? `${(project.agents.find((a) => a.status === "working")?.activity ?? "Working")}…` : mood === "done" ? "Done!" : "Ready when you are."}
              captionColor={leadBusy ? c.accent2 : c.muted}
              animate={hub.config.sky.enabled}
            />
            {layout.axo.height >= 13 ? (
              <MoonGauge label="session" window={hub.planUsage?.session ?? null} theme={theme} width={layout.axo.width - 2} bg={leadAgent.id === focused?.id ? c.surfaceFocus : c.surface} />
            ) : null}
            {layout.axo.height >= 14 ? (
              <MoonGauge label="week" window={hub.planUsage?.week ?? null} theme={theme} width={layout.axo.width - 2} bg={leadAgent.id === focused?.id ? c.surfaceFocus : c.surface} />
            ) : null}
          </Box>
        ) : null}
        <Footer hub={hub} project={project} rect={layout.footer} />
        {layout.hiddenWorkers > 0 && project && !project.zoomed ? (
          <Box position="absolute" left={Math.max(0, layout.content.x + layout.content.width - 34)} top={Math.max(0, layout.footer.y - 1)} width={34} height={1}>
            <Text color={c.warning} backgroundColor={c.bg} wrap="truncate">
              {` +${layout.hiddenWorkers} more · page ${layout.page + 1}/${layout.pages} · tab `}
            </Text>
          </Box>
        ) : null}
        <Toasts toasts={hub.toasts} theme={theme} width={columns} />
        {top ? <React.Fragment key={top.id}>{top.render(ui.closeDialog)}</React.Fragment> : null}
      </Box>
    </UiContext>
  );
}

function Welcome({ hub, layout }: { hub: Hub; layout: Layout }) {
  const c = hub.theme.colors;
  const acc = hub.claudeAccount;
  const free = hub.registry.freeModels({ connectedOnly: true }).length;
  const lines: Array<{ text: string; color: string; bold?: boolean }> = [
    { text: "lu-minal", color: c.accent, bold: true },
    { text: "a team of coding agents under the night sky", color: c.muted },
    { text: "", color: c.muted },
    { text: "ctrl+t   open a project (folder, GitHub, Forgejo)", color: c.text },
    { text: "ctrl+l   sign in - Claude with your subscription, OpenRouter, keys", color: c.text },
    { text: "ctrl+k   all commands        ?   help", color: c.text },
    { text: "", color: c.muted },
    {
      text: acc?.loggedIn
        ? `✓ Claude: ${acc.email ?? "signed in"}${acc.plan ? ` (${acc.plan})` : ""}`
        : acc?.installed
          ? "○ Claude Code is installed - ctrl+l to sign in"
          : "○ Claude Code not found - ctrl+l installs it",
      color: acc?.loggedIn ? c.success : c.faint,
    },
    { text: `✓ ${free} free models ready (OpenCode Zen - no key needed)`, color: free ? c.success : c.faint },
  ];
  const w = Math.min(70, layout.content.width);
  const left = layout.content.x + Math.max(0, Math.floor((layout.content.width - w) / 2));
  const showAxo = hub.theme.axo && layout.content.height >= lines.length + 13;
  const top = layout.content.y + Math.max(0, Math.floor((layout.content.height - lines.length - (showAxo ? 12 : 0)) / 2));
  return (
    <Box position="absolute" left={left} top={top} width={w} flexDirection="column" alignItems="center">
      {showAxo ? <Axo mood={hub.ready ? "idle" : "sleep"} bg={c.bg} caption={hub.ready ? "Ready when you are." : "Waking up…"} captionColor={c.muted} animate={hub.config.sky.enabled} /> : null}
      {showAxo ? <Box height={1} /> : null}
      {lines.map((l, i) =>
        l.text ? (
          <Text key={i} color={l.color} bold={l.bold} backgroundColor={c.bg} wrap="truncate">
            {truncate(l.text, w)}
          </Text>
        ) : (
          // An empty row that leaves the sky visible.
          <Box key={i} height={1} />
        ),
      )}
    </Box>
  );
}
