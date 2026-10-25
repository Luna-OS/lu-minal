--!strict
--[[
	lu-minal - Roblox Studio plugin

	Connects Roblox Studio to lu-minal, the multi-agent coding terminal, so its agents can read the
	place's tree, edit scripts and instances, run Luau and read the output.

	How it works: lu-minal runs a small HTTP server on 127.0.0.1 (the "bridge"). This plugin says
	hello, then long-polls GET /poll for commands, runs each one in pcall and posts the answer to
	/result. Studio's output (LogService.MessageOut) goes to /log in batches. Every request carries
	the X-LuMinal-Plugin header; the bridge refuses anything else.

	Install: run "lu-minal roblox install" (it writes this file into Studio's Plugins folder with
	your port), restart Studio, allow HTTP requests to localhost when Studio asks, and click
	"Connect" on the lu-minal toolbar. Docs: https://github.com/Luna-OS/lu-minal/blob/main/docs/roblox.md

	This file is generated into src/roblox/plugin-source.ts by scripts/gen-roblox-plugin.mjs;
	edit this file, then run "node scripts/gen-roblox-plugin.mjs".
]]

local PLUGIN_VERSION = "0.1.0"
-- The bridge's port. "lu-minal roblox install" writes the configured port here.
local DEFAULT_PORT = 44766
local HOST = "127.0.0.1"
-- Lines the plugin prints itself; they are not sent back to lu-minal.
local LOG_PREFIX = "[lu-minal]"

local RunService = game:GetService("RunService")
if not RunService:IsEdit() then
	-- Plugins load into play-test sessions too; only the edit session talks to lu-minal.
	return
end

local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")

local ScriptEditorService: any = nil
pcall(function()
	ScriptEditorService = game:GetService("ScriptEditorService")
end)

local SETTING_PORT = "luminal.port"
local SETTING_AUTO_CONNECT = "luminal.autoConnect"

local MAX_BACKOFF_SECONDS = 30
local LOG_FLUSH_SECONDS = 1
local MAX_LOG_BUFFER = 500
local MAX_RUN_OUTPUT_LINES = 500
local MAX_RUN_OUTPUT_CHARS = 60000
local MAX_TREE_NODES = 2000

-- Services that agents care about, in Explorer's order; get_tree on game lists these.
local COMMON_SERVICES = {
	"Workspace",
	"Players",
	"Lighting",
	"MaterialService",
	"ReplicatedFirst",
	"ReplicatedStorage",
	"ServerScriptService",
	"ServerStorage",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"Teams",
	"SoundService",
	"TextChatService",
	"Chat",
	"LocalizationService",
	"TestService",
}

-- Services that a plugin can't (or shouldn't) search through.
local SKIP_SERVICES = {
	CoreGui = true,
	CorePackages = true,
	RobloxPluginGuiService = true,
	PluginGuiService = true,
	RobloxReplicatedStorage = true,
	PluginDebugService = true,
}

--------------------------------------------------------------------------------------------------
-- Small helpers
--------------------------------------------------------------------------------------------------

local function info(message: string)
	print(LOG_PREFIX .. " " .. message)
end

local function warnUser(message: string)
	warn(LOG_PREFIX .. " " .. message)
end

local function trim(text: string): string
	return (string.gsub(text, "^%s*(.-)%s*$", "%1"))
end

local function nowMs(): number
	local ok, value = pcall(function()
		return DateTime.now().UnixTimestampMillis
	end)
	if ok then
		return value
	end
	return os.time() * 1000
end

local function clampInt(value: any, default: number, low: number, high: number): number
	local n = tonumber(value)
	if n == nil then
		return default
	end
	return math.clamp(math.floor(n), low, high)
end

local function errorText(err: any): string
	local text = tostring(err)
	-- Drop this plugin's own "Plugin.LuMinal:123: " prefix; the message is what matters.
	text = string.gsub(text, "^[^\n]-LuMinal[%w%._]*:%d+: ", "")
	return text
end

local function encodeJson(value: any): (boolean, string)
	local ok, result = pcall(function()
		return HttpService:JSONEncode(value)
	end)
	if ok then
		return true, result
	end
	return false, tostring(result)
end

local function getSetting(key: string): any
	local ok, value = pcall(function()
		return plugin:GetSetting(key)
	end)
	if ok then
		return value
	end
	return nil
end

local function setSetting(key: string, value: any)
	pcall(function()
		plugin:SetSetting(key, value)
	end)
end

-- The port: a value saved in the settings window wins, unless the plugin was reinstalled with a
-- different default since (then the new default is what the user configured in lu-minal).
local function configuredPort(): number
	local saved = getSetting(SETTING_PORT)
	if type(saved) == "table" and type(saved.port) == "number" and saved.default == DEFAULT_PORT then
		return saved.port
	end
	return DEFAULT_PORT
end

--------------------------------------------------------------------------------------------------
-- Paths: "game.Workspace.Model.Part", "Workspace/Model/Part", "workspace.Model['Odd Name']"
--------------------------------------------------------------------------------------------------

local function parsePath(path: string): { string }
	local segments: { string } = {}
	local current = ""
	local i = 1
	local n = #path
	local function push()
		if current ~= "" then
			table.insert(segments, current)
		end
		current = ""
	end
	while i <= n do
		local c = string.sub(path, i, i)
		if c == "." or c == "/" then
			push()
			i += 1
		elseif c == "[" then
			push()
			local quote = string.sub(path, i + 1, i + 1)
			if quote == "'" or quote == '"' then
				local j = i + 2
				local name = ""
				local closed = false
				while j <= n do
					local d = string.sub(path, j, j)
					if d == "\\" and j < n then
						name ..= string.sub(path, j + 1, j + 1)
						j += 2
					elseif d == quote then
						closed = true
						break
					else
						name ..= d
						j += 1
					end
				end
				if not closed or string.sub(path, j + 1, j + 1) ~= "]" then
					error("Bad path (unclosed [" .. quote .. "...]): " .. path, 0)
				end
				table.insert(segments, name)
				i = j + 2
			else
				local close = string.find(path, "]", i + 1, true)
				if not close then
					error("Bad path (unclosed [): " .. path, 0)
				end
				table.insert(segments, string.sub(path, i + 1, close - 1))
				i = close + 1
			end
		else
			current ..= c
			i += 1
		end
	end
	push()
	return segments
end

local function pathSegment(name: string): string
	if string.match(name, "^[%a_][%w_]*$") then
		return "." .. name
	end
	local escaped = (string.gsub(name, "\\", "\\\\"))
	escaped = (string.gsub(escaped, "'", "\\'"))
	return "['" .. escaped .. "']"
end

local function pathOf(instance: Instance): string
	if instance == game then
		return "game"
	end
	local parts: { string } = {}
	local current: Instance? = instance
	while current ~= nil and current ~= game do
		table.insert(parts, 1, pathSegment(current.Name))
		current = current.Parent
	end
	if current == nil then
		return "nil" .. table.concat(parts)
	end
	return "game" .. table.concat(parts)
end

local function childNames(parent: Instance, limit: number): string
	local names: { string } = {}
	local children = parent:GetChildren()
	for index, child in children do
		if index > limit then
			table.insert(names, "... " .. tostring(#children - limit) .. " more")
			break
		end
		table.insert(names, child.Name)
	end
	if #names == 0 then
		return "it has no children"
	end
	return "its children: " .. table.concat(names, ", ")
end

local function findService(name: string): Instance?
	if string.lower(name) == "workspace" then
		return workspace
	end
	local found = game:FindFirstChild(name)
	if found then
		return found
	end
	local ok, service = pcall(function()
		return game:GetService(name :: any)
	end)
	if ok and typeof(service) == "Instance" then
		return service
	end
	local lower = string.lower(name)
	for _, child in game:GetChildren() do
		local okName, childName = pcall(function()
			return child.Name
		end)
		if okName and string.lower(childName) == lower then
			return child
		end
	end
	return nil
end

local function resolvePath(path: any): Instance
	if typeof(path) == "Instance" then
		return path
	end
	if type(path) ~= "string" or trim(path) == "" then
		error('Expected a path such as "game.Workspace.Part" or "Workspace/Model/Part".', 0)
	end
	local segments = parsePath(trim(path))
	local current: Instance = game
	local first = 1
	local head = segments[1]
	if head == "game" or head == "Game" or head == "DataModel" then
		first = 2
	end
	for index = first, #segments do
		local name = segments[index]
		local nextInstance: Instance? = nil
		if current == game then
			nextInstance = findService(name)
		else
			nextInstance = current:FindFirstChild(name)
		end
		if nextInstance == nil then
			error("No '" .. name .. "' in " .. pathOf(current) .. " (" .. childNames(current, 15) .. ").", 0)
		end
		current = nextInstance
	end
	return current
end

--------------------------------------------------------------------------------------------------
-- Values: Roblox -> JSON
--------------------------------------------------------------------------------------------------

local function isFinite(n: number): boolean
	return n == n and n ~= math.huge and n ~= -math.huge
end

-- Components of vectors and colours, rounded so float32 noise stays out of the agent's view.
local function component(n: number): any
	if not isFinite(n) then
		return tostring(n)
	end
	return math.round(n * 10000) / 10000
end

local function plainNumber(n: number): any
	if not isFinite(n) then
		return tostring(n)
	end
	if n == math.floor(n) then
		return n
	end
	return math.round(n * 1000000) / 1000000
end

local function encodeValue(value: any, depth: number?): any
	local kind = typeof(value)
	if kind == "nil" then
		return nil
	elseif kind == "boolean" or kind == "string" then
		return value
	elseif kind == "number" then
		return plainNumber(value)
	elseif kind == "Vector3" then
		return { type = "Vector3", x = component(value.X), y = component(value.Y), z = component(value.Z) }
	elseif kind == "Vector2" then
		return { type = "Vector2", x = component(value.X), y = component(value.Y) }
	elseif kind == "Color3" then
		return {
			type = "Color3",
			r = component(value.R),
			g = component(value.G),
			b = component(value.B),
			hex = "#" .. string.lower(value:ToHex()),
		}
	elseif kind == "BrickColor" then
		return { type = "BrickColor", name = value.Name }
	elseif kind == "EnumItem" then
		return tostring(value)
	elseif kind == "UDim" then
		return { type = "UDim", scale = component(value.Scale), offset = value.Offset }
	elseif kind == "UDim2" then
		return {
			type = "UDim2",
			x = { scale = component(value.X.Scale), offset = value.X.Offset },
			y = { scale = component(value.Y.Scale), offset = value.Y.Offset },
		}
	elseif kind == "CFrame" then
		local rx, ry, rz = value:ToEulerAnglesXYZ()
		return {
			type = "CFrame",
			position = { component(value.X), component(value.Y), component(value.Z) },
			rotation = { component(math.deg(rx)), component(math.deg(ry)), component(math.deg(rz)) },
		}
	elseif kind == "NumberRange" then
		return { type = "NumberRange", min = component(value.Min), max = component(value.Max) }
	elseif kind == "Rect" then
		return {
			type = "Rect",
			min = { component(value.Min.X), component(value.Min.Y) },
			max = { component(value.Max.X), component(value.Max.Y) },
		}
	elseif kind == "Instance" then
		return { type = "Instance", path = pathOf(value), className = value.ClassName }
	elseif kind == "Font" then
		return { type = "Font", family = value.Family, weight = tostring(value.Weight), style = tostring(value.Style) }
	elseif kind == "table" then
		local level = depth or 0
		if level > 4 then
			return "{...}"
		end
		local out = {}
		if #value > 0 then
			for index, item in ipairs(value) do
				out[index] = encodeValue(item, level + 1)
			end
		else
			for key, item in value do
				out[tostring(key)] = encodeValue(item, level + 1)
			end
		end
		return out
	end
	return { type = kind, value = tostring(value) }
end

-- A value as the agent reads it in run_luau's results.
local function describeValue(value: any): string
	local kind = typeof(value)
	if kind == "string" then
		return string.format("%q", value)
	elseif kind == "nil" or kind == "boolean" or kind == "number" then
		return tostring(value)
	elseif kind == "Instance" then
		return pathOf(value) .. " (" .. value.ClassName .. ")"
	elseif kind == "EnumItem" then
		return tostring(value)
	elseif kind == "table" then
		local ok, json = encodeJson(encodeValue(value))
		if ok then
			return json
		end
		return tostring(value)
	end
	return kind .. "(" .. tostring(value) .. ")"
end

--------------------------------------------------------------------------------------------------
-- Values: JSON -> Roblox
--------------------------------------------------------------------------------------------------

local function toNumber(value: any, label: string): number
	local n = tonumber(value)
	if n == nil then
		error("Expected a number for " .. label .. ", got " .. typeof(value), 0)
	end
	return n
end

local function field(value: any, ...: string): any
	for i = 1, select("#", ...) do
		local key = select(i, ...)
		if value[key] ~= nil then
			return value[key]
		end
	end
	return nil
end

local function vector3From(value: any): Vector3
	if typeof(value) == "Vector3" then
		return value
	end
	if type(value) == "table" then
		if value[1] ~= nil then
			return Vector3.new(toNumber(value[1], "x"), toNumber(value[2], "y"), toNumber(value[3], "z"))
		end
		return Vector3.new(
			toNumber(field(value, "x", "X") or 0, "x"),
			toNumber(field(value, "y", "Y") or 0, "y"),
			toNumber(field(value, "z", "Z") or 0, "z")
		)
	end
	error('Expected a Vector3 such as {"type":"Vector3","x":0,"y":5,"z":0} or [0,5,0]', 0)
end

local function vector2From(value: any): Vector2
	if typeof(value) == "Vector2" then
		return value
	end
	if type(value) == "table" then
		if value[1] ~= nil then
			return Vector2.new(toNumber(value[1], "x"), toNumber(value[2], "y"))
		end
		return Vector2.new(toNumber(field(value, "x", "X") or 0, "x"), toNumber(field(value, "y", "Y") or 0, "y"))
	end
	error('Expected a Vector2 such as {"type":"Vector2","x":0,"y":1} or [0,1]', 0)
end

local function color3From(value: any): Color3
	if typeof(value) == "Color3" then
		return value
	end
	if typeof(value) == "BrickColor" then
		return value.Color
	end
	if type(value) == "string" then
		local hex = string.match(trim(value), "^#?(%x%x%x%x%x%x)$")
		if hex then
			return Color3.fromHex(hex)
		end
		local short = string.match(trim(value), "^#(%x%x%x)$")
		if short then
			local r, g, b = string.sub(short, 1, 1), string.sub(short, 2, 2), string.sub(short, 3, 3)
			return Color3.fromHex(r .. r .. g .. g .. b .. b)
		end
		-- A BrickColor name ("Bright red") also works for a Color3 property.
		local ok, brick = pcall(function()
			return BrickColor.new(value)
		end)
		if ok and brick.Name == value then
			return brick.Color
		end
		error("Expected a colour such as \"#ff8800\", got " .. string.format("%q", value), 0)
	end
	if type(value) == "table" then
		if type(value.hex) == "string" then
			return color3From(value.hex)
		end
		local r = toNumber(value[1] or field(value, "r", "R") or 0, "r")
		local g = toNumber(value[2] or field(value, "g", "G") or 0, "g")
		local b = toNumber(value[3] or field(value, "b", "B") or 0, "b")
		if r > 1 or g > 1 or b > 1 then
			return Color3.fromRGB(r, g, b)
		end
		return Color3.new(r, g, b)
	end
	error('Expected a colour: "#rrggbb" or {"type":"Color3","r":1,"g":0.5,"b":0} (0..1)', 0)
end

local function brickColorFrom(value: any): BrickColor
	if typeof(value) == "BrickColor" then
		return value
	end
	if typeof(value) == "Color3" then
		return BrickColor.new(value)
	end
	if type(value) == "table" then
		if value.name ~= nil then
			return BrickColor.new(tostring(value.name))
		end
		return BrickColor.new(color3From(value))
	end
	if type(value) == "number" then
		return BrickColor.new(value)
	end
	if type(value) == "string" then
		if string.sub(trim(value), 1, 1) == "#" then
			return BrickColor.new(color3From(value))
		end
		-- BrickColor.new falls back to grey for unknown names; catch that.
		local brick = BrickColor.new(value)
		if brick.Name ~= value then
			error("There is no BrickColor named " .. string.format("%q", value) .. " (names look like \"Bright red\")", 0)
		end
		return brick
	end
	error("Expected a BrickColor name such as \"Bright red\"", 0)
end

local function enumNames(enumType: any): string
	local names: { string } = {}
	local ok, items = pcall(function()
		return enumType:GetEnumItems()
	end)
	if ok then
		for index, item in items do
			if index > 25 then
				table.insert(names, "...")
				break
			end
			table.insert(names, item.Name)
		end
	end
	return table.concat(names, ", ")
end

local function enumFrom(value: any, enumType: any?): EnumItem
	if typeof(value) == "EnumItem" then
		return value
	end
	if type(value) == "table" and value.value ~= nil then
		value = value.value
	end
	if type(value) == "string" then
		local text = trim(value)
		local typeName, itemName = string.match(text, "^Enum%.([%w_]+)%.([%w_]+)$")
		if typeName and itemName then
			local ok, item = pcall(function()
				return (Enum :: any)[typeName][itemName]
			end)
			if ok and item then
				return item
			end
			error("There is no " .. text, 0)
		end
		if enumType ~= nil then
			local ok, item = pcall(function()
				return enumType[text]
			end)
			if ok and item then
				return item
			end
			local lower = string.lower(text)
			for _, candidate in enumType:GetEnumItems() do
				if string.lower(candidate.Name) == lower then
					return candidate
				end
			end
			error("'" .. text .. "' is not a " .. tostring(enumType) .. " (one of: " .. enumNames(enumType) .. ")", 0)
		end
	elseif type(value) == "number" and enumType ~= nil then
		for _, candidate in enumType:GetEnumItems() do
			if candidate.Value == value then
				return candidate
			end
		end
	end
	error('Expected an enum item such as "Enum.Material.Neon"', 0)
end

local function udimFrom(value: any): UDim
	if typeof(value) == "UDim" then
		return value
	end
	if type(value) == "number" then
		return UDim.new(0, value)
	end
	if type(value) == "table" then
		if value[1] ~= nil then
			return UDim.new(toNumber(value[1], "scale"), toNumber(value[2] or 0, "offset"))
		end
		return UDim.new(toNumber(field(value, "scale", "Scale") or 0, "scale"), toNumber(field(value, "offset", "Offset") or 0, "offset"))
	end
	error('Expected a UDim such as {"type":"UDim","scale":0,"offset":8}', 0)
end

local function udim2From(value: any): UDim2
	if typeof(value) == "UDim2" then
		return value
	end
	if type(value) == "table" then
		if value[1] ~= nil then
			return UDim2.new(
				toNumber(value[1], "x scale"),
				toNumber(value[2] or 0, "x offset"),
				toNumber(value[3] or 0, "y scale"),
				toNumber(value[4] or 0, "y offset")
			)
		end
		local x = field(value, "x", "X")
		local y = field(value, "y", "Y")
		if x ~= nil or y ~= nil then
			return UDim2.new(udimFrom(x or 0), udimFrom(y or 0))
		end
		return UDim2.new(
			toNumber(field(value, "xScale", "scaleX") or 0, "xScale"),
			toNumber(field(value, "xOffset", "offsetX") or 0, "xOffset"),
			toNumber(field(value, "yScale", "scaleY") or 0, "yScale"),
			toNumber(field(value, "yOffset", "offsetY") or 0, "yOffset")
		)
	end
	error('Expected a UDim2 such as {"type":"UDim2","x":{"scale":0.5,"offset":0},"y":{"scale":0,"offset":40}} or [0.5,0,0,40]', 0)
end

local function cframeFrom(value: any): CFrame
	if typeof(value) == "CFrame" then
		return value
	end
	if typeof(value) == "Vector3" then
		return CFrame.new(value)
	end
	if type(value) == "table" then
		local parts = value.components
		if parts == nil and #value == 12 then
			parts = value
		end
		if type(parts) == "table" then
			local n: { number } = {}
			for i = 1, 12 do
				n[i] = toNumber(parts[i], "component " .. tostring(i))
			end
			return CFrame.new(n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8], n[9], n[10], n[11], n[12])
		end
		if #value == 3 then
			return CFrame.new(vector3From(value))
		end
		local position = Vector3.zero
		if value.position ~= nil then
			position = vector3From(value.position)
		elseif field(value, "x", "X") ~= nil then
			position = vector3From(value)
		end
		if value.lookAt ~= nil then
			return CFrame.lookAt(position, vector3From(value.lookAt))
		end
		local frame = CFrame.new(position)
		if value.rotation ~= nil then
			local r = vector3From(value.rotation)
			frame *= CFrame.fromEulerAnglesXYZ(math.rad(r.X), math.rad(r.Y), math.rad(r.Z))
		end
		return frame
	end
	error('Expected a CFrame such as {"type":"CFrame","position":[0,5,0],"rotation":[0,90,0]} (degrees)', 0)
end

local function numberRangeFrom(value: any): NumberRange
	if typeof(value) == "NumberRange" then
		return value
	end
	if type(value) == "number" then
		return NumberRange.new(value)
	end
	if type(value) == "table" then
		local low = value.min
		local high = value.max
		if value[1] ~= nil then
			low, high = value[1], value[2]
		end
		local lowNumber = toNumber(low, "min")
		return NumberRange.new(lowNumber, toNumber(high or lowNumber, "max"))
	end
	error('Expected a NumberRange such as {"type":"NumberRange","min":1,"max":3}', 0)
end

local function instanceFrom(value: any): Instance?
	if typeof(value) == "Instance" then
		return value
	end
	if value == "nil" or value == false then
		return nil
	end
	if type(value) == "table" then
		return resolvePath(value.path)
	end
	return resolvePath(value)
end

-- A JSON value tagged with "type" ({"type":"Vector3",...}).
local function decodeTagged(value: any, current: any): any
	local kind = value.type
	if kind == "Vector3" then
		return vector3From(value)
	elseif kind == "Vector2" then
		return vector2From(value)
	elseif kind == "Color3" then
		return color3From(value)
	elseif kind == "BrickColor" then
		return brickColorFrom(value)
	elseif kind == "UDim" then
		return udimFrom(value)
	elseif kind == "UDim2" then
		return udim2From(value)
	elseif kind == "CFrame" then
		return cframeFrom(value)
	elseif kind == "NumberRange" then
		return numberRangeFrom(value)
	elseif kind == "Instance" then
		return instanceFrom(value)
	elseif kind == "Enum" or kind == "EnumItem" then
		local enumType = nil
		if typeof(current) == "EnumItem" then
			enumType = current.EnumType
		end
		return enumFrom(value, enumType)
	end
	error("Unknown value type '" .. tostring(kind) .. "'", 0)
end

-- Converts JSON to the type the property currently has.
local function decodeFor(instance: Instance, property: string, value: any): any
	local okCurrent, current = pcall(function()
		return (instance :: any)[property]
	end)
	if not okCurrent then
		current = nil
	end
	if type(value) == "table" and type(value.type) == "string" then
		return decodeTagged(value, current)
	end
	local kind = typeof(current)
	if kind == "Vector3" then
		return vector3From(value)
	elseif kind == "Vector2" then
		return vector2From(value)
	elseif kind == "Color3" then
		return color3From(value)
	elseif kind == "BrickColor" then
		return brickColorFrom(value)
	elseif kind == "EnumItem" then
		return enumFrom(value, current.EnumType)
	elseif kind == "UDim" then
		return udimFrom(value)
	elseif kind == "UDim2" then
		return udim2From(value)
	elseif kind == "CFrame" then
		return cframeFrom(value)
	elseif kind == "NumberRange" then
		return numberRangeFrom(value)
	elseif kind == "Instance" or property == "Parent" then
		return instanceFrom(value)
	elseif kind == "number" then
		return toNumber(value, property)
	elseif kind == "boolean" then
		if value == "true" then
			return true
		elseif value == "false" then
			return false
		end
		return value
	elseif kind == "string" and type(value) ~= "string" and value ~= nil then
		return tostring(value)
	end
	if type(value) == "string" and string.match(value, "^Enum%.[%w_]+%.[%w_]+$") then
		return enumFrom(value, nil)
	end
	return value
end

-- An attribute value: tagged JSON becomes the Roblox type, plain values stay as they are.
local function decodeAttribute(value: any): any
	if type(value) == "table" and type(value.type) == "string" then
		return decodeTagged(value, nil)
	end
	return value
end

local function setProperty(instance: Instance, name: string, value: any)
	if name == "Pivot" and instance:IsA("PVInstance") then
		(instance :: any):PivotTo(cframeFrom(value))
		return
	end
	local decoded = decodeFor(instance, name, value)
	local ok, err = pcall(function()
		(instance :: any)[name] = decoded
	end)
	if ok then
		return
	end
	-- An Instance-typed property that is nil right now (PrimaryPart, Adornee): try the string as a path.
	if type(value) == "string" then
		local okPath, target = pcall(resolvePath, value)
		if okPath then
			local okSet = pcall(function()
				(instance :: any)[name] = target
			end)
			if okSet then
				return
			end
		end
	end
	error(errorText(err), 0)
end

type Failure = { name: string, error: string }

-- Applies `properties` (Parent last, the rest alphabetically) and returns what changed and failed.
local function applyProperties(instance: Instance, properties: any, skipParent: boolean): ({ string }, { Failure })
	local changed: { string } = {}
	local failed: { Failure } = {}
	if type(properties) ~= "table" then
		return changed, failed
	end
	local names: { string } = {}
	for key in properties do
		if type(key) == "string" and not (skipParent and key == "Parent") then
			table.insert(names, key)
		end
	end
	table.sort(names, function(a: string, b: string): boolean
		if a == "Parent" then
			return false
		end
		if b == "Parent" then
			return true
		end
		return a < b
	end)
	for _, name in names do
		local ok, err = pcall(setProperty, instance, name, properties[name])
		if ok then
			table.insert(changed, name)
		else
			table.insert(failed, { name = name, error = errorText(err) })
		end
	end
	return changed, failed
end

local function applyAttributes(instance: Instance, attributes: any, changed: { string }, failed: { Failure })
	if type(attributes) ~= "table" then
		return
	end
	for name, value in attributes do
		local ok, err = pcall(function()
			instance:SetAttribute(tostring(name), decodeAttribute(value))
		end)
		if ok then
			table.insert(changed, "@" .. tostring(name))
		else
			table.insert(failed, { name = "@" .. tostring(name), error = errorText(err) })
		end
	end
end

--------------------------------------------------------------------------------------------------
-- Undo: every change is one undo step in Studio
--------------------------------------------------------------------------------------------------

local function withUndo(name: string, fn: () -> any): any
	local recording: any = nil
	local okBegin, id = pcall(function()
		return (ChangeHistoryService :: any):TryBeginRecording(name)
	end)
	if okBegin and id ~= nil then
		recording = id
	else
		pcall(function()
			ChangeHistoryService:SetWaypoint("Before " .. name)
		end)
	end
	local ok, result = pcall(fn)
	if recording ~= nil then
		pcall(function()
			local operation = Enum.FinishRecordingOperation.Commit
			if not ok then
				operation = Enum.FinishRecordingOperation.Cancel
			end
			(ChangeHistoryService :: any):FinishRecording(recording, operation)
		end)
	else
		pcall(function()
			ChangeHistoryService:SetWaypoint(name)
		end)
	end
	if not ok then
		error(result, 0)
	end
	return result
end

--------------------------------------------------------------------------------------------------
-- Commands
--------------------------------------------------------------------------------------------------

local function placeInfo()
	return { name = game.Name, placeId = game.PlaceId, gameId = game.GameId }
end

local function studioVersion(): string?
	local ok, value = pcall(function()
		return version()
	end)
	if ok then
		return value
	end
	return nil
end

local function ref(instance: Instance)
	return { path = pathOf(instance), className = instance.ClassName }
end

local function safeChildren(instance: Instance): { Instance }
	local ok, children = pcall(function()
		return instance:GetChildren()
	end)
	if not ok then
		return {}
	end
	local out: { Instance } = {}
	for _, child in children do
		local okName = pcall(function()
			return child.Name
		end)
		if okName then
			table.insert(out, child)
		end
	end
	return out
end

local function countLines(source: string): number
	if source == "" then
		return 0
	end
	local _, newlines = string.gsub(source, "\n", "")
	if string.sub(source, -1) == "\n" then
		return newlines
	end
	return newlines + 1
end

local function asScript(path: any): any
	local instance = resolvePath(path)
	if not instance:IsA("LuaSourceContainer") then
		error(pathOf(instance) .. " is a " .. instance.ClassName .. ", not a script.", 0)
	end
	return instance
end

local function readSource(script: any): (string, boolean)
	if ScriptEditorService ~= nil then
		local okDoc, document = pcall(function()
			return ScriptEditorService:FindScriptDocument(script)
		end)
		local ok, source = pcall(function()
			return ScriptEditorService:GetEditorSource(script)
		end)
		if ok and type(source) == "string" then
			return source, okDoc and document ~= nil
		end
	end
	return script.Source, false
end

local function writeSource(script: any, source: string): string
	local editorError = nil
	if ScriptEditorService ~= nil then
		local ok, err = pcall(function()
			ScriptEditorService:UpdateSourceAsync(script, function(_old: string): string
				return source
			end)
		end)
		if ok then
			return "editor"
		end
		editorError = err
	end
	local ok, err = pcall(function()
		script.Source = source
	end)
	if ok then
		return "source"
	end
	if editorError ~= nil then
		error("Could not update the script: " .. errorText(editorError) .. " / " .. errorText(err), 0)
	end
	error("Could not update the script: " .. errorText(err), 0)
end

local commandPing = function(_args: any): any
	return { pluginVersion = PLUGIN_VERSION, studioVersion = studioVersion(), place = placeInfo() }
end

local NO_LOADSTRING = "loadstring is not available to this plugin, so run_luau can't run code. "
	.. "Use the other roblox_* tools (create or edit a Script and play-test it), or check that Studio is up to date."

local commandRunLuau = function(args: any): any
	local code = args.code
	if type(code) ~= "string" or trim(code) == "" then
		error("Give the Luau code to run in 'code'.", 0)
	end
	local timeout = clampInt(args.timeout, 20, 1, 120)
	local compile: any = loadstring
	if type(compile) ~= "function" then
		error(NO_LOADSTRING, 0)
	end
	local okLoad, chunk, compileError = pcall(compile, code, "=lu-minal")
	if not okLoad then
		error(NO_LOADSTRING .. " (" .. errorText(chunk) .. ")", 0)
	end
	if chunk == nil then
		error("The code does not compile: " .. tostring(compileError), 0)
	end

	local output = {}
	local size = 0
	local truncated = false
	local function capture(kind: string, ...: any)
		local parts: { string } = {}
		for i = 1, select("#", ...) do
			parts[i] = tostring((select(i, ...)))
		end
		local text = table.concat(parts, " ")
		if #output >= MAX_RUN_OUTPUT_LINES or size + #text > MAX_RUN_OUTPUT_CHARS then
			truncated = true
			return
		end
		size += #text
		table.insert(output, { kind = kind, text = text })
	end
	local environment = setmetatable({
		print = function(...: any)
			capture("print", ...)
		end,
		warn = function(...: any)
			capture("warn", ...)
		end,
	}, { __index = getfenv(1) })
	setfenv(chunk, environment)

	local finished = false
	local packed: any = nil
	local thread = task.spawn(function()
		packed = table.pack(xpcall(chunk, function(err: any): string
			return tostring(err)
		end))
		finished = true
	end)
	local deadline = os.clock() + timeout
	while not finished and os.clock() < deadline do
		task.wait(0.03)
	end
	if not finished then
		pcall(task.cancel, thread)
		return {
			output = output,
			returns = {},
			error = "Timed out after " .. tostring(timeout) .. "s; the code was stopped.",
			timedOut = true,
			truncated = truncated,
		}
	end
	local result: { [string]: any } = { output = output, returns = {}, truncated = truncated }
	if packed[1] then
		local returns = {}
		for i = 2, packed.n do
			table.insert(returns, describeValue(packed[i]))
		end
		result.returns = returns
	else
		result.error = tostring(packed[2])
	end
	return result
end

local function commonServices(children: { Instance }): { Instance }
	local byName: { [string]: Instance } = {}
	for _, child in children do
		byName[child.ClassName] = child
	end
	local out: { Instance } = {}
	for _, name in COMMON_SERVICES do
		local service = byName[name]
		if service then
			table.insert(out, service)
		end
	end
	return out
end

local commandGetTree = function(args: any): any
	local root = resolvePath(args.path or "game")
	local depth = clampInt(args.depth, 2, 0, 10)
	local maxChildren = clampInt(args.maxChildren, 50, 1, 500)
	local count = 0
	local function node(instance: Instance, level: number): any
		count += 1
		local children = safeChildren(instance)
		local result: { [string]: any } = {
			name = instance.Name,
			className = instance.ClassName,
			path = pathOf(instance),
			childCount = #children,
		}
		if level < depth and #children > 0 then
			local list = children
			if instance == game then
				list = commonServices(children)
			end
			local out = {}
			for index, child in list do
				if index > maxChildren or count >= MAX_TREE_NODES then
					break
				end
				table.insert(out, node(child, level + 1))
			end
			result.children = out
			if #out < #children then
				result.more = #children - #out
			end
		end
		return result
	end
	return node(root, 0)
end

-- The properties worth showing per class, checked with IsA in this order.
local CLASS_PROPERTIES: { { any } } = {
	{ "BasePart", { "Position", "Orientation", "Size", "CFrame", "Color", "BrickColor", "Material", "Transparency", "Reflectance", "Anchored", "CanCollide", "CanTouch", "CanQuery", "CastShadow", "Massless", "Locked" } },
	{ "Part", { "Shape" } },
	{ "MeshPart", { "MeshId", "TextureID" } },
	{ "SpawnLocation", { "Enabled", "Duration", "Neutral", "TeamColor" } },
	{ "Model", { "PrimaryPart", "WorldPivot" } },
	{ "LuaSourceContainer", { "RunContext", "Enabled" } },
	{ "ValueBase", { "Value" } },
	{ "GuiObject", { "Position", "Size", "AnchorPoint", "BackgroundColor3", "BackgroundTransparency", "BorderSizePixel", "Visible", "ZIndex", "LayoutOrder", "Rotation", "ClipsDescendants" } },
	{ "GuiButton", { "AutoButtonColor", "Modal" } },
	{ "TextLabel", { "Text", "TextColor3", "TextSize", "FontFace", "TextScaled", "TextWrapped", "TextXAlignment", "TextYAlignment", "RichText" } },
	{ "TextButton", { "Text", "TextColor3", "TextSize", "FontFace", "TextScaled", "TextWrapped", "RichText" } },
	{ "TextBox", { "Text", "PlaceholderText", "TextColor3", "TextSize", "FontFace", "ClearTextOnFocus", "MultiLine" } },
	{ "ImageLabel", { "Image", "ImageColor3", "ImageTransparency", "ScaleType" } },
	{ "ImageButton", { "Image", "ImageColor3", "ImageTransparency", "ScaleType" } },
	{ "LayerCollector", { "Enabled", "ResetOnSpawn", "ZIndexBehavior" } },
	{ "ScreenGui", { "DisplayOrder", "IgnoreGuiInset" } },
	{ "BillboardGui", { "Adornee", "Size", "StudsOffset", "AlwaysOnTop", "MaxDistance" } },
	{ "SurfaceGui", { "Adornee", "Face", "CanvasSize" } },
	{ "UICorner", { "CornerRadius" } },
	{ "UIStroke", { "Color", "Thickness", "Transparency", "ApplyStrokeMode" } },
	{ "UIListLayout", { "FillDirection", "Padding", "SortOrder", "HorizontalAlignment", "VerticalAlignment" } },
	{ "UIPadding", { "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight" } },
	{ "Light", { "Enabled", "Brightness", "Color", "Shadows" } },
	{ "PointLight", { "Range" } },
	{ "SpotLight", { "Range", "Angle", "Face" } },
	{ "Sound", { "SoundId", "Volume", "Looped", "Playing", "PlaybackSpeed", "RollOffMaxDistance" } },
	{ "Decal", { "Texture", "Color3", "Transparency", "Face" } },
	{ "Texture", { "StudsPerTileU", "StudsPerTileV" } },
	{ "ParticleEmitter", { "Enabled", "Rate", "Lifetime", "Speed", "Color", "Texture", "Size" } },
	{ "Beam", { "Attachment0", "Attachment1", "Color", "Width0", "Width1", "Enabled" } },
	{ "Trail", { "Attachment0", "Attachment1", "Color", "Lifetime", "Enabled" } },
	{ "Attachment", { "Position", "Orientation", "WorldPosition" } },
	{ "Constraint", { "Enabled", "Attachment0", "Attachment1", "Visible" } },
	{ "JointInstance", { "Part0", "Part1", "C0", "C1" } },
	{ "WeldConstraint", { "Part0", "Part1", "Enabled" } },
	{ "Humanoid", { "DisplayName", "Health", "MaxHealth", "WalkSpeed", "JumpPower", "JumpHeight", "UseJumpPower", "RigType" } },
	{ "Tool", { "ToolTip", "RequiresHandle", "CanBeDropped", "Enabled" } },
	{ "ProximityPrompt", { "ActionText", "ObjectText", "HoldDuration", "MaxActivationDistance", "KeyboardKeyCode", "RequiresLineOfSight", "Enabled" } },
	{ "ClickDetector", { "MaxActivationDistance" } },
	{ "Camera", { "CFrame", "FieldOfView", "CameraType", "CameraSubject" } },
	{ "Workspace", { "Gravity", "FallenPartsDestroyHeight", "CurrentCamera", "StreamingEnabled" } },
	{ "Lighting", { "Ambient", "OutdoorAmbient", "Brightness", "ClockTime", "GeographicLatitude", "FogColor", "FogEnd", "FogStart", "GlobalShadows", "ExposureCompensation" } },
	{ "Atmosphere", { "Density", "Offset", "Color", "Decay", "Glare", "Haze" } },
	{ "Sky", { "SkyboxBk", "SunAngularSize", "MoonAngularSize", "StarCount" } },
	{ "Team", { "TeamColor", "AutoAssignable" } },
	{ "Player", { "UserId", "DisplayName", "Team" } },
	{ "RemoteEvent", {} },
	{ "BindableEvent", {} },
}

local commandGetProperties = function(args: any): any
	local instance = resolvePath(args.path)
	local names: { string } = {}
	local seen: { [string]: boolean } = {}
	local function add(name: string)
		if not seen[name] then
			seen[name] = true
			table.insert(names, name)
		end
	end
	local explicit = type(args.names) == "table" and #args.names > 0
	if explicit then
		for _, name in args.names do
			add(tostring(name))
		end
	else
		add("Name")
		add("ClassName")
		add("Parent")
		for _, entry in CLASS_PROPERTIES do
			if instance:IsA(entry[1]) then
				for _, name in entry[2] do
					add(name)
				end
			end
		end
		add("Archivable")
	end
	local properties = {}
	local missing: { string } = {}
	for _, name in names do
		local ok, value = pcall(function()
			return (instance :: any)[name]
		end)
		if ok and typeof(value) ~= "function" and typeof(value) ~= "RBXScriptSignal" then
			table.insert(properties, { name = name, value = encodeValue(value) })
		elseif explicit then
			local okAttribute, attribute = pcall(function()
				return instance:GetAttribute(name)
			end)
			if okAttribute and attribute ~= nil then
				table.insert(properties, { name = "@" .. name, value = encodeValue(attribute) })
			else
				table.insert(missing, name)
			end
		end
	end
	local attributes = {}
	for key, value in instance:GetAttributes() do
		attributes[key] = encodeValue(value)
	end
	local tags = {}
	local okTags, list = pcall(function()
		return CollectionService:GetTags(instance)
	end)
	if okTags then
		tags = list
	end
	local result: { [string]: any } = {
		path = pathOf(instance),
		className = instance.ClassName,
		properties = properties,
		attributes = attributes,
		tags = tags,
	}
	if #missing > 0 then
		result.missing = missing
	end
	return result
end

local commandGetScript = function(args: any): any
	local script = asScript(args.path)
	local source, open = readSource(script)
	return {
		path = pathOf(script),
		className = script.ClassName,
		source = source,
		lineCount = countLines(source),
		open = open,
	}
end

local commandSetScript = function(args: any): any
	local script = asScript(args.path)
	local source = args.source
	if type(source) ~= "string" then
		error("Give the script's new source in 'source'.", 0)
	end
	local method = withUndo("lu-minal: edit " .. script.Name, function()
		return writeSource(script, source)
	end)
	return { path = pathOf(script), lineCount = countLines(source), method = method }
end

local commandCreateInstance = function(args: any): any
	local className = args.className
	if type(className) ~= "string" or className == "" then
		error("Give the class to create in 'className' (Part, Model, Script, ...).", 0)
	end
	local parentPath = args.parent
	if parentPath == nil and type(args.properties) == "table" then
		parentPath = args.properties.Parent
	end
	local parent = resolvePath(parentPath or "game.Workspace")
	return withUndo("lu-minal: create " .. className, function()
		local okNew, created = pcall(function()
			return Instance.new(className :: any)
		end)
		if not okNew then
			error("Can't create a " .. className .. ": " .. errorText(created), 0)
		end
		local instance: Instance = created
		if type(args.name) == "string" and args.name ~= "" then
			instance.Name = args.name
		end
		local _, failed = applyProperties(instance, args.properties, true)
		applyAttributes(instance, args.attributes, {}, failed)
		if args.source ~= nil then
			if not instance:IsA("LuaSourceContainer") then
				instance:Destroy()
				error("'source' only works for scripts; " .. className .. " is not one.", 0)
			end
			(instance :: any).Source = tostring(args.source)
		end
		instance.Parent = parent
		local result: { [string]: any } = { path = pathOf(instance), className = instance.ClassName }
		if #failed > 0 then
			result.failed = failed
		end
		return result
	end)
end

local commandSetProperties = function(args: any): any
	local instance = resolvePath(args.path)
	local hasProperties = type(args.properties) == "table" and next(args.properties) ~= nil
	local hasAttributes = type(args.attributes) == "table" and next(args.attributes) ~= nil
	if not hasProperties and not hasAttributes then
		error("Give the properties to set in 'properties' (an object of name -> value).", 0)
	end
	return withUndo("lu-minal: set properties of " .. instance.Name, function()
		local changed, failed = applyProperties(instance, args.properties, false)
		applyAttributes(instance, args.attributes, changed, failed)
		return { path = pathOf(instance), changed = changed, failed = failed }
	end)
end

local commandDeleteInstance = function(args: any): any
	local instance = resolvePath(args.path)
	if instance == game then
		error("Refusing to delete the place itself (game).", 0)
	end
	if instance.Parent == game then
		error("Refusing to delete the service " .. instance.Name .. ".", 0)
	end
	if instance == workspace.Terrain then
		error("Refusing to delete Terrain; clear it with workspace.Terrain:Clear() through run_luau instead.", 0)
	end
	if (instance :: any) == plugin or instance == script then
		error("Refusing to delete the lu-minal plugin.", 0)
	end
	local path = pathOf(instance)
	local className = instance.ClassName
	local descendants = #instance:GetDescendants()
	withUndo("lu-minal: delete " .. instance.Name, function()
		-- Parent = nil (not Destroy) so Studio's undo can bring it back.
		instance.Parent = nil
		return nil
	end)
	return { path = path, className = className, descendants = descendants }
end

local commandGetSelection = function(_args: any): any
	local selection = {}
	for _, instance in Selection:Get() do
		table.insert(selection, ref(instance))
	end
	return { selection = selection }
end

local commandSetSelection = function(args: any): any
	local paths = args.paths
	if type(paths) == "string" then
		paths = { paths }
	end
	local instances: { Instance } = {}
	local missing: { string } = {}
	if type(paths) == "table" then
		for _, path in paths do
			local ok, instance = pcall(resolvePath, path)
			if ok then
				table.insert(instances, instance)
			else
				table.insert(missing, tostring(path))
			end
		end
	end
	Selection:Set(instances)
	local selection = {}
	for _, instance in instances do
		table.insert(selection, ref(instance))
	end
	return { selection = selection, missing = missing }
end

local commandFindInstances = function(args: any): any
	local root = resolvePath(args.root or "game")
	local className = args.className
	if type(className) ~= "string" or className == "" then
		className = nil
	end
	local query = args.name
	if type(query) ~= "string" or query == "" then
		query = nil
	end
	local limit = clampInt(args.limit, 100, 1, 1000)
	local lowerQuery = nil
	local isPattern = false
	if query then
		lowerQuery = string.lower(query)
		isPattern = string.find(query, "[%^%$%(%)%%%.%[%]%*%+%-%?]") ~= nil
	end
	local matches = {}
	local total = 0
	local function matchesQuery(instance: Instance): boolean
		if className and not instance:IsA(className) then
			return false
		end
		if query then
			local name = instance.Name
			if string.find(string.lower(name), lowerQuery :: string, 1, true) then
				return true
			end
			if isPattern then
				local ok, found = pcall(string.find, name, query)
				return ok and found ~= nil
			end
			return false
		end
		return true
	end
	local function visit(list: { Instance })
		for _, instance in list do
			local ok, hit = pcall(matchesQuery, instance)
			if ok and hit then
				total += 1
				if #matches < limit then
					table.insert(matches, ref(instance))
				end
			end
		end
	end
	if root == game then
		for _, service in safeChildren(game) do
			if not SKIP_SERVICES[service.ClassName] then
				local ok, descendants = pcall(function()
					return service:GetDescendants()
				end)
				if ok then
					visit({ service })
					visit(descendants)
				end
			end
		end
	else
		visit(root:GetDescendants())
	end
	return { root = pathOf(root), matches = matches, total = total, truncated = total > #matches }
end

local COMMANDS: { [string]: (any) -> any } = {
	ping = commandPing,
	run_luau = commandRunLuau,
	get_tree = commandGetTree,
	get_properties = commandGetProperties,
	get_script = commandGetScript,
	set_script = commandSetScript,
	create_instance = commandCreateInstance,
	set_properties = commandSetProperties,
	delete_instance = commandDeleteInstance,
	get_selection = commandGetSelection,
	set_selection = commandSetSelection,
	find_instances = commandFindInstances,
}

--------------------------------------------------------------------------------------------------
-- Connection state
--------------------------------------------------------------------------------------------------

type Status = "disconnected" | "connecting" | "connected"

local state = {
	-- The user wants a connection (Connect was clicked, or auto-connect).
	wanted = false,
	status = "disconnected" :: Status,
	session = nil :: string?,
	-- Bumped on every connect / disconnect; loops of an older generation end.
	generation = 0,
	lastError = nil :: string?,
	port = configuredPort(),
}

local logBuffer: { any } = {}
local onStatusChanged: () -> () = function() end

local function setStatus(status: Status)
	if state.status ~= status then
		state.status = status
	end
	onStatusChanged()
end

local function baseUrl(): string
	return "http://" .. HOST .. ":" .. tostring(state.port)
end

type Response = { ok: boolean, status: number, body: any, err: string? }

local function request(method: string, path: string, body: string?): Response
	local headers: { [string]: string } = { ["X-LuMinal-Plugin"] = PLUGIN_VERSION }
	local options: { [string]: any } = { Url = baseUrl() .. path, Method = method, Headers = headers }
	if body ~= nil then
		headers["Content-Type"] = "application/json"
		options.Body = body
	end
	local ok, result = pcall(function()
		return HttpService:RequestAsync(options :: any)
	end)
	if not ok then
		return { ok = false, status = 0, body = nil, err = tostring(result) }
	end
	local response: any = result
	local decoded = nil
	if type(response.Body) == "string" and #response.Body > 0 then
		local okJson, value = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if okJson then
			decoded = value
		end
	end
	local err = nil
	if not response.Success then
		err = "HTTP " .. tostring(response.StatusCode)
		if type(decoded) == "table" and decoded.error then
			err ..= ": " .. tostring(decoded.error)
		end
	end
	return { ok = response.Success, status = response.StatusCode, body = decoded, err = err }
end

local function postJson(path: string, value: any): Response
	local ok, body = encodeJson(value)
	if not ok then
		return { ok = false, status = 0, body = nil, err = "Could not encode JSON: " .. body }
	end
	return request("POST", path, body)
end

local function failureHint(response: Response): string
	local text = response.err or "unknown error"
	local lower = string.lower(text)
	if string.find(lower, "not enabled", 1, true) or string.find(lower, "permission", 1, true) or string.find(lower, "denied", 1, true) then
		return text .. " - allow HTTP requests for the lu-minal plugin (Plugins > Manage Plugins > lu-minal > HTTP requests: allow 127.0.0.1)."
	end
	if response.status == 0 then
		return text .. " - is lu-minal running? It listens on " .. HOST .. ":" .. tostring(state.port) .. "."
	end
	return text
end

local function runCommand(message: any)
	local id = message.id
	local name = tostring(message.command)
	local handler = COMMANDS[name]
	local reply: { [string]: any }
	if handler == nil then
		reply = {
			id = id,
			ok = false,
			error = "This lu-minal plugin (version " .. PLUGIN_VERSION .. ") does not know the command '" .. name
				.. "'. Update it with \"lu-minal roblox install\" and restart Studio.",
		}
	else
		local args = message.args
		if type(args) ~= "table" then
			args = {}
		end
		local ok, result = pcall(handler, args)
		if ok then
			reply = { id = id, ok = true, result = result }
		else
			reply = { id = id, ok = false, error = errorText(result) }
		end
	end
	local okJson, body = encodeJson(reply)
	if not okJson then
		okJson, body = encodeJson({ id = id, ok = false, error = "The result could not be encoded as JSON: " .. body })
	end
	if okJson then
		request("POST", "/result", body)
	end
end

local function helloBody()
	return { place = placeInfo(), studioVersion = studioVersion(), pluginVersion = PLUGIN_VERSION }
end

local function isTimeout(response: Response): boolean
	local text = string.lower(response.err or "")
	return response.status == 0 and (string.find(text, "timedout", 1, true) ~= nil or string.find(text, "timed out", 1, true) ~= nil)
end

local function connectionLoop(generation: number)
	local backoff = 1
	local reported = false
	while state.wanted and state.generation == generation do
		if state.session == nil then
			setStatus("connecting")
			local response = postJson("/hello", helloBody())
			if state.generation ~= generation then
				break
			end
			if response.ok and type(response.body) == "table" and type(response.body.session) == "string" then
				state.session = response.body.session
				state.lastError = nil
				backoff = 1
				reported = false
				setStatus("connected")
				info("Connected to lu-minal on " .. HOST .. ":" .. tostring(state.port) .. ".")
				local shipped = response.body.pluginVersion
				if type(shipped) == "string" and shipped ~= PLUGIN_VERSION then
					warnUser("This plugin is version " .. PLUGIN_VERSION .. "; lu-minal ships " .. shipped
						.. ". Run \"lu-minal roblox install\" and restart Studio to update it.")
				end
			else
				state.lastError = failureHint(response)
				if not reported then
					warnUser("Can't reach lu-minal yet (" .. state.lastError .. "). Retrying in the background.")
					reported = true
				end
				onStatusChanged()
				task.wait(backoff)
				backoff = math.min(backoff * 2, MAX_BACKOFF_SECONDS)
			end
		else
			local response = request("GET", "/poll?session=" .. HttpService:UrlEncode(state.session :: string))
			if state.generation ~= generation then
				break
			end
			if response.status == 204 or isTimeout(response) then
				-- Nothing to do (or Studio's own HTTP timeout): poll again.
				backoff = 1
			elseif response.ok and type(response.body) == "table" and response.body.id ~= nil then
				backoff = 1
				runCommand(response.body)
			elseif response.status == 409 then
				-- lu-minal restarted and forgot this session: say hello again.
				state.session = nil
			else
				state.session = nil
				state.lastError = failureHint(response)
				setStatus("connecting")
				if not reported then
					warnUser("Lost the connection to lu-minal (" .. state.lastError .. "). Reconnecting.")
					reported = true
				end
				task.wait(backoff)
				backoff = math.min(backoff * 2, MAX_BACKOFF_SECONDS)
			end
		end
	end
end

local function logLoop(generation: number)
	while state.wanted and state.generation == generation do
		task.wait(LOG_FLUSH_SECONDS)
		if state.session ~= nil and #logBuffer > 0 and state.generation == generation then
			local batch = logBuffer
			logBuffer = {}
			local response = postJson("/log", { session = state.session, lines = batch })
			if not response.ok then
				-- Keep them for the next try, newest last, within the buffer's limit.
				for _, line in logBuffer do
					table.insert(batch, line)
				end
				while #batch > MAX_LOG_BUFFER do
					table.remove(batch, 1)
				end
				logBuffer = batch
			end
		end
	end
end

LogService.MessageOut:Connect(function(message: string, messageType: Enum.MessageType)
	if not state.wanted then
		return
	end
	if string.sub(message, 1, #LOG_PREFIX) == LOG_PREFIX then
		return
	end
	if #logBuffer >= MAX_LOG_BUFFER then
		table.remove(logBuffer, 1)
	end
	table.insert(logBuffer, { type = messageType.Name, text = message, at = nowMs() })
end)

local function sayBye(session: string?)
	if session == nil then
		return
	end
	task.spawn(function()
		postJson("/bye", { session = session })
	end)
end

local function connect()
	if state.wanted then
		return
	end
	state.wanted = true
	state.generation += 1
	state.session = nil
	state.lastError = nil
	local generation = state.generation
	task.spawn(connectionLoop, generation)
	task.spawn(logLoop, generation)
	setStatus("connecting")
end

local function disconnect()
	if not state.wanted then
		return
	end
	local session = state.session
	state.wanted = false
	state.generation += 1
	state.session = nil
	logBuffer = {}
	setStatus("disconnected")
	sayBye(session)
	info("Disconnected from lu-minal.")
end

local function setPort(port: number)
	if port == state.port then
		return
	end
	state.port = port
	setSetting(SETTING_PORT, { port = port, default = DEFAULT_PORT })
	if state.wanted then
		disconnect()
		connect()
	end
	onStatusChanged()
end

--------------------------------------------------------------------------------------------------
-- Toolbar and settings window
--------------------------------------------------------------------------------------------------

local toolbar = plugin:CreateToolbar("lu-minal")
local connectButton = toolbar:CreateButton(
	"luminal-connect",
	"Connect Studio to lu-minal (click again to disconnect)",
	"",
	"Connect"
)
connectButton.ClickableWhenViewportHidden = true
local settingsButton = toolbar:CreateButton(
	"luminal-settings",
	"lu-minal: connection status, port and auto-connect",
	"",
	"Settings"
)
settingsButton.ClickableWhenViewportHidden = true

local widget = plugin:CreateDockWidgetPluginGui(
	"LuMinalSettings",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 340, 220, 280, 180)
)
widget.Title = "lu-minal"

local function studioColor(name: string, fallback: Color3): Color3
	local ok, color = pcall(function()
		return (settings() :: any).Studio.Theme:GetColor((Enum.StudioStyleGuideColor :: any)[name])
	end)
	if ok and typeof(color) == "Color3" then
		return color
	end
	return fallback
end

local root = Instance.new("Frame")
root.Size = UDim2.fromScale(1, 1)
root.BorderSizePixel = 0
root.Parent = widget

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 10)
padding.PaddingBottom = UDim.new(0, 10)
padding.PaddingLeft = UDim.new(0, 12)
padding.PaddingRight = UDim.new(0, 12)
padding.Parent = root

local layout = Instance.new("UIListLayout")
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Padding = UDim.new(0, 8)
layout.Parent = root

local function label(order: number, text: string): TextLabel
	local item = Instance.new("TextLabel")
	item.LayoutOrder = order
	item.Size = UDim2.new(1, 0, 0, 18)
	item.AutomaticSize = Enum.AutomaticSize.Y
	item.BackgroundTransparency = 1
	item.TextXAlignment = Enum.TextXAlignment.Left
	item.TextWrapped = true
	item.Font = Enum.Font.SourceSans
	item.TextSize = 15
	item.Text = text
	item.Parent = root
	return item
end

local statusLabel = label(1, "")
statusLabel.Font = Enum.Font.SourceSansBold

local portRow = Instance.new("Frame")
portRow.LayoutOrder = 2
portRow.Size = UDim2.new(1, 0, 0, 24)
portRow.BackgroundTransparency = 1
portRow.Parent = root

local portLabel = Instance.new("TextLabel")
portLabel.Size = UDim2.new(0, 110, 1, 0)
portLabel.BackgroundTransparency = 1
portLabel.TextXAlignment = Enum.TextXAlignment.Left
portLabel.Font = Enum.Font.SourceSans
portLabel.TextSize = 15
portLabel.Text = "Port (127.0.0.1)"
portLabel.Parent = portRow

local portBox = Instance.new("TextBox")
portBox.Position = UDim2.new(0, 116, 0, 0)
portBox.Size = UDim2.new(0, 80, 1, 0)
portBox.ClearTextOnFocus = false
portBox.Font = Enum.Font.Code
portBox.TextSize = 15
portBox.Text = tostring(state.port)
portBox.Parent = portRow

local autoButton = Instance.new("TextButton")
autoButton.LayoutOrder = 3
autoButton.Size = UDim2.new(1, 0, 0, 24)
autoButton.TextXAlignment = Enum.TextXAlignment.Left
autoButton.Font = Enum.Font.SourceSans
autoButton.TextSize = 15
autoButton.AutoButtonColor = true
autoButton.Parent = root

local errorLabel = label(4, "")
local versionLabel = label(5, "Plugin " .. PLUGIN_VERSION .. " - docs: github.com/Luna-OS/lu-minal (docs/roblox.md)")

local function applyTheme()
	local background = studioColor("MainBackground", Color3.fromRGB(46, 46, 46))
	local text = studioColor("MainText", Color3.fromRGB(230, 230, 230))
	local dim = studioColor("DimmedText", Color3.fromRGB(150, 150, 150))
	local input = studioColor("InputFieldBackground", Color3.fromRGB(37, 37, 37))
	local button = studioColor("Button", Color3.fromRGB(60, 60, 60))
	root.BackgroundColor3 = background
	for _, item in { statusLabel, portLabel, errorLabel } do
		item.TextColor3 = text
	end
	versionLabel.TextColor3 = dim
	portBox.BackgroundColor3 = input
	portBox.TextColor3 = text
	autoButton.BackgroundColor3 = button
	autoButton.TextColor3 = text
end

local function autoConnectEnabled(): boolean
	return getSetting(SETTING_AUTO_CONNECT) == true
end

local function refreshUi()
	connectButton:SetActive(state.wanted)
	local text
	if state.status == "connected" then
		text = "Connected to lu-minal on " .. HOST .. ":" .. tostring(state.port)
	elseif state.status == "connecting" then
		text = "Connecting to " .. HOST .. ":" .. tostring(state.port) .. "..."
	else
		text = "Not connected - click Connect on the lu-minal toolbar"
	end
	statusLabel.Text = text
	local box: TextBox = portBox
	if not box:IsFocused() then
		box.Text = tostring(state.port)
	end
	if autoConnectEnabled() then
		autoButton.Text = "  [x] Connect automatically when Studio opens"
	else
		autoButton.Text = "  [  ] Connect automatically when Studio opens"
	end
	if state.lastError ~= nil and state.status ~= "connected" then
		errorLabel.Text = "Last error: " .. state.lastError
		errorLabel.Visible = true
	else
		errorLabel.Text = ""
		errorLabel.Visible = false
	end
end

onStatusChanged = refreshUi

portBox.FocusLost:Connect(function()
	local port = tonumber(trim(portBox.Text))
	if port ~= nil and port == math.floor(port) and port >= 1 and port <= 65535 then
		setPort(port)
	else
		warnUser("The port must be a number from 1 to 65535.")
	end
	refreshUi()
end)

autoButton.Activated:Connect(function()
	local enabled = not autoConnectEnabled()
	setSetting(SETTING_AUTO_CONNECT, enabled)
	if enabled and not state.wanted then
		connect()
	end
	refreshUi()
end)

connectButton.Click:Connect(function()
	if state.wanted then
		disconnect()
	else
		connect()
		if not autoConnectEnabled() then
			info("Connecting... Tip: lu-minal > Settings can connect automatically when Studio opens.")
		end
	end
	refreshUi()
end)

settingsButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
	settingsButton:SetActive(widget.Enabled)
end)

widget:GetPropertyChangedSignal("Enabled"):Connect(function()
	settingsButton:SetActive(widget.Enabled)
end)

pcall(function()
	(settings() :: any).Studio.ThemeChanged:Connect(applyTheme)
end)

plugin.Unloading:Connect(function()
	local session = state.session
	state.wanted = false
	state.generation += 1
	state.session = nil
	sayBye(session)
end)

applyTheme()
refreshUi()

if autoConnectEnabled() then
	connect()
end
