// The Hub is the app: it owns the open projects (tabs), the provider registry, the theme, the
// Claude account and plan usage, the MCP server for Claude Code agents and the Roblox bridge, and it
// decides how each agent runs (ProjectRuntime). The UI reads it and calls its actions.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AcpDriver } from "../agents/acp/driver.js";
import { listAcpModels } from "../agents/acp/models.js";
import { acpEnv } from "../agents/acp/presets.js";
import { readClaudeAccount } from "../agents/claude-code/account.js";
import { claudeEnv as claudeProcessEnv, findClaude } from "../agents/claude-code/cli.js";
import { ClaudeCodeDriver } from "../agents/claude-code/driver.js";
import { claudeInstallCommand, claudeLoginArgs, claudeLogoutArgs } from "../agents/claude-code/login.js";
import { applyRateLimit, fetchPlanUsage } from "../agents/claude-code/usage.js";
import { NativeDriver } from "../agents/native/driver.js";
import { systemPrompt } from "../agents/prompts.js";
import {
  cloudStartCommand,
  parseCloudSession,
  sendToCloud,
  sessionFromTranscript,
  teleportArgs,
  type CloudSession,
} from "../cloud/claude-cloud.js";
import { McpServer } from "../mcp/server.js";
import { writeFileAtomicSync } from "../platform/files.js";
import { samePath, stateDir as defaultStateDir } from "../platform/paths.js";
import { findProgram, withProgramPath } from "../platform/process.js";
import { AuthStore, keyFor } from "../providers/auth.js";
import { fallbackCatalog, loadCatalog, type Catalog } from "../providers/catalog.js";
import type { ModelRef } from "../providers/models.js";
import { listOllamaModels } from "../providers/ollama.js";
import { fetchOpenRouterBalance, startOpenRouterLogin, type OAuthLogin } from "../providers/openrouter.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { ChatMessage, FetchLike } from "../providers/types.js";
import { createChatClient } from "../providers/wire/index.js";
import { RobloxBridge } from "../roblox/bridge.js";
import { bridgeToken, bridgeTokenFile } from "../roblox/token.js";
import type { ThemeManager } from "../themes/manager.js";
import type { Theme } from "../themes/types.js";
import { detectShell } from "../tools/exec.js";
import { toolsForAgent } from "../tools/index.js";
import type { CloudApi, ToolServices } from "../tools/types.js";
import { VERSION } from "../version.js";
import { Agent, type SavedAgentState } from "./agent.js";
import { attachmentsDir, pruneAttachments } from "./attachments.js";
import { distrusted, rememberRecent, rememberTrust, saveConfig, type Config } from "./config.js";
import { newId, Notifier } from "./emitter.js";
import { Project, type ProjectRuntime } from "./project.js";
import { StatsStore } from "./stats.js";
import type { ClaudeAccount, PermissionMode, PlanUsage, ProviderBalance, TaskItem, TeamMessage } from "./types.js";

export type ToastLevel = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  text: string;
  level: ToastLevel;
  at: number;
}

/**
 * Runs a program in the real terminal while the UI steps aside (sign-ins, installers). The UI
 * provides it through Ink's suspendTerminal; resolves to the exit code.
 */
export type TerminalRunner = (
  exe: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<number | null>;

export interface HubOptions {
  config: Config;
  /** Where the config is saved; null keeps it in memory (tests). */
  configPath: string | null;
  auth: AuthStore;
  themes: ThemeManager;
  cacheDir: string;
  stateDir?: string;
  fetchImpl?: FetchLike;
  /** No catalog download, no usage polling (tests, --offline). */
  offline?: boolean;
  /** Start the Roblox bridge and the MCP server (off in tests). */
  servers?: boolean;
}

/** What survives closing lu-minal: every tab, its agents with their logs and conversations. */
export interface SavedSession {
  version: 2;
  savedAt: number;
  active: number;
  /** Cloud sessions started from lu-minal (the CLI can't list them). */
  cloud?: CloudSession[];
  projects: Array<{
    cwd: string;
    name: string;
    origin: string;
    permissionMode: PermissionMode;
    /** Whether the folder's own agent settings may load (missing: trusted unless it was cloned). */
    trusted?: boolean;
    createdAt: number;
    focused: string | null;
    tasks: TaskItem[];
    messages: TeamMessage[];
    agents: Array<{
      name: string;
      role: "lead" | "worker";
      label: string | null;
      model: ModelRef;
      sessionId: string | null;
      instructions: string | null;
      spawnedBy: string;
      state: SavedAgentState;
      /** The native driver's conversation (Claude Code resumes by sessionId instead). */
      conversation: unknown;
    }>;
  }>;
}

export class Hub implements ProjectRuntime {
  readonly notifier = new Notifier();
  readonly config: Config;
  readonly auth: AuthStore;
  readonly themes: ThemeManager;
  readonly registry: ProviderRegistry;
  readonly roblox: RobloxBridge;
  /** The token the bridge accepts, for the plugin the /roblox dialog installs (null in tests). */
  readonly robloxToken: string | null;
  readonly mcp: McpServer;
  readonly stateDir: string;
  readonly stats: StatsStore;

  projects: Project[] = [];
  activeIndex = 0;
  claudeAccount: ClaudeAccount | null = null;
  planUsage: PlanUsage | null = null;
  usageError: string | null = null;
  balances = new Map<string, ProviderBalance>();
  toasts: Toast[] = [];
  cloudSessions: CloudSession[] = [];
  catalogSource: Catalog["source"] | null = null;
  ready = false;

  private readonly opts: HubOptions;
  private timers: NodeJS.Timeout[] = [];
  private usageInFlight = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.auth = opts.auth;
    this.themes = opts.themes;
    this.stateDir = opts.stateDir ?? defaultStateDir();
    this.stats = new StatsStore(opts.configPath ? path.join(this.stateDir, "stats.json") : null);
    // Every change may be worth saving; the save itself is debounced.
    this.notifier.subscribe(() => this.scheduleSave());
    this.registry = new ProviderRegistry({
      // The built-in list until models.dev's catalog arrives, so pickers are never empty.
      catalog: fallbackCatalog(),
      auth: this.auth,
      config: this.config,
      claudeAccount: () => this.claudeAccount,
    });
    // Only the plugin installed by this lu-minal (it carries the token) may connect; tests keep no
    // config on disk and run without one.
    let token: string | null = null;
    if (opts.configPath) {
      try {
        token = bridgeToken(bridgeTokenFile(path.dirname(opts.configPath)));
      } catch (err) {
        // Can't be saved: a token for this run only (never none, which would let anyone in).
        token = randomBytes(32).toString("hex");
        // Only worth saying to someone who uses the Studio bridge; the advice comes first.
        if (this.config.roblox.enabled) {
          this.toast(`Roblox: install the plugin again after every start (the plugin token can't be saved: ${errText(err)}).`, "warning");
        }
      }
    }
    this.robloxToken = token;
    this.roblox = new RobloxBridge({ port: this.config.roblox.port, token });
    this.roblox.subscribe(() => this.notifier.changed());
    this.mcp = new McpServer({
      stateDir: this.stateDir,
      version: VERSION,
      resolve: (agentId) => {
        for (const project of this.projects) {
          const agent = project.agents.find((a) => a.id === agentId);
          if (agent) {
            return {
              agent,
              project,
              tools: toolsForAgent(agent.role, "claude-code", { fetchImpl: this.opts.fetchImpl }),
              services: this.servicesFor(project),
            };
          }
        }
        return null;
      },
    });
    this.themes.subscribe(() => {
      const name = this.themes.current.name;
      if (this.config.theme !== name) {
        this.config.theme = name;
        this.persistConfig();
      }
      this.notifier.changed();
    });
  }

  // ---- start and stop --------------------------------------------------------------------------

  /** Loads the catalog, finds Claude Code, starts the servers and the pollers. */
  async init(): Promise<void> {
    const servers = this.opts.servers !== false;
    const tasks: Array<Promise<unknown>> = [
      loadCatalog({
        cacheDir: this.opts.cacheDir,
        fetchImpl: this.opts.fetchImpl,
        offline: this.opts.offline,
      }).then((catalog) => {
        this.registry.setCatalog(catalog);
        this.catalogSource = catalog.source;
      }),
      this.refreshClaude(),
    ];
    if (servers) {
      tasks.push(this.mcp.start(0).catch((err) => this.toast(`MCP server: ${errText(err)}`, "error")));
      if (this.config.roblox.enabled) tasks.push(this.roblox.start());
    }
    await Promise.all(tasks.map((t) => t.catch(() => undefined)));
    void this.refreshLocalModels();
    // Clipboard pictures older than a month go.
    pruneAttachments(attachmentsDir(this.stateDir));
    this.ready = true;
    this.notifier.changed();
    if (!this.opts.offline) this.startPollers();
  }

  private startPollers(): void {
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref();
      this.timers.push(t);
    };
    void this.refreshUsage();
    void this.refreshBalances();
    const usageSeconds = this.config.usagePollSeconds;
    if (usageSeconds > 0) every(Math.max(30, usageSeconds) * 1000, () => void this.refreshUsage());
    every(5 * 60_000, () => void this.refreshBalances());
    every(10 * 60_000, () => void this.refreshClaude());
    // The clock in the header and the agents' elapsed times.
    every(1000, () => {
      if (this.projects.some((p) => p.agents.some((a) => a.busy))) this.notifier.changed();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // Save before the drivers stop, while their conversations are still there.
    this.saveSession();
    this.stats.flush();
    await Promise.all(this.projects.map((p) => p.dispose().catch(() => undefined)));
    await Promise.all([this.mcp.stop().catch(() => undefined), this.roblox.stop().catch(() => undefined)]);
  }

  // ---- projects --------------------------------------------------------------------------------

  get activeProject(): Project | undefined {
    return this.projects[this.activeIndex];
  }

  /** Opens a folder as a new tab with a lead agent. */
  async openProject(opts: {
    cwd: string;
    name?: string;
    origin?: string;
    lead?: ModelRef;
    task?: string;
    permissionMode?: PermissionMode;
    /**
     * Load the folder's own agent settings (defaults to the user's earlier answer for the folder,
     * else true for local folders and false for clones).
     */
    trusted?: boolean;
  }): Promise<Project> {
    const cwd = path.resolve(opts.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Not a folder: ${cwd}`);
    }
    const project = new Project(
      {
        cwd,
        name: opts.name,
        origin: opts.origin,
        permissionMode: opts.permissionMode ?? this.config.permissionMode,
        // A folder the user didn't trust stays untrusted, however it is opened again.
        trusted: opts.trusted ?? (distrusted(this.config, cwd) ? false : undefined),
      },
      this.notifier,
      this,
    );
    this.projects.push(project);
    this.activeIndex = this.projects.length - 1;
    rememberRecent(this.config, cwd);
    rememberTrust(this.config, cwd, project.trusted);
    this.persistConfig();
    this.notifier.changed();
    await project.addAgent({
      name: "luna",
      role: "lead",
      model: opts.lead ?? this.registry.defaultLeadModel(),
      task: opts.task,
      spawnedBy: "you",
    });
    this.scheduleSave();
    return project;
  }

  async closeProject(project: Project): Promise<void> {
    const i = this.projects.indexOf(project);
    if (i < 0) return;
    this.projects.splice(i, 1);
    if (this.activeIndex >= this.projects.length) this.activeIndex = Math.max(0, this.projects.length - 1);
    this.notifier.changed();
    await project.dispose();
    this.scheduleSave();
  }

  switchTo(index: number): void {
    if (index < 0 || index >= this.projects.length) return;
    this.activeIndex = index;
    this.notifier.changed();
  }

  cycleTab(step: number): void {
    if (!this.projects.length) return;
    this.switchTo((this.activeIndex + step + this.projects.length) % this.projects.length);
  }

  // ---- ProjectRuntime --------------------------------------------------------------------------

  async launch(project: Project, agent: Agent): Promise<void> {
    this.watchUsage(project, agent);
    if (agent.model.provider === "claude-code") {
      const exe = findClaude(this.config.claudePath);
      if (!exe) {
        agent.setStatus("error");
        throw new Error(
          "Claude Code is not installed. Open /login and pick Claude to install it and sign in with your Claude account.",
        );
      }
      agent.driver = new ClaudeCodeDriver({
        agent,
        project,
        exe,
        mcp: this.mcp,
        env: this.claudeEnv(),
        systemPrompt: () => this.promptFor(project, agent, "claude-code"),
        onRateLimit: (ev) => {
          this.planUsage = applyRateLimit(this.planUsage, ev);
          this.notifier.changed();
        },
      });
    } else if (this.registry.provider(agent.model.provider)?.kind === "acp") {
      const preset = this.registry.acpPreset(agent.model.provider);
      const exe = preset ? this.registry.acpProgram(preset.id) : null;
      if (!preset || !exe) {
        agent.setStatus("error");
        throw new Error(this.registry.connectionHint(agent.model.provider));
      }
      if (!project.trusted) {
        agent.info(
          `${preset.name} loads this folder's own settings (its project config and MCP servers) even though you haven't trusted it; lu-minal can't switch that off.`,
        );
      }
      agent.driver = new AcpDriver({
        agent,
        project,
        preset,
        exe,
        mcp: this.mcp,
        // The team-only prompt, as for Claude Code; the driver renames mcp__luminal__* to the agent's names.
        systemPrompt: () => this.promptFor(project, agent, "claude-code"),
        version: VERSION,
      });
    } else {
      agent.driver = new NativeDriver({
        agent,
        project,
        resolveModel: () => this.registry.resolve(agent.model),
        createClient: (resolved) => {
          if (!resolved.wire || !resolved.endpoint) {
            throw new Error(`${agent.modelLabel} has no HTTP endpoint.`);
          }
          return createChatClient(resolved.wire, resolved.endpoint, this.opts.fetchImpl);
        },
        tools: toolsForAgent(agent.role, "native", { fetchImpl: this.opts.fetchImpl }),
        services: this.servicesFor(project),
        systemPrompt: () => this.promptFor(project, agent, "native"),
      });
    }
    await agent.driver.start();
    this.scheduleSave();
  }

  /** Feeds an agent's usage and diffs into the statistics. */
  private watchUsage(project: Project, agent: Agent): void {
    if (!agent.onUsage) this.stats.agentStarted(agent.model.provider);
    agent.onUsage = (u) =>
      this.stats.record({
        at: Date.now(),
        provider: agent.model.provider,
        model: agent.model.model,
        project: { cwd: project.cwd, name: project.name },
        input: u.input,
        output: u.output,
        costUsd: u.costUsd,
        turns: u.turn ? 1 : 0,
      });
    agent.onLines = (added, removed) => this.stats.addLines(added, removed);
  }

  defaultWorkerModel(project: Project, spawner: Agent | null): ModelRef {
    const lead = spawner?.model ?? project.lead?.model ?? this.registry.defaultLeadModel();
    return this.registry.defaultWorkerModel(lead);
  }

  servicesFor(project: Project): ToolServices {
    return { team: project.teamApi(), themes: this.themes.api(), roblox: this.roblox, cloud: this.cloudApi(project) };
  }

  // ---- Claude cloud sessions -------------------------------------------------------------------

  /**
   * The environment for Claude Code processes that must use the Claude subscription: with -p, an
   * ANTHROPIC_API_KEY in the environment wins over the claude.ai login, so it is left out (lu-minal
   * keeps API keys for its own "anthropic" provider).
   */
  claudeEnv(): NodeJS.ProcessEnv {
    const env = claudeProcessEnv(process.env, findClaude(this.config.claudePath));
    if (!this.config.claudeUseApiKey) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    return env;
  }

  private cloudApi(project: Project): CloudApi {
    return {
      list: () =>
        this.cloudSessions
          .filter((s) => samePath(s.cwd, project.cwd))
          .map((s) => ({ id: s.id, url: s.url, task: s.task, startedAt: s.startedAt })),
      send: async (sessionId, text) => {
        const session = this.cloudSessions.find((s) => s.id === sessionId) ?? null;
        const result = await this.sendCloud(session ?? { id: sessionId, cwd: project.cwd }, text);
        if (!result.ok) throw new Error(result.error ?? "The cloud session did not take the message.");
        return result.url ?? `https://claude.ai/code/${sessionId}`;
      },
    };
  }

  /**
   * Starts a cloud session for `task` in the real terminal (`claude --cloud`). Returns the session
   * when its link could be read from the CLI's output; null otherwise (the UI asks for the link).
   */
  async startCloud(project: Project, task: string, run: TerminalRunner): Promise<CloudSession | null> {
    const exe = findClaude(this.config.claudePath);
    if (!exe) throw new Error("Claude Code is not installed - /login claude installs it.");
    const cmd = cloudStartCommand(exe, task);
    await run(cmd.exe, cmd.args, { cwd: project.cwd, env: this.claudeEnv() });
    const found = sessionFromTranscript(cmd.transcript);
    return found ? this.addCloudSession(project, task, found.url) : null;
  }

  /** Remembers a cloud session from a pasted link or id. */
  addCloudSession(project: Project, task: string, link: string): CloudSession | null {
    const found = parseCloudSession(link);
    if (!found) return null;
    const existing = this.cloudSessions.find((s) => s.id === found.id);
    if (existing) return existing;
    const session: CloudSession = {
      id: found.id,
      url: found.url,
      task: task.trim() || "Cloud session",
      cwd: project.cwd,
      startedAt: Date.now(),
      lastMessageAt: null,
      lastError: null,
    };
    this.cloudSessions.unshift(session);
    this.toast(`Cloud session ${found.id} is running on claude.ai/code.`, "success");
    this.notifier.changed();
    return session;
  }

  async sendCloud(session: Pick<CloudSession, "id" | "cwd">, text: string) {
    const exe = findClaude(this.config.claudePath);
    if (!exe) return { ok: false, sessionId: null, url: null, error: "Claude Code is not installed." };
    // `claude -p` runs in the folder: one that isn't an open, trusted tab gets the user's own settings only.
    const trusted = this.projects.some((p) => p.trusted && samePath(p.cwd, session.cwd));
    const result = await sendToCloud(exe, session.id, text, { cwd: session.cwd, env: this.claudeEnv(), trusted });
    const known = this.cloudSessions.find((s) => s.id === session.id);
    if (known) {
      known.lastMessageAt = Date.now();
      known.lastError = result.ok ? null : result.error;
      if (result.url) known.url = result.url.replace(/\?.*$/, "");
    }
    this.notifier.changed();
    return result;
  }

  /** Continues a cloud session in this terminal (`claude --teleport`), in the project's folder. */
  async teleport(project: Project, session: CloudSession, run: TerminalRunner): Promise<void> {
    const exe = findClaude(this.config.claudePath);
    if (!exe) throw new Error("Claude Code is not installed.");
    await run(exe, teleportArgs(session.id), { cwd: project.cwd, env: this.claudeEnv() });
  }

  forgetCloud(id: string): void {
    this.cloudSessions = this.cloudSessions.filter((s) => s.id !== id);
    this.notifier.changed();
  }

  private promptFor(project: Project, agent: Agent, driverKind: "native" | "claude-code"): string {
    return systemPrompt({
      agentName: agent.name,
      role: agent.role,
      label: agent.label,
      projectName: project.name,
      cwd: project.cwd,
      teammates: project.agents
        .filter((a) => a !== agent)
        .map((a) => ({ name: a.name, role: a.role, label: a.label, model: a.modelLabel })),
      driverKind,
      platform: process.platform,
      shellName: detectShell().name,
      robloxConnected: this.roblox.status().connected,
      date: new Date().toISOString().slice(0, 10),
      extraInstructions: agent.instructions,
    });
  }

  /**
   * Trusts (or stops trusting) a project's own agent settings: its .claude settings (hooks,
   * permission rules), CLAUDE.md and .mcp.json servers, remembered for the folder. Claude Code reads
   * them when its process starts, so each Claude Code driver replaces a process that started with
   * the other trust: an idle one now, a busy one when its turn ends (both resume their session).
   */
  async setTrust(project: Project, trusted: boolean): Promise<void> {
    if (project.trusted === trusted) return;
    project.setTrusted(trusted);
    rememberTrust(this.config, project.cwd, trusted);
    this.persistConfig();
    for (const agent of project.agents) {
      if (!(agent.driver instanceof ClaudeCodeDriver)) continue;
      agent.driver.settingsChanged();
      agent.info(
        `${trusted ? "Trusted" : "No longer trusted"}: Claude Code restarts ${trusted ? "with" : "without"} this folder's own settings ${agent.busy ? "when this turn ends" : "at the next message"}.`,
      );
    }
    this.scheduleSave();
    this.notifier.changed();
  }

  /** Moves an agent to another model (the driver restarts; Claude Code and ACP agents resume their session). */
  async changeModel(project: Project, agent: Agent, model: ModelRef): Promise<void> {
    // Within the same CLI the session carries on and the new driver picks the new model in it.
    const keepSession =
      agent.model.provider === model.provider &&
      (model.provider === "claude-code" || this.registry.provider(model.provider)?.kind === "acp");
    // A native conversation moves to the new model; Claude Code keeps its own session.
    const conversation = agent.driver?.snapshot?.() ?? null;
    await agent.driver?.dispose().catch(() => undefined);
    agent.driver = null;
    agent.model = model;
    if (!keepSession) agent.sessionId = null;
    agent.info(`Now on ${agent.modelLabel}.`);
    try {
      await this.launch(project, agent);
      // launch() set a new driver (TypeScript still sees the null from above).
      const driver = agent.driver as Agent["driver"];
      if (conversation && driver?.restore) driver.restore(withoutWireData(conversation));
    } catch (err) {
      agent.error(errText(err));
    }
    this.notifier.changed();
  }

  // ---- Claude ----------------------------------------------------------------------------------

  async refreshClaude(): Promise<void> {
    const exe = findClaude(this.config.claudePath);
    try {
      this.claudeAccount = await readClaudeAccount(exe);
    } catch {
      this.claudeAccount = null;
    }
    this.notifier.changed();
  }

  async refreshUsage(): Promise<void> {
    const account = this.claudeAccount;
    if (this.usageInFlight || !account?.exe || !account.loggedIn) return;
    this.usageInFlight = true;
    try {
      const usage = await fetchPlanUsage(account.exe);
      if (usage) {
        // Keep live windows from running agents when the report has none.
        this.planUsage = usage.available ? usage : { ...usage, session: this.planUsage?.session ?? null, week: this.planUsage?.week ?? null };
        this.usageError = null;
      }
    } catch (err) {
      this.usageError = errText(err);
    } finally {
      this.usageInFlight = false;
      this.notifier.changed();
    }
  }

  async refreshBalances(): Promise<void> {
    const key = keyFor("openrouter", ["OPENROUTER_API_KEY"], this.auth)?.key ?? null;
    if (!key) {
      this.balances.delete("openrouter");
      return;
    }
    const balance = await fetchOpenRouterBalance(key, this.opts.fetchImpl).catch(() => null);
    if (balance) this.balances.set("openrouter", balance);
    this.notifier.changed();
  }

  /** `refreshAcp`: the ACP agent whose model list is asked for again, cache or not (after a sign-in). */
  async refreshLocalModels(opts: { refreshAcp?: string } = {}): Promise<void> {
    const models = await listOllamaModels(this.config.providers.ollama?.baseURL, this.opts.fetchImpl).catch(() => []);
    this.registry.setLocalModels("ollama", models);
    if (!this.opts.offline) {
      this.registry.refreshAcp();
      // OpenCode's own model list (`opencode models`, cached for a day); the others list static models.
      await Promise.all(
        this.registry.acpPresets().map(async (preset) => {
          if (preset.models !== "opencode") return;
          const exe = this.registry.acpProgram(preset.id);
          if (!exe) return;
          const list = await listAcpModels(preset, { exe, cacheDir: this.opts.cacheDir, refresh: opts.refreshAcp === preset.id }).catch(() => []);
          if (list.length) this.registry.setLocalModels(preset.id, list);
        }),
      );
    }
    this.notifier.changed();
  }

  /** Installs Claude Code if needed, then signs in through `claude auth login` in the terminal. */
  async loginClaude(run: TerminalRunner): Promise<boolean> {
    let exe = findClaude(this.config.claudePath);
    if (!exe) {
      const install = claudeInstallCommand();
      const installer = findProgram(install.exe) ?? install.exe;
      await run(installer, install.args);
      exe = findClaude(this.config.claudePath);
      if (!exe) {
        this.toast(`Claude Code could not be installed. Run: ${install.display}`, "error");
        return false;
      }
    }
    await run(exe, claudeLoginArgs(), { env: this.claudeEnv() });
    await this.refreshClaude();
    const ok = Boolean(this.claudeAccount?.loggedIn);
    this.toast(ok ? `Signed in to Claude${this.claudeAccount?.email ? ` as ${this.claudeAccount.email}` : ""}.` : "Claude sign-in did not finish.", ok ? "success" : "warning");
    if (ok) void this.refreshUsage();
    return ok;
  }

  async logoutClaude(run: TerminalRunner): Promise<void> {
    const exe = findClaude(this.config.claudePath);
    if (!exe) return;
    await run(exe, claudeLogoutArgs(), { env: this.claudeEnv() });
    await this.refreshClaude();
    this.planUsage = null;
    this.toast("Signed out of Claude.", "info");
  }

  // ---- other providers -------------------------------------------------------------------------

  /** Signs in to an ACP agent's own CLI (`opencode auth login`) in the real terminal. */
  async loginAcp(providerId: string, run: TerminalRunner): Promise<boolean> {
    const preset = this.registry.acpPreset(providerId);
    if (!preset) return false;
    this.registry.refreshAcp();
    const exe = this.registry.acpProgram(providerId);
    if (!exe) {
      this.toast(this.registry.connectionHint(providerId), "warning");
      return false;
    }
    if (preset.login) {
      const loginExe = preset.login.command === preset.command ? exe : (findProgram(preset.login.command) ?? preset.login.command);
      await run(loginExe, preset.login.args, { env: withProgramPath(acpEnv(preset), loginExe) });
    } else {
      this.toast(preset.signIn, "info");
    }
    // The sign-in may have added providers (`opencode auth login`): ask for the models again.
    void this.refreshLocalModels({ refreshAcp: preset.id });
    return true;
  }

  /** Starts OpenRouter's browser sign-in; the key is stored when it finishes. */
  async loginOpenRouter(): Promise<OAuthLogin> {
    const login = await startOpenRouterLogin({ fetchImpl: this.opts.fetchImpl });
    login.result.then(
      (key) => {
        this.auth.set("openrouter", { type: "oauth", key, createdAt: Date.now() });
        this.toast("Signed in to OpenRouter.", "success");
        void this.refreshBalances();
        this.notifier.changed();
      },
      (err) => this.toast(`OpenRouter sign-in: ${errText(err)}`, "warning"),
    );
    return login;
  }

  setApiKey(providerId: string, key: string): void {
    this.auth.set(providerId, { type: "api", key: key.trim() });
    this.toast(`Saved the key for ${this.registry.provider(providerId)?.name ?? providerId}.`, "success");
    if (providerId === "openrouter") void this.refreshBalances();
    this.notifier.changed();
  }

  removeKey(providerId: string): void {
    this.auth.remove(providerId);
    this.balances.delete(providerId);
    this.toast(`Signed out of ${this.registry.provider(providerId)?.name ?? providerId}.`, "info");
    this.notifier.changed();
  }

  // ---- theme -----------------------------------------------------------------------------------

  get theme(): Theme {
    return this.themes.current;
  }

  setTheme(name: string): boolean {
    const ok = this.themes.set(name);
    if (!ok) this.toast(`There is no theme "${name}".`, "warning");
    return ok;
  }

  // ---- toasts and saving -----------------------------------------------------------------------

  toast(text: string, level: ToastLevel = "info"): void {
    const toast: Toast = { id: newId("toast"), text, level, at: Date.now() };
    this.toasts.push(toast);
    if (this.toasts.length > 4) this.toasts.shift();
    this.notifier.changed();
    const t = setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== toast.id);
      this.notifier.changed();
    }, level === "error" ? 9000 : 5000);
    t.unref();
  }

  persistConfig(): void {
    if (!this.opts.configPath) return;
    try {
      saveConfig(this.config, this.opts.configPath);
    } catch (err) {
      this.toast(`Could not save the settings: ${errText(err)}`, "error");
    }
  }

  private sessionFile(): string {
    return path.join(this.stateDir, "session.json");
  }

  private scheduleSave(): void {
    if (this.saveTimer || !this.opts.configPath || this.disposed || !this.ready) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveSession();
    }, 4000);
    this.saveTimer.unref();
  }

  /** The session as it would be saved now. */
  snapshotSession(): SavedSession {
    return {
      version: 2,
      savedAt: Date.now(),
      active: this.activeIndex,
      cloud: this.cloudSessions.slice(0, 50),
      projects: this.projects.map((p) => ({
        cwd: p.cwd,
        name: p.name,
        origin: p.origin,
        permissionMode: p.permissionMode,
        trusted: p.trusted,
        createdAt: p.createdAt,
        focused: p.focused?.name ?? null,
        tasks: p.tasks,
        messages: p.messages.slice(-100),
        agents: p.agents.map((a) => {
          let conversation: unknown = null;
          try {
            conversation = a.driver?.snapshot?.() ?? null;
          } catch {
            conversation = null;
          }
          return {
            name: a.name,
            role: a.role,
            label: a.label,
            model: a.model,
            sessionId: a.sessionId,
            instructions: a.instructions,
            spawnedBy: a.spawnedBy,
            state: a.saveState(),
            conversation,
          };
        }),
      })),
    };
  }

  /** Writes the open tabs, their agents, logs and conversations, so closing lu-minal loses nothing. */
  saveSession(): void {
    if (!this.opts.configPath || !this.ready) return;
    try {
      // Private: it holds conversation logs and the allow lists.
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      // Retried on Windows while a virus scanner / backup tool holds session.json, then written in place.
      writeFileAtomicSync(this.sessionFile(), JSON.stringify(this.snapshotSession()), { mode: 0o600 });
    } catch {
      // Not worth bothering the user about; the next change tries again.
    }
  }

  /** The saved session, or null when there is none (or it can't be read). */
  readSavedSession(): SavedSession | null {
    try {
      const saved = JSON.parse(fs.readFileSync(this.sessionFile(), "utf8")) as SavedSession;
      return saved && Array.isArray(saved.projects) ? saved : null;
    } catch {
      return null;
    }
  }

  /**
   * Reopens the tabs of the last session: every agent comes back with its log, counters and
   * conversation (Claude Code agents resume their session). Returns how many tabs came back.
   */
  async restoreSession(saved: SavedSession | null = this.readSavedSession()): Promise<number> {
    if (!saved) return 0;
    for (const c of saved.cloud ?? []) {
      if (c?.id && !this.cloudSessions.some((s) => s.id === c.id)) this.cloudSessions.push(c);
    }
    let restored = 0;
    for (const p of saved.projects) {
      if (!p.cwd || !fs.existsSync(p.cwd) || this.projects.some((x) => samePath(x.cwd, p.cwd))) continue;
      const trusted = p.trusted ?? (distrusted(this.config, p.cwd) ? false : undefined);
      const project = new Project(
        { cwd: p.cwd, name: p.name, origin: p.origin, permissionMode: p.permissionMode, trusted },
        this.notifier,
        this,
      );
      rememberTrust(this.config, project.cwd, project.trusted);
      if (p.createdAt) project.createdAt = p.createdAt;
      project.tasks = Array.isArray(p.tasks) ? p.tasks : [];
      project.messages = Array.isArray(p.messages) ? p.messages : [];
      this.projects.push(project);
      const lead = p.agents.find((a) => a.role === "lead");
      const ordered = lead ? [lead, ...p.agents.filter((a) => a !== lead)] : p.agents;
      for (const a of ordered) {
        const agent = new Agent(
          {
            name: a.name,
            role: a.role,
            label: a.label ?? undefined,
            model: a.model,
            instructions: a.instructions ?? undefined,
            spawnedBy: a.spawnedBy,
          },
          this.notifier,
          project.permissionMode,
        );
        agent.sessionId = a.sessionId ?? null;
        if (a.state) agent.restoreState(a.state);
        // A placeholder sink tells launch() this agent was counted as started in an earlier run.
        agent.onUsage = () => undefined;
        project.agents.push(agent);
        if (a.name === p.focused || !project.focusedId) project.focusedId = agent.id;
        try {
          await this.launch(project, agent);
          if (a.conversation && agent.driver?.restore) agent.driver.restore(a.conversation);
        } catch (err) {
          agent.error(errText(err));
        }
      }
      restored++;
    }
    if (restored) {
      this.activeIndex = Math.min(Math.max(0, saved.active ?? 0), this.projects.length - 1);
      this.persistConfig();
      this.notifier.changed();
    }
    return restored;
  }
}

/**
 * A saved native conversation without the provider-specific raw data (reasoning signatures,
 * reasoning_content, ...): another provider on the same wire would choke on it.
 */
export function withoutWireData(conversation: unknown): unknown {
  const c = conversation as { messages?: ChatMessage[] } | null;
  if (!c || !Array.isArray(c.messages)) return conversation;
  return {
    ...c,
    messages: c.messages.map((m) => {
      if (m.role !== "assistant" || !m.raw) return m;
      const { raw: _raw, ...rest } = m;
      return rest;
    }),
  };
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
