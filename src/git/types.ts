// Repository hosts a new tab can open a project from: GitHub and any Forgejo / Gitea instance
// (Codeberg by default).

export type RepoHostKind = "github" | "forgejo";

export interface RepoInfo {
  host: RepoHostKind;
  /** The host's web base URL: "https://github.com", "https://codeberg.org". */
  instance: string;
  /** "owner/name". */
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  /** HTTPS clone URL. */
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string | null;
  /** ISO time of the last push / update. */
  updatedAt: string | null;
  stars: number;
  language: string | null;
}

export interface RepoQuery {
  /** Filters by name (server side when the host can search). */
  query?: string;
  page?: number;
  perPage?: number;
}

export interface RepoHostAccount {
  signedIn: boolean;
  login: string | null;
  /** How the host is reached: "gh" (GitHub CLI), "token", or "anonymous". */
  via: "gh" | "token" | "anonymous";
}

export interface RepoHost {
  kind: RepoHostKind;
  /** "GitHub", "Codeberg", "My Forgejo". */
  label: string;
  instance: string;
  account(): Promise<RepoHostAccount>;
  /** The signed-in user's repositories, or public search results when anonymous. */
  listRepos(query: RepoQuery): Promise<RepoInfo[]>;
  /**
   * Extra `git -c` options for cloning this host's private repositories without writing the token
   * into the clone's config, e.g. ["http.extraHeader=Authorization: Basic ..."]. Empty when none.
   */
  gitAuthConfig(): Promise<string[]>;
}

export interface CloneProgress {
  /** "Receiving objects:  42% (420/1000)". */
  line: string;
  percent: number | null;
}
