// The app's chrome: the tab bar (with the plan limits on the right), the project header, the footer
// and the toasts. They sit directly on the sky, so only their text cells are painted.
import { Box, Text } from "ink";
import React from "react";
import type { Hub, Toast } from "../../core/hub.js";
import { PERMISSION_LABELS } from "../../core/permissions.js";
import type { Project } from "../../core/project.js";
import type { Theme } from "../../themes/types.js";
import { formatCost, formatCount, formatElapsed, formatTokens } from "../format.js";
import type { Rect } from "../layout.js";
import type { Seg } from "../log-lines.js";
import { truncate, width as textWidth, wrap } from "../text.js";
import { MoonGauge } from "./MoonGauge.js";
import { Segs, segsWidth } from "./RowView.js";

function Line({ rect, left, right, bg }: { rect: Rect; left: Seg[]; right?: Seg[]; bg: string }) {
  const rightW = right ? segsWidth(right) : 0;
  return (
    <Box position="absolute" left={rect.x} top={rect.y} width={rect.width} height={1}>
      <Box width={Math.max(1, rect.width - rightW - 1)}>
        <Segs segs={left} bg={bg} />
      </Box>
      {right ? (
        <Box position="absolute" left={rect.width - rightW} width={rightW}>
          <Segs segs={right} bg={bg} />
        </Box>
      ) : null}
    </Box>
  );
}

function tabBadge(project: Project, theme: Theme, frame: number): Seg | null {
  if (project.agents.some((a) => a.status === "waiting")) return { text: " ▲", color: theme.colors.warning };
  if (project.agents.some((a) => a.busy)) {
    return { text: frame % 4 < 2 ? " ●" : " ○", color: theme.colors.success };
  }
  if (project.agents.some((a) => a.status === "error")) return { text: " ✗", color: theme.colors.error };
  return null;
}

export function TabBar({ hub, rect, frame }: { hub: Hub; rect: Rect; frame: number }) {
  const theme = hub.theme;
  const c = theme.colors;
  const bg = c.bg;
  const usage = hub.planUsage;
  const gaugeWidth = rect.width >= 130 ? 24 : 0;
  const rightW = gaugeWidth ? gaugeWidth * 2 + 3 : 0;

  // On the home screen its own segment is the active tab.
  const home = hub.homeShown;
  const homeBg = home ? c.tabActiveBg : undefined;
  const left: Seg[] = [
    { text: " ☾ ", color: c.accent, bold: true, bg: homeBg },
    { text: "lu-minal ", color: home ? c.tabActiveFg : c.text, bold: true, bg: homeBg },
  ];
  if (hub.updateStatus) left.push({ text: `${hub.updateStatus} `, color: c.accent2 });
  else if (hub.updateInstalled) left.push({ text: `✓ ${hub.updateInstalled}: restart `, color: c.success });
  else if (hub.updateAvailable) left.push({ text: `↑ ${hub.updateAvailable.version} /update `, color: c.success });
  const room = rect.width - rightW - segsWidth(left) - 6;
  const tabs = hub.projects;
  const each = Math.max(8, Math.floor(room / Math.max(1, tabs.length)) - 1);
  tabs.forEach((p, i) => {
    const active = !home && i === hub.activeIndex;
    const badge = tabBadge(p, theme, frame);
    const label = truncate(`${i + 1} ${p.name}`, Math.max(4, each - 2 - (badge ? 2 : 0)));
    left.push({ text: " ", color: c.faint });
    left.push({
      text: ` ${label}`,
      color: active ? c.tabActiveFg : c.muted,
      bg: active ? c.tabActiveBg : undefined,
      bold: active,
    });
    if (badge) left.push({ ...badge, bg: active ? c.tabActiveBg : undefined });
    left.push({ text: " ", bg: active ? c.tabActiveBg : undefined });
  });
  left.push({ text: "  + ctrl+t", color: c.faint });

  return (
    <Box position="absolute" left={rect.x} top={rect.y} width={rect.width} height={1}>
      <Box width={Math.max(1, rect.width - rightW)}>
        <Segs segs={left} bg={bg} />
      </Box>
      {gaugeWidth && usage ? (
        <Box position="absolute" left={rect.width - rightW} width={rightW} flexDirection="row">
          <MoonGauge label="session" window={usage.session} theme={theme} width={gaugeWidth} bg={bg} compact />
          <Text backgroundColor={bg}> </Text>
          <MoonGauge label="week" window={usage.week} theme={theme} width={gaugeWidth} bg={bg} compact />
        </Box>
      ) : null}
    </Box>
  );
}

export function Header({ hub, project, rect, now }: { hub: Hub; project: Project; rect: Rect; now: number }) {
  const c = hub.theme.colors;
  const t = project.totals();
  const lead = project.lead;
  const left: Seg[] = [
    { text: "◆ ", color: c.accent },
    { text: lead?.name ?? project.name, color: c.text, bold: true },
    { text: ` ×${t.agents}`, color: c.accent2 },
    { text: " · ", color: c.faint },
    { text: project.name, color: c.muted },
    { text: " · ", color: c.faint },
    { text: formatElapsed(now - project.createdAt), color: c.muted },
  ];
  if (!project.trusted) {
    left.push({ text: " · ", color: c.faint }, { text: "▲ untrusted (/trust)", color: c.warning });
  }
  const right: Seg[] = [
    { text: `↓ ${formatTokens(t.tokens)}`, color: c.muted },
    { text: " · ", color: c.faint },
    { text: formatCost(t.costUsd), color: c.muted },
  ];
  return <Line rect={rect} left={left} right={right} bg={c.bg} />;
}

export function Footer({ hub, project, rect }: { hub: Hub; project: Project | undefined; rect: Rect }) {
  const c = hub.theme.colors;
  if (!project) {
    return (
      <Line
        rect={rect}
        left={[{ text: "ctrl+t open a project · ctrl+k commands · ctrl+l sign in · ? help · ctrl+q quit", color: c.faint }]}
        bg={c.bg}
      />
    );
  }
  if (hub.homeShown) {
    return (
      <Line
        rect={rect}
        left={[
          { text: "esc ", color: c.faint },
          { text: `back to ${project.name}`, color: c.muted },
          { text: " · alt+1..9 tabs · ↑↓ enter recent · ctrl+t open · ctrl+k commands · ? help · ctrl+q quit", color: c.faint },
        ]}
        bg={c.bg}
      />
    );
  }
  const t = project.totals();
  const workers = project.agents.filter((a) => a.role !== "lead");
  const runningWorkers = workers.filter((a) => a.busy).length;
  const leadBusy = project.lead?.busy ?? false;
  const studio = hub.roblox.status();
  const left: Seg[] = [
    { text: "● ", color: t.running ? c.success : c.faint },
    { text: leadBusy ? "lead" : "lead idle", color: c.muted },
    { text: ` + ${runningWorkers}/${workers.length} running`, color: c.muted },
    { text: " · ", color: c.faint },
    { text: PERMISSION_LABELS[project.permissionMode], color: project.permissionMode === "yolo" ? c.warning : c.accent2 },
    { text: " (shift+tab)", color: c.faint },
  ];
  if (studio.connected) {
    left.push({ text: " · ", color: c.faint }, { text: `◆ studio${studio.place ? ` ${studio.place.name}` : ""}`, color: c.success });
  } else if (studio.needsReinstall) {
    left.push({ text: " · ", color: c.faint }, { text: "▲ studio: reinstall the plugin (/roblox)", color: c.warning });
  }
  const right: Seg[] = [
    { text: `Σ ${formatTokens(hub.stats.totalTokens())} `, color: c.faint },
    { text: `+${formatCount(t.added)}`, color: c.success },
    { text: " ", color: c.faint },
    { text: `-${formatCount(t.removed)}`, color: c.error },
    { text: "  ctrl+k ", color: c.faint },
    { text: "? help", color: c.faint },
  ];
  return <Line rect={rect} left={left} right={right} bg={c.bg} />;
}

export function Toasts({ toasts, theme, width }: { toasts: Toast[]; theme: Theme; width: number }) {
  if (!toasts.length) return null;
  const c = theme.colors;
  // Wider on wide terminals, and wrapped (up to three lines) instead of cut after the first.
  const maxW = Math.min(Math.max(64, Math.floor(width / 2)), Math.max(20, width - 4));
  return (
    <Box position="absolute" top={2} left={Math.max(0, width - maxW - 2)} width={maxW} flexDirection="column">
      {toasts.flatMap((t) => {
        const color = t.level === "error" ? c.error : t.level === "warning" ? c.warning : t.level === "success" ? c.success : c.accent2;
        const mark = t.level === "error" ? "✗" : t.level === "warning" ? "▲" : t.level === "success" ? "✓" : "◆";
        const lines = wrap(t.text, maxW - 4);
        const shown = lines.length > 3 ? [...lines.slice(0, 2), truncate(lines.slice(2).join(" "), maxW - 4)] : lines;
        return shown.map((line, i) => (
          <Text key={`${t.id}-${i}`} backgroundColor={c.popover} wrap="truncate">
            <Text color={color} backgroundColor={c.popover}>{i === 0 ? ` ${mark} ` : "   "}</Text>
            <Text color={c.text} backgroundColor={c.popover}>{line}</Text>
            <Text backgroundColor={c.popover}>{" ".repeat(Math.max(1, maxW - 3 - textWidth(line)))}</Text>
          </Text>
        ));
      })}
    </Box>
  );
}
