// Sign-ins: Claude through Claude Code (no API key), OpenRouter in the browser, OpenCode Zen's free
// models without anything, API keys for every other provider, other coding agents (OpenCode, Gemini
// CLI over ACP) through their own CLIs, and GitHub / Forgejo for repositories.
import React from "react";
import type { Hub } from "../../core/hub.js";
import { openExternal } from "../../platform/process.js";
import type { ProviderInfo } from "../../providers/models.js";
import { normalizeInstanceUrl, forgejoTokenUrl } from "../../git/forgejo.js";
import { findGh, ghLoginArgs, githubTokenUrl } from "../../git/github.js";
import type { UiServices } from "../store.js";
import { InputDialog, MessageDialog } from "./InputDialog.js";
import { ListDialog, type ListItem } from "./ListDialog.js";

function keySource(hub: Hub, p: ProviderInfo): "auth" | "env" | null {
  if (hub.auth.secretFor(p.id)) return "auth";
  if (p.env.some((e) => process.env[e])) return "env";
  return null;
}

function providerItem(hub: Hub, p: ProviderInfo, group: string): ListItem {
  const c = hub.theme.colors;
  const connected = hub.registry.isConnected(p.id);
  let hint = "";
  let badge: ListItem["badge"];
  if (p.id === "claude-code") {
    const acc = hub.claudeAccount;
    if (!acc?.installed) {
      hint = "install Claude Code and sign in with your Claude account - no API key";
      badge = { text: "not installed", color: c.faint };
    } else if (!acc.loggedIn) {
      hint = "sign in with your Claude account (Pro / Max) - no API key";
      badge = { text: "sign in", color: c.warning };
    } else {
      hint = [acc.email, acc.plan].filter(Boolean).join(" · ") || "signed in";
      badge = { text: "✓ signed in", color: c.success };
    }
  } else if (p.kind === "acp") {
    const preset = hub.registry.acpPreset(p.id);
    hint = connected ? (preset?.signIn ?? "signs in with its own CLI") : `not installed - ${preset?.install ?? hub.registry.connectionHint(p.id)}`;
    badge = connected ? { text: "✓ installed", color: c.success } : { text: "not installed", color: c.faint };
  } else if (p.auth === "optional") {
    const src = keySource(hub, p);
    hint = src ? "key saved - free and paid models" : "free models work without a key";
    badge = { text: src ? "✓ key" : "✓ free", color: c.success };
  } else if (p.auth === "none" || p.kind === "local") {
    hint = p.baseURL ? `local server at ${p.baseURL}` : "local server";
    badge = { text: "local", color: c.accent2 };
  } else {
    const src = keySource(hub, p);
    hint = p.id === "openrouter" ? "sign in with your browser, or paste a key" : p.doc ? `API key · ${p.doc}` : "API key";
    if (src === "env") hint = `from ${p.env.find((e) => process.env[e])}`;
    badge = connected ? { text: src === "env" ? "✓ env" : "✓ key", color: c.success } : { text: "add key", color: c.faint };
    if (!p.supported) badge = { text: "unsupported", color: c.faint };
  }
  return { id: `provider:${p.id}`, label: p.name, hint, badge, group, keywords: p.id, disabled: !p.supported && p.kind !== "claude-code" };
}

export function openLoginDialog(hub: Hub, ui: UiServices, preselect?: string): void {
  ui.openDialog({ id: "login", render: (close) => <LoginDialog hub={hub} ui={ui} close={close} preselect={preselect} /> });
}

function LoginDialog({ hub, ui, close, preselect }: { hub: Hub; ui: UiServices; close: () => void; preselect?: string }) {
  const [all, setAll] = React.useState(false);
  const c = hub.theme.colors;
  const providers = hub.registry.providers();
  const featured = providers.filter((p) => p.featured);
  const agents = providers.filter((p) => !p.featured && p.kind === "acp");
  const rest = providers.filter((p) => !p.featured && p.kind !== "acp");
  const items: ListItem[] = [
    ...featured.map((p) => providerItem(hub, p, "AI providers")),
    ...(all
      ? rest.map((p) => providerItem(hub, p, `All providers (${rest.length})`))
      : [{ id: "more", label: `All providers… (${rest.length} more)`, hint: "models.dev catalog", group: "AI providers" }]),
    ...agents.map((p) => providerItem(hub, p, "Coding agents")),
    { id: "git:github", label: "GitHub", hint: "open repositories in new tabs", group: "Repositories", badge: hub.auth.secretFor("github") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? { text: "✓ token", color: c.success } : findGh() ? { text: "gh", color: c.faint } : undefined },
    ...hub.config.forgejo.map((f) => ({
      id: `git:forgejo:${f.url}`,
      label: f.name,
      hint: `Forgejo · ${f.url}`,
      group: "Repositories",
      badge: hub.auth.secretFor(`forgejo:${hostOf(f.url)}`) ? { text: "✓ token", color: c.success } : undefined,
    })),
    { id: "git:forgejo-add", label: "Add a Forgejo / Gitea instance…", group: "Repositories" },
  ];
  return (
    <ListDialog
      theme={hub.theme}
      title="Sign in"
      subtitle="d signs out"
      items={items}
      initialId={preselect ? `provider:${preselect}` : undefined}
      onCancel={close}
      hints="enter sign in · d sign out · type to filter · esc close"
      onKey={(input, _key, item) => {
        if (input === "d" && item) {
          void signOut(hub, ui, item.id);
          return true;
        }
        return false;
      }}
      onSelect={(item) => {
        if (item.id === "more") return setAll(true);
        void signIn(hub, ui, item.id);
      }}
    />
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function signOut(hub: Hub, ui: UiServices, id: string): Promise<void> {
  if (id === "provider:claude-code") return hub.logoutClaude(ui.runInTerminal);
  if (id.startsWith("provider:") && hub.registry.provider(id.slice("provider:".length))?.kind === "acp") {
    hub.toast("This agent signs out in its own CLI (e.g. opencode auth logout).", "info");
    return;
  }
  if (id.startsWith("provider:")) return hub.removeKey(id.slice("provider:".length));
  if (id === "git:github") {
    hub.auth.remove("github");
    hub.toast("Removed the GitHub token.", "info");
    return;
  }
  if (id.startsWith("git:forgejo:")) {
    hub.auth.remove(`forgejo:${hostOf(id.slice("git:forgejo:".length))}`);
    hub.toast("Removed the Forgejo token.", "info");
  }
}

async function signIn(hub: Hub, ui: UiServices, id: string): Promise<void> {
  if (id === "provider:claude-code") {
    await hub.loginClaude(ui.runInTerminal);
    return;
  }
  if (id === "provider:openrouter") return openRouterChoice(hub, ui);
  if (id.startsWith("provider:")) {
    const p = hub.registry.provider(id.slice("provider:".length));
    if (!p) return;
    if (p.kind === "acp") {
      await hub.loginAcp(p.id, ui.runInTerminal);
      return;
    }
    if (p.kind === "local" || p.auth === "none") {
      hub.toast(`${p.name} needs no sign-in - start its server and pick a model.`, "info");
      if (p.id === "ollama") void hub.refreshLocalModels();
      return;
    }
    return askKey(hub, ui, p);
  }
  if (id === "git:github") return githubChoice(hub, ui);
  if (id === "git:forgejo-add") return addForgejo(hub, ui);
  if (id.startsWith("git:forgejo:")) {
    const url = id.slice("git:forgejo:".length);
    return askForgejoToken(hub, ui, url);
  }
}

function askKey(hub: Hub, ui: UiServices, p: ProviderInfo): void {
  const lines = [
    `Paste your ${p.name} API key. It is saved in lu-minal's auth.json (only readable by you).`,
    p.env.length ? `You can also set ${p.env.join(" or ")} instead.` : "",
    p.auth === "optional" ? "Without a key, the free models keep working." : "",
    p.doc ? `Get a key: ${p.doc}` : "",
  ].filter(Boolean);
  ui.openDialog({
    id: `key-${p.id}`,
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title={`${p.name} API key`}
        lines={lines}
        mask
        placeholder="sk-…"
        onCancel={close}
        onOpen={p.doc ? () => void openExternal(p.doc!) : undefined}
        openHint="open the key page"
        onSubmit={(key) => {
          close();
          hub.setApiKey(p.id, key);
        }}
      />
    ),
  });
}

function openRouterChoice(hub: Hub, ui: UiServices): void {
  const p = hub.registry.provider("openrouter");
  ui.openDialog({
    id: "openrouter",
    render: (close) => (
      <ListDialog
        theme={hub.theme}
        title="OpenRouter"
        subtitle="hundreds of models, many free"
        filter={false}
        items={[
          { id: "browser", label: "Sign in with the browser", hint: "creates a key for lu-minal - nothing to copy" },
          { id: "key", label: "Paste an API key", hint: "openrouter.ai/keys" },
        ]}
        onCancel={close}
        onSelect={(item) => {
          close();
          if (item.id === "key" && p) return askKey(hub, ui, p);
          void browserLogin(hub, ui);
        }}
      />
    ),
  });
}

async function browserLogin(hub: Hub, ui: UiServices): Promise<void> {
  let login;
  try {
    login = await hub.loginOpenRouter();
  } catch (err) {
    hub.toast(`Could not start the sign-in: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  const opened = await openExternal(login.url);
  const c = hub.theme.colors;
  const id = "openrouter-wait";
  let closeFn = null as (() => void) | null;
  login.result.then(
    () => closeFn?.(),
    () => closeFn?.(),
  );
  ui.openDialog({
    id,
    render: (close) => {
      closeFn = close;
      return (
        <MessageDialog
          theme={hub.theme}
          title="Signing in to OpenRouter"
          lines={[
            opened ? "Your browser opened OpenRouter. Approve lu-minal there." : "Open this link in your browser and approve lu-minal:",
            { text: login.url, color: c.accent2 },
            "",
            "Waiting for the browser… (esc cancels)",
          ]}
          hints="esc cancel"
          onClose={() => {
            login.cancel();
            close();
          }}
        />
      );
    },
  });
}

function githubChoice(hub: Hub, ui: UiServices): void {
  const gh = findGh();
  ui.openDialog({
    id: "github",
    render: (close) => (
      <ListDialog
        theme={hub.theme}
        title="GitHub"
        filter={false}
        items={[
          ...(gh ? [{ id: "gh", label: "Sign in with the GitHub CLI", hint: "gh auth login in this terminal" }] : []),
          { id: "token", label: "Paste a personal access token", hint: "scopes: repo, read:org" },
          ...(gh ? [] : [{ id: "nogh", label: "Install the GitHub CLI for a browser sign-in", hint: "cli.github.com" }]),
        ]}
        onCancel={close}
        onSelect={async (item) => {
          close();
          if (item.id === "gh" && gh) {
            await ui.runInTerminal(gh, ghLoginArgs());
            hub.toast("GitHub CLI sign-in finished.", "info");
            return;
          }
          if (item.id === "nogh") {
            void openExternal("https://cli.github.com/");
            return;
          }
          ui.openDialog({
            id: "github-token",
            render: (closeToken) => (
              <InputDialog
                theme={hub.theme}
                title="GitHub token"
                lines={["Paste a GitHub personal access token (classic: repo + read:org, or fine-grained with Contents: read)."]}
                mask
                onCancel={closeToken}
                onOpen={() => void openExternal(githubTokenUrl())}
                openHint="create a token"
                onSubmit={(token) => {
                  closeToken();
                  hub.auth.set("github", { type: "token", token });
                  hub.toast("Saved the GitHub token.", "success");
                }}
              />
            ),
          });
        }}
      />
    ),
  });
}

function askForgejoToken(hub: Hub, ui: UiServices, url: string): void {
  ui.openDialog({
    id: "forgejo-token",
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title={`Token for ${url}`}
        lines={[
          "Paste an access token (Settings → Applications → Generate token, scope: read repository).",
          "Without a token you can still open public repositories.",
        ]}
        mask
        onCancel={close}
        onOpen={() => void openExternal(forgejoTokenUrl(url))}
        openHint="open the token page"
        onSubmit={(token) => {
          close();
          hub.auth.set(`forgejo:${hostOf(url)}`, { type: "token", token });
          hub.toast(`Saved the token for ${hostOf(url)}.`, "success");
        }}
      />
    ),
  });
}

function addForgejo(hub: Hub, ui: UiServices): void {
  ui.openDialog({
    id: "forgejo-add",
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title="Add a Forgejo / Gitea instance"
        lines={["The address of the instance, e.g. codeberg.org or git.example.com."]}
        placeholder="https://"
        onCancel={close}
        onSubmit={(value) => {
          close();
          const url = normalizeInstanceUrl(value);
          if (!hub.config.forgejo.some((f) => f.url === url)) {
            hub.config.forgejo.push({ name: hostOf(url), url });
            hub.persistConfig();
          }
          askForgejoToken(hub, ui, url);
        }}
      />
    ),
  });
}
