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
  readClipboard,
  describeAttachment,
  droppedFiles,
  type Attachment,
} from "../core/attachments.js";
import type { Hub, TerminalRunner } from "../core/hub.js";
import { newestModels } from "../core/news.js";
import { nextPermissionMode, PERMISSION_HINTS } from "../core/permissions.js";
import { spawnProgram } from "../platform/process.js";
import { commandSuggestions, findCommand, runCommandLine, type CommandContext } from "./commands.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { Axo } from "./components/Axo.js";
import { Footer, Header, TabBar, Toasts } from "./components/Chrome.js";
import { Home, openRecent, recentFolders } from "./components/Home.js";
import { MoonGauge } from "./components/MoonGauge.js";
import { Sky } from "./components/Sky.js";
import { createLaunchers } from "./dialogs/index.js";
import { editKey, emptyEditor, insertText, type EditorState } from "./editor.js";
import { computeLayout, type Layout } from "./layout.js";
import type { Row } from "./log-lines.js";
import { addPaste, deleteChipBefore, expandPastes, isLongPaste, keepReferenced, noPastes, type Pastes } from "./paste.js";
import { HubContext, UiContext, useHub, type DialogSpec, type UiServices } from "./store.js";
import type { AxoMood } from "./axo/frames.js";

/** A sent prompt, with the texts behind its paste chips so that recalling it brings the chips back. */
interface HistoryEntry {
  text: string;
  pastes: Pastes;
}

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
  const [pastes, setPastes] = useState<Record<string, Pastes>>({});
  const history = useRef<Record<string, { items: HistoryEntry[]; index: number }>>({});
  const lastCtrlC = useRef(0);
  const lastBusy = useRef<{ busy: boolean; doneAt: number }>({ busy: false, doneAt: 0 });

  const project = hub.activeProject;
  const focused = project?.focused;
  // The home screen covers the tabs (and stands in for none); the prompt can't be typed into there.
  const home = hub.homeShown;
  const [homePick, setHomePick] = useState(0);
  const recent = useMemo(() => (home ? recentFolders(hub) : []), [home, hub, hub.config.recent, hub.projects.length]);
  const pick = Math.min(homePick, Math.max(0, recent.length - 1));
  const anyBusy = hub.projects.some((p) => p.agents.some((a) => a.busy));
  const { frame } = useAnimation({ interval: 140, isActive: anyBusy });
  // A slow tick while idle, so the header clock moves on and "Done!" turns back into "Ready".
  useAnimation({ interval: 1000, isActive: !anyBusy && Boolean(project) });
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
  const pastesOf = (agent: Agent | undefined): Pastes => (agent ? (pastes[agent.id] ?? noPastes()) : noPastes());
  /** Sets the prompt; `kept` replaces its pasted texts (a new paste, a recalled message). */
  const setEditor = (agent: Agent, state: EditorState, kept?: Pastes) => {
    setEditors((e) => ({ ...e, [agent.id]: state }));
    // A pasted text lives as long as its chip: deleting the chip or clearing the prompt forgets it.
    setPastes((p) => {
      const base = kept ?? p[agent.id];
      if (!base) return p;
      const next = keepReferenced(base, state.value);
      return next === p[agent.id] ? p : { ...p, [agent.id]: next };
    });
  };
  const setPrompt = (text: string) => {
    if (!focused) return;
    // A command picked on home goes to the prompt of the tab underneath.
    hub.closeHome();
    setEditor(focused, { value: text, cursor: text.length });
  };

  // ---- attachments -----------------------------------------------------------------------------

  const attachOf = (agent: Agent | undefined): Attachment[] => (agent ? (attachments[agent.id] ?? []) : []);
  const addAttachments = (agent: Agent, list: Attachment[]) => {
    if (!list.length) return;
    setAttachments((a) => ({ ...a, [agent.id]: [...(a[agent.id] ?? []), ...list].slice(-10) }));
  };
  /** Attaches files by path; says why when one can't be attached. */
  const attachPathsTo = (agent: Agent, paths: string[]) => {
    const ok: Attachment[] = [];
    for (const p of paths) {
      const a = attachmentFromPath(p);
      if (typeof a === "string") hub.toast(a, "warning");
      else ok.push(a);
    }
    addAttachments(agent, ok);
  };
  const attachPaths = (paths: string[]) => {
    if (focused) attachPathsTo(focused, paths);
  };
  /** The picture or the copied files on the clipboard, for the agent's next message. */
  const pasteClipboard = async (agent: Agent) => {
    const got = await readClipboard(attachmentsDir(hub.stateDir)).catch(() => ({ files: [] as string[], image: null }));
    if (got.files.length) attachPathsTo(agent, got.files);
    else if (got.image) addAttachments(agent, [got.image]);
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
    // No focused agent on home: the help runs a command picked there instead of filling a prompt.
    agent: home ? undefined : focused,
    setPrompt,
    toggleZoom,
    attach: attachPaths,
    paste: () => {
      if (focused) void pasteClipboard(focused);
    },
    dialogs: launchers,
  };
  ctxRef.current = ctx;

  // ---- submitting ------------------------------------------------------------------------------

  const submit = (agent: Agent, text: string) => {
    const value = text.trim();
    const files = attachOf(agent);
    if ((!value && !files.length) || !project) return;
    // Paste chips go out as the texts they stand for.
    const kept = keepReferenced(pastesOf(agent), value);
    const full = (s: string) => expandPastes(s, kept);
    const h = (history.current[project.id] ??= { items: [], index: -1 });
    const sent = full(value);
    h.items = [{ text: value, pastes: kept }, ...h.items.filter((x) => expandPastes(x.text, x.pastes) !== sent)].slice(0, 100);
    h.index = -1;
    setEditor(agent, emptyEditor());
    setScrolls((s) => ({ ...s, [agent.id]: 0 }));
    if (value.startsWith("/")) {
      // Commands don't take attachments; they stay for the next message.
      const typed = /^\/(\S*)/.exec(value)?.[1] ?? "";
      const matches = commandSuggestions(typed);
      if (!findCommand(typed) && matches.length === 1) {
        void runCommandLine(ctx, `/${matches[0].name}${full(value.slice(typed.length + 1))}`);
      } else {
        void runCommandLine(ctx, sent);
      }
      return;
    }
    const at = /^@(\S+)\s+([\s\S]+)$/.exec(value);
    if (at) {
      const got = project.send("you", at[1], full(at[2]), files);
      if (!got.length) {
        // A mistyped name: the text, its chips and the attachments stay, so it can be fixed and sent again.
        setEditor(agent, { value, cursor: value.length }, kept);
        hub.toast(`Nobody called "${at[1]}" here.`, "warning");
        return;
      }
      setAttachments((a) => ({ ...a, [agent.id]: [] }));
      return;
    }
    setAttachments((a) => ({ ...a, [agent.id]: [] }));
    agent.deliver({ from: "you", text: sent, attachments: files.length ? files : undefined });
  };

  // ---- keys ------------------------------------------------------------------------------------

  const slashMenu = (agent: Agent | undefined) => {
    const v = editorOf(agent).value;
    if (!v.startsWith("/") || /\s/.test(v)) return [];
    return commandSuggestions(v.slice(1)).slice(0, 6);
  };

  const scrollBy = (agent: Agent, delta: number) =>
    setScrolls((s) => ({ ...s, [agent.id]: Math.max(0, (s[agent.id] ?? 0) + delta) }));

  /** Home: ↑ ↓ pick a recent folder, enter opens it, esc goes back to the tab underneath. */
  const handleHomeKey = (input: string, key: Key) => {
    if (key.escape) return hub.closeHome();
    if (key.upArrow) return setHomePick(Math.max(0, pick - 1));
    if (key.downArrow) return setHomePick(Math.min(Math.max(0, recent.length - 1), pick + 1));
    if (key.return && recent[pick]) return openRecent(hub, recent[pick]);
    if (input === "?") return launchers.help();
  };

  const handleKey = (input: string, key: Key) => {
    if (key.ctrl && input === "q") return quit();
    if (key.ctrl && input === "c") {
      if (!home && focused?.busy) {
        focused.interrupt();
        return;
      }
      // The time of this press, not of the last render, which can be seconds old.
      const pressed = Date.now();
      if (pressed - lastCtrlC.current < 1500) return quit();
      lastCtrlC.current = pressed;
      hub.toast("Press ctrl+c again to quit.", "info");
      return;
    }
    if (key.ctrl && input === "t") return launchers.newTab();
    if (key.ctrl && input === "k") return launchers.palette();
    if (key.ctrl && input === "l") return launchers.login();
    if (key.meta && input === "0") return hub.openHome();
    if (key.meta && /^[1-9]$/.test(input)) return hub.switchTo(Number(input) - 1);
    if ((key.meta && key.leftArrow) || (key.ctrl && key.pageUp)) return hub.cycleTab(-1);
    if ((key.meta && key.rightArrow) || (key.ctrl && key.pageDown)) return hub.cycleTab(1);
    if (home || !project) return handleHomeKey(input, key);
    if (key.ctrl && input === "n") return launchers.newAgent();
    if (key.ctrl && input === "o" && focused) return launchers.model(focused);
    if (key.ctrl && input === "f") return toggleZoom();
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
      // Ctrl+V where the terminal passes it on (macOS terminals, Linux), Alt+V anywhere.
      void pasteClipboard(agent);
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
      const entry = h.index < 0 ? undefined : h.items[h.index];
      const text = entry?.text ?? "";
      setEditor(agent, { value: text, cursor: text.length }, entry?.pastes ?? noPastes());
      return;
    }
    if (input === "?" && !editor.value) return launchers.help();
    if (key.backspace || (key.ctrl && input === "w")) {
      // Right after a paste chip, the whole chip goes at once.
      const cut = deleteChipBefore(editor, pastesOf(agent), key.ctrl || key.meta);
      if (cut) return setEditor(agent, cut);
    }
    const r = editKey(editor, input, key);
    if (r.kind === "submit") return submit(agent, editor.value);
    if (r.kind === "edit") setEditor(agent, r.state);
  };

  const dialogOpen = dialogs.length > 0;
  useInput(handleKey, { isActive: !dialogOpen });
  usePaste(
    (text) => {
      if (!focused || home) return;
      // An empty paste: the terminal's paste key with no text on the clipboard, only a picture or
      // copied files. Windows Terminal (Ctrl+V, from 1.24 on), the macOS app (Cmd+V), GNOME Terminal
      // and others send one so that the program can read the clipboard itself.
      if (!text) return void pasteClipboard(focused);
      // Files dropped on the terminal arrive as a paste of their paths.
      const files = droppedFiles(text);
      if (files) return attachPaths(files);
      // A long paste becomes a chip ("[Pasted text #1 +87 lines]"); its text goes out with the message.
      if (isLongPaste(text)) {
        const { pastes: kept, token } = addPaste(pastesOf(focused), text);
        return setEditor(focused, insertText(editorOf(focused), token), kept);
      }
      setEditor(focused, insertText(editorOf(focused), text));
    },
    { isActive: !dialogOpen },
  );

  // ---- layout ----------------------------------------------------------------------------------

  const showAxo = theme.axo && hub.config.axo;
  // Home draws no panels: the sky has no glass and the moon comes out.
  const shown = home ? undefined : project;
  const layout: Layout = computeLayout({
    width: columns,
    height: rows,
    agents: shown?.agents ?? [],
    focusedId: focused?.id ?? null,
    zoomed: project?.zoomed ?? false,
    axo: showAxo,
  });
  const glass = layout.panels.map((p) => ({ ...p.rect, focused: p.agentId === focused?.id }));
  // A few ms over the whole catalog: worked out again when it or the Claude account changes, and
  // each minute (for sign-ins elsewhere).
  const minute = Math.floor(now / 60_000);
  const models = useMemo(
    () => (home ? newestModels(hub.registry, minute * 60_000) : []),
    [home, hub, hub.catalogSource, hub.claudeAccount, minute],
  );

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
        <Sky width={columns} height={rows} theme={theme} glass={glass} fps={hub.config.sky.fps} animate={hub.config.sky.enabled && hub.config.sky.fps > 0} enabled={hub.config.sky.enabled} moonAt={shown ? null : undefined} />
        <TabBar hub={hub} rect={layout.tabBar} frame={frame} />
        {shown ? <Header hub={hub} project={shown} rect={layout.header} now={now} /> : null}
        {shown ? (
          layout.panels.map((slot) => {
            const agent = shown.agents.find((a) => a.id === slot.agentId);
            if (!agent) return null;
            const isFocused = agent.id === focused?.id;
            const reserve = layout.axo && agent === leadAgent && !shown.zoomed ? layout.axo.width + 1 : 0;
            return (
              <AgentPanel
                key={agent.id}
                agent={agent}
                project={shown}
                rect={slot.rect}
                focused={isFocused}
                zoomed={shown.zoomed}
                theme={theme}
                frame={frame}
                now={now}
                editor={isFocused ? editorOf(agent) : null}
                chips={isFocused ? pastesOf(agent).items.map((p) => p.token) : undefined}
                scroll={scrolls[agent.id] ?? 0}
                reserveRight={reserve}
                menu={isFocused ? [...chipRows(agent), ...menuRows(agent)] : undefined}
              />
            );
          })
        ) : (
          <Home hub={hub} area={layout.content} recent={recent} pick={pick} models={models} now={now} />
        )}
        {shown && !shown.zoomed
          ? layout.connectors.map((line, i) => (
              <Box key={`conn${i}`} position="absolute" left={line.x} top={line.y1} width={1} height={line.y2 - line.y1 + 1}>
                <Text color={c.border} backgroundColor={c.bg}>
                  {`${"│\n".repeat(Math.max(0, line.y2 - line.y1))}◆`}
                </Text>
              </Box>
            ))
          : null}
        {shown && layout.axo && leadAgent && !shown.zoomed ? (
          <Box position="absolute" left={layout.axo.x} top={layout.axo.y} width={layout.axo.width} height={layout.axo.height} flexDirection="column" alignItems="center">
            <Axo
              mood={mood}
              bg={leadAgent.id === focused?.id ? c.surfaceFocus : c.surface}
              caption={leadBusy ? `${(shown.agents.find((a) => a.status === "working")?.activity ?? "Working")}…` : mood === "done" ? "Done!" : "Ready when you are."}
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
        {layout.hiddenWorkers > 0 && shown && !shown.zoomed ? (
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
