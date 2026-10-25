// The model picker: free models first, then the signed-in providers' models, and a search over
// every provider in the catalog. Typing "provider/any-id" offers that id as it is.
import React from "react";
import type { Hub } from "../../core/hub.js";
import { formatModelRef, parseModelRef, type ModelInfo, type ModelRef } from "../../providers/models.js";
import type { UiServices } from "../store.js";
import { ListDialog, type ListItem } from "./ListDialog.js";

function contextLabel(n: number | null): string {
  if (!n) return "";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M ctx` : `${Math.round(n / 1000)}k ctx`;
}

function priceLabel(m: ModelInfo): string {
  if (m.provider === "claude-code") return "your plan";
  if (m.free) return "free";
  if (!m.cost) return "";
  const f = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, ""));
  return `$${f(m.cost.input)}/$${f(m.cost.output)}`;
}

export function modelItem(hub: Hub, m: ModelInfo, group?: string): ListItem {
  const connected = hub.registry.isConnected(m.provider);
  const ref = formatModelRef({ provider: m.provider, model: m.id });
  const hint = [m.name !== m.id ? m.name : "", contextLabel(m.contextWindow), priceLabel(m)].filter(Boolean).join(" · ");
  const c = hub.theme.colors;
  return {
    id: ref,
    label: ref,
    hint,
    group,
    keywords: `${m.name} ${m.free ? "free" : ""}`,
    badge: m.free
      ? { text: connected ? "free" : "free ○", color: c.success }
      : connected
        ? { text: "✓", color: c.success }
        : { text: "sign in", color: c.faint },
  };
}

/** The picker's list without a query: free models, then each connected provider's newest models. */
export function defaultModelItems(hub: Hub): ListItem[] {
  const items: ListItem[] = [];
  const seen = new Set<string>();
  const add = (m: ModelInfo, group: string) => {
    const item = modelItem(hub, m, group);
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };
  for (const m of hub.registry.models("claude-code").slice(0, 8)) add(m, "Claude (your subscription)");
  for (const m of hub.registry.freeModels({ connectedOnly: false }).slice(0, 24)) add(m, "Free models");
  for (const p of hub.registry.providers()) {
    if (p.id === "claude-code" || !p.supported || !hub.registry.isConnected(p.id)) continue;
    if (p.auth === "optional" || p.auth === "none") {
      if (p.kind !== "local") continue;
    }
    for (const m of hub.registry.models(p.id).slice(0, 10)) add(m, p.name);
  }
  return items;
}

export function openModelPicker(
  hub: Hub,
  ui: UiServices,
  opts: { title?: string; current?: ModelRef; onPick: (ref: ModelRef) => void },
): void {
  const id = `models-${Date.now()}`;
  ui.openDialog({
    id,
    render: (close) => <ModelPicker hub={hub} title={opts.title} current={opts.current} onCancel={close} onPick={(ref) => {
      close();
      opts.onPick(ref);
    }} />,
  });
}

function ModelPicker(props: { hub: Hub; title?: string; current?: ModelRef; onPick: (ref: ModelRef) => void; onCancel: () => void }) {
  const { hub } = props;
  const [query, setQuery] = React.useState("");
  const items = React.useMemo(() => {
    if (!query.trim()) return defaultModelItems(hub);
    const found = hub.registry.search(query, 80).map((m) => modelItem(hub, m));
    const typed = parseModelRef(query.trim());
    if (typed && hub.registry.provider(typed.provider) && !found.some((f) => f.id === formatModelRef(typed))) {
      found.unshift({
        id: formatModelRef(typed),
        label: formatModelRef(typed),
        hint: "use this id as typed",
        badge: { text: "custom", color: hub.theme.colors.accent2 },
      });
    }
    return found;
  }, [hub, query]);
  return (
    <ListDialog
      theme={hub.theme}
      title={props.title ?? "Pick a model"}
      subtitle={hub.catalogSource === "fallback" ? "offline catalog" : `${hub.registry.providers().length} providers`}
      items={items}
      onQuery={setQuery}
      placeholder="Search models: opus, free, minimax, openrouter qwen, or provider/model-id"
      initialId={props.current ? formatModelRef(props.current) : undefined}
      onSelect={(item) => {
        const ref = parseModelRef(item.id);
        if (!ref) return;
        if (!hub.registry.isConnected(ref.provider)) {
          hub.toast(hub.registry.connectionHint(ref.provider), "warning");
        }
        props.onPick(ref);
      }}
      onCancel={props.onCancel}
      hints="↑↓ move · enter pick · type to search all providers · esc close"
      empty="No model matches. Try a provider name, or type provider/model-id."
    />
  );
}
