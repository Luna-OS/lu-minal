// Where lu-minal keeps its files on Windows, macOS and Linux.
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheDir, configDir, defaultProjectsDir, expandHome, isMac, isWindows, stateDir, tildify } from "../../src/platform/paths.js";

const platform = process.platform;
const home = path.join(os.tmpdir(), "lu-minal-home-test", "ada");

beforeEach(() => {
  // home() reads LU_MINAL_HOME_DIR from process.env (not from the env argument).
  vi.stubEnv("LU_MINAL_HOME_DIR", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform flags", () => {
  it("match process.platform", () => {
    expect(isWindows).toBe(platform === "win32");
    expect(isMac).toBe(platform === "darwin");
  });
});

describe("LU_MINAL_HOME", () => {
  it("puts everything under one folder (tests, portable installs)", () => {
    const env = { LU_MINAL_HOME: path.join(home, "portable"), APPDATA: "x", XDG_CONFIG_HOME: "y" };
    expect(configDir(env)).toBe(path.join(home, "portable", "config"));
    expect(cacheDir(env)).toBe(path.join(home, "portable", "cache"));
    expect(stateDir(env)).toBe(path.join(home, "portable", "state"));
  });
});

describe.runIf(platform === "win32")("on Windows", () => {
  it("keeps settings in %APPDATA% and the rest in %LOCALAPPDATA%", () => {
    const env = { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" };
    expect(configDir(env)).toBe("C:\\Users\\Ada\\AppData\\Roaming\\lu-minal");
    expect(cacheDir(env)).toBe("C:\\Users\\Ada\\AppData\\Local\\lu-minal\\cache");
    expect(stateDir(env)).toBe("C:\\Users\\Ada\\AppData\\Local\\lu-minal\\state");
  });

  it("falls back to the profile folder when the variables are missing", () => {
    expect(configDir({})).toBe(path.join(home, "AppData", "Roaming", "lu-minal"));
    expect(cacheDir({})).toBe(path.join(home, "AppData", "Local", "lu-minal", "cache"));
    expect(stateDir({})).toBe(path.join(home, "AppData", "Local", "lu-minal", "state"));
  });
});

describe.runIf(platform === "darwin")("on macOS", () => {
  it("uses ~/.config for settings and ~/Library for cache and state", () => {
    expect(configDir({})).toBe(path.join(home, ".config", "lu-minal"));
    expect(cacheDir({})).toBe(path.join(home, "Library", "Caches", "lu-minal"));
    expect(stateDir({})).toBe(path.join(home, "Library", "Application Support", "lu-minal"));
  });

  it("honours XDG_CONFIG_HOME for settings only", () => {
    const env = { XDG_CONFIG_HOME: "/xdg/config", XDG_CACHE_HOME: "/xdg/cache", XDG_STATE_HOME: "/xdg/state" };
    expect(configDir(env)).toBe("/xdg/config/lu-minal");
    expect(cacheDir(env)).toBe(path.join(home, "Library", "Caches", "lu-minal"));
    expect(stateDir(env)).toBe(path.join(home, "Library", "Application Support", "lu-minal"));
  });
});

describe.runIf(platform !== "win32" && platform !== "darwin")("on Linux", () => {
  it("follows the XDG base directories", () => {
    const env = { XDG_CONFIG_HOME: "/xdg/config", XDG_CACHE_HOME: "/xdg/cache", XDG_STATE_HOME: "/xdg/state" };
    expect(configDir(env)).toBe("/xdg/config/lu-minal");
    expect(cacheDir(env)).toBe("/xdg/cache/lu-minal");
    expect(stateDir(env)).toBe("/xdg/state/lu-minal");
  });

  it("uses the XDG defaults under the home folder", () => {
    expect(configDir({})).toBe(path.join(home, ".config", "lu-minal"));
    expect(cacheDir({})).toBe(path.join(home, ".cache", "lu-minal"));
    expect(stateDir({})).toBe(path.join(home, ".local", "state", "lu-minal"));
  });

  it("treats an empty variable as unset", () => {
    expect(configDir({ XDG_CONFIG_HOME: "" })).toBe(path.join(home, ".config", "lu-minal"));
  });
});

describe("defaultProjectsDir", () => {
  it("is a folder in the home folder", () => {
    expect(defaultProjectsDir()).toBe(path.join(home, "lu-minal-projects"));
  });
});

describe("tildify", () => {
  it("shortens the home folder and paths inside it", () => {
    expect(tildify(home)).toBe("~");
    expect(tildify(path.join(home, "code", "app"))).toBe(`~${path.sep}${path.join("code", "app")}`);
  });

  it("leaves other paths alone, including look-alike prefixes", () => {
    const outside = path.join(os.tmpdir(), "elsewhere");
    expect(tildify(outside)).toBe(outside);
    expect(tildify(`${home}-other${path.sep}x`)).toBe(`${home}-other${path.sep}x`);
  });
});

describe("expandHome", () => {
  it("expands ~ with either separator", () => {
    expect(expandHome("~")).toBe(home);
    expect(expandHome("~/code/app")).toBe(path.join(home, "code", "app"));
    expect(expandHome("~\\code\\app")).toBe(path.join(home, "code\\app"));
  });

  it("leaves everything else alone", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("relative/~")).toBe("relative/~");
    expect(expandHome("~user/x")).toBe("~user/x");
  });

  it("round-trips with tildify", () => {
    const p = path.join(home, "projects", "moon");
    expect(expandHome(tildify(p))).toBe(p);
  });
});
