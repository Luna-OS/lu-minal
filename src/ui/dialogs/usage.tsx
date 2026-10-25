// The Usage view, laid out like the Claude app's: the context window of every model in use, the
// Claude plan (current session, weekly limits for all models and per model, extra usage), and the
// other providers in use with their credits and today's tokens.
import { Text, useInput, useWindowSize } from "ink";
import React, { useState } from "react";
import type { Agent } from "../../core/agent.js";
import type { Hub } from "../../core/hub.js";
import type { Project } from "../../core/project.js";
import type { UsageWindow } from "../../core/types.js";
import type { Theme } from "../../themes/types.js";
import { formatCost, formatTokens } from "../format.js";
import type { Row, Seg } from "../log-lines.js";
import { RowView } from "../components/RowView.js";
import { DialogBox } from "./ListDialog.js";

/** 1_000_000 → "1M", 262_144 → "262k", 1_048_576 → "1M". */
export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** "in 4h 56m" within a day, otherwise "Fri 01:00" (local time). */
export function formatResetAt(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 0) return "now";
  if (ms < 24 * 3_600_000) {
    const m = Math.round(ms / 60_000);
    const h = Math.floor(m / 60);
    return h ? `in ${h}h ${String(m % 60).padStart(2, "0")}m` : `in ${m}m`;
  }
  const d = new Date(at);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function barColor(util: number, theme: Theme): string {
  if (util >= 0.9) return theme.colors.error;
  if (util >= 0.75) return theme.colors.warning;
  return theme.colors.accent2;
}

/** A thin bar: the filled part in the gauge colour, the rest as a faint track. */
export function barSegs(util: number, width: number, theme: Theme, color?: string): Seg[] {
  const w = Math.max(4, width);
  const u = Math.max(0, Math.min(1, util));
  const filled = u > 0 ? Math.max(1, Math.round(u * w)) : 0;
  return [
    { text: "━".repeat(filled), color: color ?? barColor(u, theme) },
    { text: "━".repeat(w - filled), color: theme.colors.selection },
  ];
}

const pct = (u: number) => `${Math.round(u * 100)}% used`;

/** A heading row, a title row with the right-aligned percentage, a bar and a caption. */
function meter(key: string, title: string, util: number, caption: string, width: number, theme: Theme, color?: string): Row[] {
  const c = theme.colors;
  const right = pct(util);
  const gap = Math.max(1, width - title.length - right.length);
  return [
    { key: `${key}:t`, segs: [{ text: title, color: c.text, bold: true }, { text: " ".repeat(gap) }, { text: right, color: c.muted }] },
    { key: `${key}:b`, segs: barSegs(util, width, theme, color) },
    { key: `${key}:c`, segs: [{ text: caption, color: c.faint }] },
    { key: `${key}:s`, segs: [] },
  ];
}

function heading(key: string, text: string, theme: Theme, note?: string): Row {
  return {
    key,
    segs: [{ text, color: theme.colors.accent, bold: true }, ...(note ? [{ text: `  ${note}`, color: theme.colors.faint } as Seg] : [])],
  };
}

function shortModel(agent: Agent): string {
  const m = agent.model.model;
  return agent.model.provider === "claude-code" ? `claude ${m}` : m.slice(m.lastIndexOf("/") + 1);
}

function contextWindowOf(hub: Hub, agent: Agent): number | null {
  if (agent.contextWindow) return agent.contextWindow;
  const info = hub.registry.model(agent.model);
  if (info?.contextWindow) return info.contextWindow;
  if (agent.model.provider === "claude-code") {
    // An alias ("opus"): the newest Anthropic model of that family.
    const family = agent.model.model === "default" ? "sonnet" : agent.model.model;
    const match = hub.registry
      .models("anthropic", { includeDeprecated: true })
      .find((m) => m.id.includes(family) && m.contextWindow);
    if (match?.contextWindow) return match.contextWindow;
  }
  return null;
}

function windowMeter(key: string, title: string, w: UsageWindow, width: number, theme: Theme, now: number): Row[] {
  return meter(key, title, w.utilization, w.resetsAt ? `Resets ${formatResetAt(w.resetsAt, now)}` : "", width, theme);
}

/** Every row of the Usage view (pure, so it is tested without a terminal). */
export function usageRows(hub: Hub, width: number, now = Date.now()): Row[] {
  const theme = hub.theme;
  const c = theme.colors;
  const rows: Row[] = [];
  const projects: Project[] = hub.projects;
  const agents = projects.flatMap((p) => p.agents.map((a) => ({ p, a })));

  // ---- context windows -------------------------------------------------------------------------
  rows.push(heading("ctx", "Context", theme, "the window of every model in use"));
  if (!agents.length) rows.push({ key: "ctx:none", segs: [{ text: "No agents yet.", color: c.faint }] }, { key: "ctx:s", segs: [] });
  for (const { p, a } of agents) {
    const windowSize = contextWindowOf(hub, a);
    const title = `${a.name} · ${shortModel(a)}${projects.length > 1 ? ` · ${p.name}` : ""}`;
    if (windowSize) {
      rows.push(...meter(`ctx:${a.id}`, title, a.contextTokens / windowSize, `${a.contextTokens.toLocaleString("en-US")} of ${formatWindow(windowSize)} tokens`, width, theme));
    } else {
      rows.push(
        { key: `ctx:${a.id}:t`, segs: [{ text: title, color: c.text, bold: true }] },
        { key: `ctx:${a.id}:c`, segs: [{ text: `${a.contextTokens.toLocaleString("en-US")} tokens (window size unknown)`, color: c.faint }] },
        { key: `ctx:${a.id}:s`, segs: [] },
      );
    }
  }

  // ---- the Claude plan -------------------------------------------------------------------------
  const acc = hub.claudeAccount;
  const usage = hub.planUsage;
  const usesClaude = agents.some(({ a }) => a.model.provider === "claude-code") || Boolean(acc?.loggedIn);
  if (usesClaude) {
    rows.push(heading("plan", "Plan usage", theme, [acc?.plan ? `Claude ${acc.plan}` : "Claude", acc?.email].filter(Boolean).join(" · ")));
    if (!acc?.installed) {
      rows.push({ key: "plan:x", segs: [{ text: "Claude Code is not installed - /login claude", color: c.warning }] }, { key: "plan:s", segs: [] });
    } else if (!acc.loggedIn) {
      rows.push({ key: "plan:x", segs: [{ text: "Not signed in - /login claude", color: c.warning }] }, { key: "plan:s", segs: [] });
    } else if (!usage || (!usage.session && !usage.week)) {
      rows.push(
        {
          key: "plan:x",
          segs: [
            {
              text: hub.usageError ?? "The limits show up with a Claude agent's first answer (Claude Code reports them with every reply).",
              color: c.faint,
            },
          ],
        },
        { key: "plan:s", segs: [] },
      );
    } else {
      if (usage.session) rows.push(...windowMeter("plan:session", "Current session", usage.session, width, theme, now));
      if (usage.week || usage.models.length) rows.push(heading("weekly", "Weekly limits", theme));
      if (usage.week) rows.push(...windowMeter("plan:week", "All models", usage.week, width, theme, now));
      for (const m of usage.models) rows.push(...windowMeter(`plan:m:${m.name}`, `${m.name} only`, m, width, theme, now));
      if (usage.extra) {
        rows.push(heading("extra", "Credits", theme, "extra usage beyond the plan"));
        const x = usage.extra;
        if (!x.enabled) {
          rows.push({ key: "extra:off", segs: [{ text: "Extra usage is off.", color: c.faint }] }, { key: "extra:s", segs: [] });
        } else if (x.limit && x.used !== null) {
          const money = (cents: number) => `${(cents / 100).toFixed(2)} ${x.currency ?? ""}`.trim();
          rows.push(...meter("extra:m", "Extra usage", x.used / x.limit, `${money(x.used)} of ${money(x.limit)} this month`, width, theme));
        } else {
          rows.push({ key: "extra:on", segs: [{ text: "Extra usage is on.", color: c.muted }] }, { key: "extra:s", segs: [] });
        }
      }
      rows.push({ key: "plan:at", segs: [{ text: `Read ${formatResetAt(now + (now - usage.at), now).replace(/^in /, "")} ago`, color: c.faint }] }, { key: "plan:s2", segs: [] });
    }
  }

  // ---- other providers in use ------------------------------------------------------------------
  const stats = hub.stats.summary(now);
  const others = new Map<string, Agent[]>();
  for (const { a } of agents) {
    if (a.model.provider === "claude-code") continue;
    const key = `${a.model.provider}/${a.model.model}`;
    others.set(key, [...(others.get(key) ?? []), a]);
  }
  if (others.size) rows.push(heading("other", "Other models in use", theme, "today"));
  const shownBalance = new Set<string>();
  for (const [key, list] of others) {
    const provider = list[0].model.provider;
    const info = hub.registry.model(list[0].model);
    const today = stats.todayByModel[key];
    const price = info?.free ? "free" : today ? formatCost(today.costUsd) : "$0";
    rows.push({
      key: `other:${key}:t`,
      segs: [
        { text: key, color: c.text, bold: true },
        { text: `  ${list.map((a) => a.name).join(", ")}`, color: c.faint },
      ],
    });
    rows.push({
      key: `other:${key}:c`,
      segs: [{ text: `${formatTokens((today?.input ?? 0) + (today?.output ?? 0))} tokens · ${price}${today ? ` · ${today.turns} turns` : ""}`, color: c.muted }],
    });
    const balance = hub.balances.get(provider);
    if (balance && !shownBalance.has(provider)) {
      shownBalance.add(provider);
      if (balance.limit) {
        rows.push(...meter(`other:${provider}:bal`, `${balance.label} credits`, (balance.used ?? 0) / balance.limit, `$${(balance.used ?? 0).toFixed(2)} of $${balance.limit.toFixed(2)}`, width, theme));
      } else {
        rows.push({ key: `other:${provider}:bal`, segs: [{ text: `${balance.label}: $${(balance.used ?? 0).toFixed(2)} used, no limit`, color: c.faint }] });
      }
    }
    rows.push({ key: `other:${key}:s`, segs: [] });
  }

  // ---- totals ----------------------------------------------------------------------------------
  rows.push(heading("tot", "Tokens", theme, "/stats for more"));
  rows.push({
    key: "tot:r",
    segs: [
      { text: `today ${formatTokens(stats.today.input + stats.today.output)}`, color: c.muted },
      { text: " · ", color: c.faint },
      { text: `7 days ${formatTokens(stats.week.input + stats.week.output)}`, color: c.muted },
      { text: " · ", color: c.faint },
      { text: `all time ${formatTokens(stats.allTime.input + stats.allTime.output)}`, color: c.text },
      { text: ` · ${formatCost(stats.allTime.costUsd)}`, color: c.faint },
    ],
  });
  return rows;
}

export function UsageDialog({ hub, onClose }: { hub: Hub; onClose: () => void }) {
  const size = useWindowSize();
  const [scroll, setScroll] = useState(0);
  const width = Math.min(84, size.columns - 2);
  const inner = width - 4;
  const rows = usageRows(hub, inner);
  const height = Math.min(Math.max(10, rows.length + 4), Math.max(8, size.rows - 4));
  const room = height - 4;
  const max = Math.max(0, rows.length - room);
  const top = Math.min(scroll, max);
  useInput((input, key) => {
    if (key.escape || key.return) return onClose();
    if (input === "r") {
      void hub.refreshUsage();
      void hub.refreshBalances();
      return;
    }
    if (key.downArrow) setScroll((s) => Math.min(max, s + 1));
    if (key.upArrow) setScroll((s) => Math.max(0, s - 1));
    if (key.pageDown) setScroll((s) => Math.min(max, s + room));
    if (key.pageUp) setScroll((s) => Math.max(0, s - room));
  });
  const c = hub.theme.colors;
  return (
    <DialogBox theme={hub.theme} width={width} height={height} title="Usage" subtitle={max ? `${top + 1}-${Math.min(rows.length, top + room)} of ${rows.length}` : undefined} hints="↑↓ scroll · r refresh · esc close">
      {rows.slice(top, top + room).map((row) => (
        <RowView key={row.key} row={row} width={inner} bg={c.popover} />
      ))}
      {rows.length === 0 ? <Text color={c.faint}>Nothing to show yet.</Text> : null}
    </DialogBox>
  );
}
