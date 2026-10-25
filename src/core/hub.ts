// The Hub is the app: it owns the open projects (tabs), the provider registry, the theme, the
// Claude account and plan usage, the MCP server for Claude Code agents and the Roblox bridge, and it
// decides how each agent runs (ProjectRuntime). The UI reads it and calls its actions.
import fs from "node:fs";
import path from "node:path";
import { readClaudeAccount } from "../agents/claude-code/account.js";
import { findClaude } from "../agents/claude-code/cli.js";
import { ClaudeCodeDriver } from "../agents/claude-code/driver.js";
import { claudeInstallCommand, claudeLoginArgs, claudeLogoutArgs } from "../agents/claude-code/login.js";
import { applyRateLimit, fetchPlanUsage } from "../agents/claude-code/usage.js";
import { NativeDriver } from "../agents/native/driver.js";
import { systemPrompt } from "../agents/prompts.js";
import { McpServer } from "../mcp/server.js";
import { stateDir as defaultStateDir } from "../platform/paths.js";
import { findProgram } from "../platform/process.js";
import { AuthStore } from "../providers/auth.js";
import { loadCatalog, type Catalog } from "../providers/catalog.js";
import type { ModelRef } from "../providers/models.js";
import { listOllamaModels } from "../providers/ollama.js";
import { fetchOpenRouterBalance, startOpenRouterLogin, type OAuthLogin } from "../providers/openrouter.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { FetchLike } from "../providers/types.js";
import { createChatClient } from "../providers/wire/index.js";
import { RobloxBridge } from "../roblox/bridge.js";
import type { ThemeManager } from "../themes/manager.js";
import type { Theme } from "../themes/types.js";
import { detectShell } from "../tools/exec.js";
import { toolsForAgent } from "../tools/index.js";
import type { ToolServices } from "../tools/types.js";
import { Agent } from "./agent.js";
import { rememberRecent, saveConfig, type Config } from "./config.js";
import { newId, Notifier } from "./emitter.js";
import { Project, type ProjectRuntime } from "./project.js";
import type { ClaudeAccount, PermissionMode, PlanUsage, ProviderBalance } from "./types.js";

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
export type TerminalRunner = (exe: string, args: string[], opts?: { cwd?: string }) => Promise<number | null>;

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

interface SavedSession {
  active: number;
  projects: Array<{
    cwd: string;
    name: string;
    origin: string;
    permissionMode: PermissionMode;
    agents: Array<{
      name: string;
      role: "lead" | "worker";
      label: string | null;
      model: ModelRef;
      sessionId: string | null;
      instructions: string | null;
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
  readonly mcp: McpServer;
  readonly stateDir: string;

  projects: Project[] = [];
  activeIndex = 0;
  claudeAccount: ClaudeAccount | null = null;
  planUsage: PlanUsage | null = null;
  usageError: string | null = null;
  balances = new Map<string, ProviderBalance>();
  toasts: Toast[] = [];
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
    this.registry = new ProviderRegistry({
      catalog: { providers: [], models: [], fetchedAt: null, source: "fallback" },
      auth: this.auth,
      config: this.config,
      claudeAccount: () => this.claudeAccount,
    });
    this.roblox = new RobloxBridge({ port: this.config.roblox.port });
    this.roblox.subscribe(() => this.notifier.changed());
    this.mcp = new McpServer({
      stateDir: this.stateDir,
      version: process.env.LU_MINAL_VERSION ?? "dev",
      resolve: (agentId) => {
        for (const project of this.projects) {
          const agent = project.agents.find((a) => a.id === agentId);
          if (agent) {
            return {
              agent,
              project,
              tools: toolsForAgent(agent.role, "claude-code"),
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
    this.saveSession();
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
      },
      this.notifier,
      this,
    );
    this.projects.push(project);
    this.activeIndex = this.projects.length - 1;
    rememberRecent(this.config, cwd);
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
        systemPrompt: () => this.promptFor(project, agent, "claude-code"),
        onRateLimit: (ev) => {
          this.planUsage = applyRateLimit(this.planUsage, ev);
          this.notifier.changed();
        },
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
        tools: toolsForAgent(agent.role, "native"),
        services: this.servicesFor(project),
        systemPrompt: () => this.promptFor(project, agent, "native"),
      });
    }
    await agent.driver.start();
    this.scheduleSave();
  }

  defaultWorkerModel(project: Project, spawner: Agent | null): ModelRef {
    const lead = spawner?.model ?? project.lead?.model ?? this.registry.defaultLeadModel();
    return this.registry.defaultWorkerModel(lead);
  }

  servicesFor(project: Project): ToolServices {
    return { team: project.teamApi(), themes: this.themes.api(), roblox: this.roblox };
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

  /** Moves an agent to another model (the driver restarts; Claude Code resumes its session). */
  async changeModel(project: Project, agent: Agent, model: ModelRef): Promise<void> {
    const wasClaude = agent.model.provider === "claude-code";
    await agent.driver?.dispose().catch(() => undefined);
    agent.driver = null;
    agent.model = model;
    if (!wasClaude || model.provider !== "claude-code") agent.sessionId = null;
    agent.info(`Now on ${agent.modelLabel}.`);
    try {
      await this.launch(project, agent);
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
    const key = this.auth.secretFor("openrouter") ?? process.env.OPENROUTER_API_KEY ?? null;
    if (!key) {
      this.balances.delete("openrouter");
      return;
    }
    const balance = await fetchOpenRouterBalance(key, this.opts.fetchImpl).catch(() => null);
    if (balance) this.balances.set("openrouter", balance);
    this.notifier.changed();
  }

  async refreshLocalModels(): Promise<void> {
    const models = await listOllamaModels(undefined, this.opts.fetchImpl).catch(() => []);
    this.registry.setLocalModels("ollama", models);
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
    await run(exe, claudeLoginArgs());
    await this.refreshClaude();
    const ok = Boolean(this.claudeAccount?.loggedIn);
    this.toast(ok ? `Signed in to Claude${this.claudeAccount?.email ? ` as ${this.claudeAccount.email}` : ""}.` : "Claude sign-in did not finish.", ok ? "success" : "warning");
    if (ok) void this.refreshUsage();
    return ok;
  }

  async logoutClaude(run: TerminalRunner): Promise<void> {
    const exe = findClaude(this.config.claudePath);
    if (!exe) return;
    await run(exe, claudeLogoutArgs());
    await this.refreshClaude();
    this.planUsage = null;
    this.toast("Signed out of Claude.", "info");
  }

  // ---- other providers -------------------------------------------------------------------------

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
    if (this.saveTimer || !this.opts.configPath) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveSession();
    }, 1500);
    this.saveTimer.unref();
  }

  /** Remembers the open tabs and their agents for `lu-minal --continue`. */
  saveSession(): void {
    if (!this.opts.configPath || !this.projects.length) return;
    const session: SavedSession = {
      active: this.activeIndex,
      projects: this.projects.map((p) => ({
        cwd: p.cwd,
        name: p.name,
        origin: p.origin,
        permissionMode: p.permissionMode,
        agents: p.agents.map((a) => ({
          name: a.name,
          role: a.role,
          label: a.label,
          model: a.model,
          sessionId: a.sessionId,
          instructions: a.instructions,
        })),
      })),
    };
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this.sessionFile(), `${JSON.stringify(session, null, 2)}\n`);
    } catch {
      // Not worth bothering the user about.
    }
  }

  /** Reopens the tabs of the last session. Returns how many came back. */
  async restoreSession(): Promise<number> {
    let saved: SavedSession;
    try {
      saved = JSON.parse(fs.readFileSync(this.sessionFile(), "utf8")) as SavedSession;
    } catch {
      return 0;
    }
    let restored = 0;
    for (const p of saved.projects ?? []) {
      if (!p.cwd || !fs.existsSync(p.cwd)) continue;
      const project = new Project(
        { cwd: p.cwd, name: p.name, origin: p.origin, permissionMode: p.permissionMode },
        this.notifier,
        this,
      );
      this.projects.push(project);
      const lead = p.agents.find((a) => a.role === "lead");
      const ordered = lead ? [lead, ...p.agents.filter((a) => a !== lead)] : p.agents;
      for (const a of ordered) {
        const agent = new Agent(
          { name: a.name, role: a.role, label: a.label ?? undefined, model: a.model, instructions: a.instructions ?? undefined },
          this.notifier,
          project.permissionMode,
        );
        agent.sessionId = a.sessionId;
        project.agents.push(agent);
        project.focusedId ??= agent.id;
        try {
          await this.launch(project, agent);
          if (a.sessionId) agent.info("Resumed the earlier conversation.");
        } catch (err) {
          agent.error(errText(err));
        }
      }
      restored++;
    }
    if (restored) {
      this.activeIndex = Math.min(Math.max(0, saved.active ?? 0), this.projects.length - 1);
      this.notifier.changed();
    }
    return restored;
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
