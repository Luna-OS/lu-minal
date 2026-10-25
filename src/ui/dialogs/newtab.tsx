// A new tab: this folder, another folder, a repository from GitHub or a Forgejo instance (cloned
// into the projects folder), a new empty project, or a recent folder.
import fs from "node:fs";
import path from "node:path";
import React from "react";
import type { Hub } from "../../core/hub.js";
import { cloneRepo, createEmptyProject } from "../../git/clone.js";
import { repoHosts } from "../../git/index.js";
import type { RepoHost, RepoInfo } from "../../git/types.js";
import { expandHome, tildify } from "../../platform/paths.js";
import { formatAgo } from "../format.js";
import type { UiServices } from "../store.js";
import { InputDialog, MessageDialog } from "./InputDialog.js";
import { ListDialog, type ListItem } from "./ListDialog.js";
import { openLoginDialog } from "./login.js";

async function open(hub: Hub, cwd: string, origin?: string): Promise<void> {
  try {
    await hub.openProject({ cwd, origin });
  } catch (err) {
    hub.toast(err instanceof Error ? err.message : String(err), "error");
  }
}

export function openNewTabDialog(hub: Hub, ui: UiServices): void {
  const hosts = repoHosts(hub.config, hub.auth);
  const cwd = process.cwd();
  const openDirs = new Set(hub.projects.map((p) => p.cwd));
  const items: ListItem[] = [];
  if (!openDirs.has(cwd)) items.push({ id: `dir:${cwd}`, label: "This folder", hint: tildify(cwd), group: "Open" });
  items.push({ id: "folder", label: "A folder…", hint: "type a path", group: "Open" });
  for (const host of hosts) {
    items.push({ id: `host:${host.instance}`, label: `${host.label} repository…`, hint: host.instance.replace(/^https?:\/\//, ""), group: "Clone" });
  }
  items.push({ id: "empty", label: "New empty project…", hint: tildify(hub.config.projectsDir), group: "Create" });
  for (const dir of hub.config.recent.filter((d) => !openDirs.has(d)).slice(0, 8)) {
    if (fs.existsSync(dir)) items.push({ id: `dir:${dir}`, label: path.basename(dir), hint: tildify(dir), group: "Recent" });
  }
  ui.openDialog({
    id: "newtab",
    render: (close) => (
      <ListDialog
        theme={hub.theme}
        title="New tab"
        subtitle="one project per tab"
        items={items}
        onCancel={close}
        onSelect={(item) => {
          if (item.id.startsWith("dir:")) {
            close();
            void open(hub, item.id.slice(4));
          } else if (item.id === "folder") {
            askFolder(hub, ui, close);
          } else if (item.id === "empty") {
            askEmpty(hub, ui, close);
          } else if (item.id.startsWith("host:")) {
            const host = hosts.find((h) => `host:${h.instance}` === item.id);
            if (host) openRepoList(hub, ui, host, close);
          }
        }}
      />
    ),
  });
}

function askFolder(hub: Hub, ui: UiServices, closeParent: () => void): void {
  ui.openDialog({
    id: "folder",
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title="Open a folder"
        lines={["The folder to work in (~ works)."]}
        initial={tildify(process.cwd()) + path.sep}
        onCancel={close}
        onSubmit={(value) => {
          const dir = path.resolve(expandHome(value));
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            hub.toast(`Not a folder: ${dir}`, "warning");
            return;
          }
          close();
          closeParent();
          void open(hub, dir);
        }}
      />
    ),
  });
}

function askEmpty(hub: Hub, ui: UiServices, closeParent: () => void): void {
  ui.openDialog({
    id: "empty",
    render: (close) => (
      <InputDialog
        theme={hub.theme}
        title="New empty project"
        lines={[`A new folder in ${tildify(hub.config.projectsDir)} (with git init when Git is installed).`]}
        placeholder="my-project"
        onCancel={close}
        onSubmit={async (name) => {
          close();
          closeParent();
          try {
            const dir = await createEmptyProject(hub.config.projectsDir, name.replace(/[\\/:*?"<>|]+/g, "-"));
            await open(hub, dir);
          } catch (err) {
            hub.toast(err instanceof Error ? err.message : String(err), "error");
          }
        }}
      />
    ),
  });
}

function repoItem(r: RepoInfo): ListItem {
  const bits = [r.private ? "private" : "", r.fork ? "fork" : "", r.language ?? "", r.updatedAt ? formatAgo(Date.parse(r.updatedAt)) : ""].filter(Boolean);
  return {
    id: r.fullName,
    label: r.fullName,
    hint: [r.description ?? "", bits.join(" · ")].filter(Boolean).join(" — "),
  };
}

function openRepoList(hub: Hub, ui: UiServices, host: RepoHost, closeParent: () => void): void {
  ui.openDialog({
    id: `repos-${host.instance}`,
    render: (close) => <RepoList hub={hub} ui={ui} host={host} close={close} closeParent={closeParent} />,
  });
}

function RepoList({ hub, ui, host, close, closeParent }: { hub: Hub; ui: UiServices; host: RepoHost; close: () => void; closeParent: () => void }) {
  const [query, setQuery] = React.useState("");
  const [repos, setRepos] = React.useState<RepoInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [account, setAccount] = React.useState<string>("");

  React.useEffect(() => {
    let live = true;
    host
      .account()
      .then((a) => live && setAccount(a.signedIn ? `signed in as ${a.login ?? "?"}${a.via === "gh" ? " (gh)" : ""}` : "public repositories · ctrl+l to sign in"))
      .catch(() => live && setAccount(""));
    return () => {
      live = false;
    };
  }, [host]);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      host
        .listRepos({ query, perPage: 100 })
        .then((list) => {
          if (!live) return;
          setRepos(list);
          setError(null);
        })
        .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
        .finally(() => live && setLoading(false));
    }, query ? 300 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [host, query]);

  return (
    <ListDialog
      theme={hub.theme}
      title={`${host.label} repositories`}
      subtitle={account}
      items={repos.map(repoItem)}
      onQuery={setQuery}
      loading={loading}
      error={error}
      empty={query ? "No repository matches." : "No repositories found."}
      placeholder="Search repositories"
      onCancel={close}
      onKey={(input, key) => {
        if (key.ctrl && input === "l") {
          openLoginDialog(hub, ui);
          return true;
        }
        return false;
      }}
      onSelect={(item) => {
        const repo = repos.find((r) => r.fullName === item.id);
        if (!repo) return;
        close();
        closeParent();
        void cloneAndOpen(hub, ui, host, repo);
      }}
    />
  );
}

async function cloneAndOpen(hub: Hub, ui: UiServices, host: RepoHost, repo: RepoInfo): Promise<void> {
  const controller = new AbortController();
  let progress = "Starting…";
  let closeFn = null as (() => void) | null;
  ui.openDialog({
    id: "clone",
    render: (close) => {
      closeFn = close;
      return (
        <MessageDialog
          theme={hub.theme}
          title={`Cloning ${repo.fullName}`}
          lines={[`into ${tildify(hub.config.projectsDir)}`, "", { text: progress, color: hub.theme.colors.accent2 }]}
          hints="esc cancel"
          onClose={() => {
            controller.abort();
            close();
          }}
        />
      );
    },
  });
  try {
    const gitConfig = await host.gitAuthConfig();
    const { dir, existed } = await cloneRepo(repo, {
      destRoot: hub.config.projectsDir,
      gitConfig,
      signal: controller.signal,
      onProgress: (p) => {
        progress = p.line;
        hub.notifier.changed();
      },
    });
    closeFn?.();
    if (existed) hub.toast(`${repo.fullName} was already cloned - opening it.`, "info");
    await open(hub, dir, `${host.kind}:${repo.fullName}`);
  } catch (err) {
    closeFn?.();
    if (!controller.signal.aborted) hub.toast(err instanceof Error ? err.message : String(err), "error");
  }
}
