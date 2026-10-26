// React's production build for `node dist/cli.js` too, without leaking NODE_ENV to the programs
// lu-minal starts.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productionForReact } from "../../src/production.js";

describe("productionForReact", () => {
  it("sets NODE_ENV for React's import and takes it out again", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    const restore = productionForReact(env);
    expect(env.NODE_ENV).toBe("production");
    restore();
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("leaves a NODE_ENV that was set alone", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
    const restore = productionForReact(env);
    expect(env.NODE_ENV).toBe("development");
    restore();
    expect(env.NODE_ENV).toBe("development");
  });
});

describe("the CLI", () => {
  /** Runs `lu-minal --version` from the sources and reads which React builds it loaded. */
  function reactBuilds(nodeEnv: string | undefined): { loaded: string[]; nodeEnv: string | null } {
    const root = path.resolve(import.meta.dirname, "../..");
    const env = { ...process.env };
    delete env.NODE_ENV;
    if (nodeEnv) env.NODE_ENV = nodeEnv;
    const res = spawnSync(
      process.execPath,
      ["--require", path.join(root, "test/fixtures/report-react-build.cjs"), "--import", "tsx", path.join(root, "src/cli.tsx"), "--version"],
      { cwd: root, env, encoding: "utf8", timeout: 30_000 },
    );
    const line = /REACT-BUILDS (.*)/.exec(res.stderr)?.[1];
    if (!line) throw new Error(`no report: ${res.stderr}`);
    return JSON.parse(line) as { loaded: string[]; nodeEnv: string | null };
  }

  it("loads React's production build without NODE_ENV, and leaves no NODE_ENV behind", () => {
    expect(reactBuilds(undefined)).toEqual({ loaded: ["react-reconciler:production", "react:production"], nodeEnv: null });
  }, 30_000);

  it("keeps the development build when asked for", () => {
    expect(reactBuilds("development").loaded).toEqual(["react-reconciler:development", "react:development"]);
  }, 30_000);
});
