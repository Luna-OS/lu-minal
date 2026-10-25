# Roblox Studio

lu-minal's agents can work inside **Roblox Studio**: read the open place's tree and properties, edit
scripts and instances, select things in the Explorer, run Luau, and read Studio's output. It works the
same on **Windows, macOS and Linux** (Studio runs on Linux through [Vinegar](https://vinegarhq.org)).

Two pieces make it work:

- the **bridge**, a small HTTP server inside lu-minal on `127.0.0.1:44766` (`src/roblox/bridge.ts`);
- the **lu-minal plugin** in Studio (`roblox/LuMinal.server.luau`), which connects to the bridge,
  waits for commands, runs them and sends the results back.

```
 agent ─▶ roblox_* tool ─▶ bridge (127.0.0.1:44766) ◀── long poll ── Studio plugin ─▶ your place
                                    ▲                                   │
                                    └──────── results, Studio output ───┘
```

Studio starts every request (Studio can't accept incoming connections), so the plugin "long-polls":
it asks the bridge for work, the bridge answers as soon as an agent sends a command (or after 25
seconds with "nothing to do"), and the plugin asks again.

## Install the plugin

Run once, from a terminal:

```sh
lu-minal roblox install
```

or open `/roblox` in lu-minal and pick **Install the Studio plugin**. This writes
`LuMinal.server.luau` into Studio's local plugins folder, with your bridge port baked in. Then
**restart Studio** (or use *Plugins > Plugins Folder* and reload).

`lu-minal roblox path` prints the folder lu-minal uses:

| OS | Plugins folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Roblox\Plugins` (e.g. `C:\Users\you\AppData\Local\Roblox\Plugins`) |
| macOS | `~/Documents/Roblox/Plugins` |
| Linux (Vinegar, Flatpak) | `~/.var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio/drive_c/users/<you>/AppData/Local/Roblox/Plugins` |
| Linux (Vinegar, native) | `$XDG_DATA_HOME/vinegar/prefixes/studio/drive_c/users/<you>/AppData/Local/Roblox/Plugins` (`~/.local/share/...`) |

Set `LU_MINAL_ROBLOX_PLUGINS` to use another folder on any OS (portable installs, other Wine
setups):

```sh
LU_MINAL_ROBLOX_PLUGINS="$HOME/Games/studio/drive_c/users/me/AppData/Local/Roblox/Plugins" lu-minal roblox install
```

**Linux:** Roblox has no Linux Studio. Install Vinegar (`flatpak install flathub org.vinegarhq.Vinegar`),
start Studio through it once (that creates the Wine prefix), then run `lu-minal roblox install`.
Studio in Wine reaches `127.0.0.1` on the Linux host, so the bridge needs nothing special.

**macOS:** if the install fails with "operation not permitted", macOS is protecting `~/Documents`:
allow your terminal (Terminal, iTerm, the lu-minal app) under *System Settings > Privacy & Security >
Files and Folders*, or copy the file by hand.

### Manual install

Copy `roblox/LuMinal.server.luau` (it ships in the npm package; it's also in this repository) into the
plugins folder above, or open Studio's folder with *Plugins tab > Plugins Folder*. The file uses port
44766; for another port, edit the line `local DEFAULT_PORT = 44766` or set the port in the plugin's
Settings window.

## Connect

1. Start lu-minal (the bridge starts with it; `/roblox` shows its state).
2. In Studio, open a place, go to the **Plugins** tab and click **Connect** on the **lu-minal**
   toolbar.
3. The first time, Studio asks whether **lu-minal may send HTTP requests to `127.0.0.1`**. Allow it.
   (Denied by accident? Plugin HTTP permissions are listed under *Plugins > Manage Plugins*.)
4. Studio's output shows `[lu-minal] Connected to lu-minal on 127.0.0.1:44766.`, the lu-minal status
   bar shows `◆ studio <place>`, and agents are told that Studio is connected.

Click **Connect** again to disconnect. The **Settings** button opens a small window with the
connection state, the last error, the port, and **Connect automatically when Studio opens**.

When lu-minal isn't running, the plugin keeps retrying in the background (1 s, 2 s, 4 s, ... up to
30 s) without filling the output; it connects as soon as lu-minal starts.

Only the edit session connects: play tests (Play, Play Here, Run) don't open a second connection.

## The tools

Every tool is available to every agent, including Claude Code agents (through lu-minal's MCP server).

| Tool | What it does | Asks first? |
| --- | --- | --- |
| `roblox_status` | Is Studio connected, which place, Studio and plugin versions | no |
| `roblox_get_tree` `{ path?, depth?, maxChildren? }` | The instance tree as indented lines (from `game`: the main services) | no |
| `roblox_get_properties` `{ path, names? }` | Common properties for the class, attributes and tags | no |
| `roblox_get_script` `{ path }` | A script's source (the editor's text when it is open) | no |
| `roblox_find` `{ root?, className?, name?, limit? }` | Find by class (`IsA`) and/or name (substring or Lua pattern) | no |
| `roblox_get_selection` / `roblox_set_selection` `{ paths }` | Read or set the Explorer selection | no |
| `roblox_output` `{ limit?, errorsOnly? }` | Studio's recent output (prints, warnings, errors) | no |
| `roblox_set_script` `{ path, source }` or `{ path, oldText, newText }` | Change a script; the panel shows the diff | like a file edit |
| `roblox_create_instance` `{ className, parent, name?, properties?, attributes?, source? }` | Create a Part, Script, Folder, GUI, ... | like a file edit |
| `roblox_set_properties` `{ path, properties?, attributes? }` | Set properties (also Name, Parent, `Pivot` for models) | like a file edit |
| `roblox_delete_instance` `{ path }` | Delete an instance (never `game` or a service) | like a file edit |
| `roblox_run_luau` `{ code, timeout? }` | Run Luau; returns its prints, warnings and return values | like a command |

"Like a file edit" follows the permission mode: *edits on* runs them, *ask first* asks, *plan only*
refuses. `roblox_run_luau` is treated like a shell command: it asks unless the mode is *do
everything* (and is refused in *plan only*); the approval shows the code.

**Undo:** every change (`set_script`, `create_instance`, `set_properties`, `delete_instance`) is one
undo step in Studio (`ChangeHistoryService` recordings), so *Ctrl+Z* / *Cmd+Z* takes it back. Code
run with `roblox_run_luau` is not recorded as one step.

### Paths

Paths start at `game`, and services are found by name (also when they don't exist yet, through
`game:GetService`):

- `game.Workspace.Model.Part`, `Workspace.Model.Part`, `workspace.Model.Part`
- `ServerScriptService/Main` (slashes work too)
- `workspace.Model['Odd Name']` or `workspace.Model["Odd.Name"]` for names with spaces, dots or
  slashes

Results always use the full form (`game.Workspace['Lava Pit'].Lava`), which can be passed back as-is.

### Values

Property values are JSON and converted to the property's own type:

| Roblox type | JSON |
| --- | --- |
| number, string, bool | as is |
| `Vector3` | `[0, 5, 0]` or `{"type":"Vector3","x":0,"y":5,"z":0}` |
| `Vector2` | `[0, 1]` or `{"type":"Vector2","x":0,"y":1}` |
| `Color3` | `"#ff8800"` or `{"type":"Color3","r":1,"g":0.53,"b":0}` (0..1; values over 1 are read as 0..255) |
| `BrickColor` | `"Bright red"` |
| Enum | `"Enum.Material.Neon"` or just `"Neon"` (or the item's number) |
| `UDim` | `[scale, offset]` |
| `UDim2` | `[xScale, xOffset, yScale, yOffset]` or `{"type":"UDim2","x":{"scale":0.5,"offset":0},"y":{"scale":0,"offset":40}}` |
| `CFrame` | `{"type":"CFrame","position":[0,5,0],"rotation":[0,90,0]}` (degrees, XYZ order), `{"position":[...],"lookAt":[...]}`, or 12 components |
| `NumberRange` | `[1, 3]` or `{"type":"NumberRange","min":1,"max":3}` |
| Instance reference | a path (`"game.Workspace.Model.Root"`), `"nil"` to clear |

Reading properties returns the same tagged form, with numbers rounded to remove float noise.
Attribute values use the same tagged forms for Roblox types.

## Security

The bridge lets programs on your computer drive your Studio session, so it is locked down:

- It listens on **127.0.0.1 only** and refuses to bind anywhere else.
- Every request must carry the **`X-LuMinal-Plugin`** header. Web pages can't send a custom header
  to another origin without a CORS preflight, and the bridge never approves one (no
  `Access-Control-*` headers, `OPTIONS` gets 403).
- Requests with an **`Origin`** or **`Sec-Fetch-Site`** header (what browsers send) are refused, and so
  are requests whose **`Host`** isn't a loopback name, which stops DNS-rebinding pages.
- A plugin must say hello first and gets a random session id; polls need it.
- `roblox_run_luau` runs with plugin permissions in your Studio, so it always goes through
  lu-minal's approval (unless you chose *do everything*).

Other programs running as your user on the same computer could still talk to the bridge, as they
could to most local developer tools.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `/roblox` says "not listening: Port 44766 is already in use" | Another lu-minal (or another program) has the port. Close it, or set `roblox.port` in the config, then `lu-minal roblox install` again so the plugin uses the new port. |
| No lu-minal toolbar in Studio | The plugin isn't in the plugins folder Studio reads: check `lu-minal roblox path`, *Plugins > Plugins Folder*, and restart Studio. |
| Studio output: "Can't reach lu-minal yet (HttpError: ConnectFail ...)" | lu-minal isn't running, or runs on another port (the plugin's Settings window shows which one it uses). |
| "... allow HTTP requests for the lu-minal plugin" | The HTTP permission was denied: allow `127.0.0.1` for lu-minal under *Plugins > Manage Plugins*. |
| Agents say Studio is not connected although it is | Click Connect again; check that only one lu-minal runs. `roblox_status` pings the plugin. |
| "did not pick up ... within 30s" | Studio was busy (a long build, a modal dialog) or paused at a breakpoint. |
| `roblox_run_luau`: "loadstring is not available" | This Studio build doesn't give plugins `loadstring`; use the other tools (create or edit a script and play-test it). |
| Plugin and lu-minal versions differ | Studio's output says so on connect; run `lu-minal roblox install` and restart Studio. |

## For developers

- `roblox/LuMinal.server.luau` is the plugin's source. After editing it, run
  `node scripts/gen-roblox-plugin.mjs`, which regenerates `src/roblox/plugin-source.ts` (the plugin is
  compiled into lu-minal so the single-file binaries can install it). `--check` fails when the two
  differ; a test does the same.
- `src/roblox/protocol.ts` lists the commands with their argument and result shapes; the plugin must
  implement every one (a test checks it).
- The HTTP protocol (JSON bodies, all with the `X-LuMinal-Plugin` header):

| Request | Body | Answer |
| --- | --- | --- |
| `POST /hello` | `{ place: { name, placeId, gameId }, studioVersion, pluginVersion }` | `{ ok, session, pollTimeoutMs, pluginVersion }` |
| `GET /poll?session=<id>` | | `{ id, command, args }`, or 204 after 25 s, or 409 for an unknown session (say hello again) |
| `POST /result` | `{ id, ok, result?, error? }` | `{ ok }` (`ignored: true` when the call already timed out) |
| `POST /log` | `{ session, lines: [{ type, text, at }] }` (`type` is an `Enum.MessageType` name, `at` in ms) | `{ ok, received }` |
| `POST /bye` | `{ session }` | `{ ok }` |
| `GET /status` | | the bridge's status |

- Tests: `npx vitest run test/roblox` (the bridge over real HTTP with a fake plugin, the installer
  per OS, the plugin source, and the tools).
