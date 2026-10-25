// The Roblox Studio bridge as the rest of lu-minal sees it. The bridge (src/roblox/bridge.ts) is a
// small HTTP server on 127.0.0.1; the lu-minal Studio plugin (roblox/LuMinal.server.luau) long-polls
// it for commands and posts the results back.

export interface RobloxStatus {
  /** The HTTP server is up. */
  listening: boolean;
  port: number;
  /** A Studio plugin has polled within the last few seconds. */
  connected: boolean;
  /** The open place, as the plugin reports it. */
  place: { name: string; placeId: number; gameId: number } | null;
  studioVersion: string | null;
  lastSeen: number | null;
  /** Why the server is not listening (port in use, disabled). */
  error: string | null;
}

export interface RobloxLogLine {
  at: number;
  /** Enum.MessageType name: "MessageOutput" | "MessageInfo" | "MessageWarning" | "MessageError". */
  type: string;
  text: string;
}

export interface RobloxApi {
  status(): RobloxStatus;
  /**
   * Sends one command to the plugin and waits for its result. Rejects when no plugin is connected,
   * on timeout, or with the plugin's error message.
   */
  call<T = unknown>(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** The newest lines of Studio's output (LogService), oldest first. */
  output(limit?: number): RobloxLogLine[];
  /** Called whenever the status or the output changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
