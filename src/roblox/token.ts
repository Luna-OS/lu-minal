// The secret lu-minal shares with its Roblox Studio plugin: 32 random bytes (hex) in the config
// dir, created once with mode 0600 and baked into the plugin by the installer. The bridge refuses
// requests without it (src/roblox/bridge.ts), so no other program on this machine can pose as
// Studio. It is not a sign-in: reinstalling the plugin after deleting the file makes a new one.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../platform/files.js";
import { configDir } from "../platform/paths.js";

/** The token file in a config dir. */
export function bridgeTokenFile(dir = configDir()): string {
  return path.join(dir, "roblox-token");
}

/** The bridge token from `file`, created (0600) when there is none yet or it isn't valid. */
export function bridgeToken(file = bridgeTokenFile()): string {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(text)) return text;
  } catch {
    // none yet
  }
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomicSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}
