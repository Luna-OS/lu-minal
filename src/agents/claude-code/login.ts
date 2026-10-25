// Installing Claude Code and signing in to it. Both run in the real terminal (the UI steps aside
// meanwhile): the official installer, then `claude auth login`, which opens the browser for the
// Claude account. lu-minal never sees the login's tokens.

/** Where to read about Claude Code. */
export const CLAUDE_DOCS_URL = "https://docs.claude.com/en/docs/claude-code/overview";

/** The official installer scripts. */
export const CLAUDE_INSTALL_URLS = {
  windows: "https://claude.ai/install.ps1",
  unix: "https://claude.ai/install.sh",
} as const;

export interface InstallCommand {
  /** The program to run ("powershell" or "bash"; find it with findProgram). */
  exe: string;
  args: string[];
  /** The command as the user would type it, for messages. */
  display: string;
}

/**
 * The official Claude Code installer for this platform: PowerShell's `irm … | iex` on Windows,
 * `curl … | bash` on macOS and Linux. It installs the native build into ~/.local/bin.
 */
export function claudeInstallCommand(platform: NodeJS.Platform = process.platform): InstallCommand {
  if (platform === "win32") {
    const script = `irm ${CLAUDE_INSTALL_URLS.windows} | iex`;
    return {
      exe: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      display: script,
    };
  }
  const script = `curl -fsSL ${CLAUDE_INSTALL_URLS.unix} | bash`;
  return { exe: "bash", args: ["-c", script], display: script };
}

/** `claude auth login`: signs in with the Claude account in the browser. */
export function claudeLoginArgs(): string[] {
  return ["auth", "login"];
}

/** `claude auth logout`. */
export function claudeLogoutArgs(): string[] {
  return ["auth", "logout"];
}
