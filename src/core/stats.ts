// Token statistics that outlive the session: every bit of usage an agent reports is added to a
// small ledger (stats.json in the state dir), grouped by day, by model and by project. The Stats
// dialog reads totals, the last days and the top models from it.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../platform/files.js";

export interface UsageAmount {
  input: number;
  output: number;
  costUsd: number;
  /** Model turns (requests) that reported usage. */
  turns: number;
}

export interface StatsFile {
  version: 1;
  /** The first day anything was recorded ("2026-10-25"). */
  since: string | null;
  /** day → "provider/model" → amounts */
  days: Record<string, Record<string, UsageAmount>>;
  /** project folder → amounts */
  projects: Record<string, UsageAmount & { name: string; lastUsed: number }>;
  /** Agents started, by provider. */
  agents: Record<string, number>;
  /** Lines added / removed by agents. */
  lines: { added: number; removed: number };
}

export interface UsageRecord {
  at: number;
  provider: string;
  model: string;
  project: { cwd: string; name: string };
  input: number;
  output: number;
  costUsd: number;
  /** Model turns this report closes (1 when left out). */
  turns?: number;
}

export interface StatsSummary {
  allTime: UsageAmount;
  today: UsageAmount;
  week: UsageAmount;
  month: UsageAmount;
  /** The last `days` days, oldest first, with zero days filled in. */
  daily: Array<{ day: string } & UsageAmount>;
  models: Array<{ model: string } & UsageAmount>;
  /** Today's usage per "provider/model". */
  todayByModel: Record<string, UsageAmount>;
  providers: Array<{ provider: string } & UsageAmount>;
  projects: Array<{ cwd: string; name: string; lastUsed: number } & UsageAmount>;
  agents: Record<string, number>;
  lines: { added: number; removed: number };
  since: string | null;
}

const zero = (): UsageAmount => ({ input: 0, output: 0, costUsd: 0, turns: 0 });

function bucket(map: Map<string, UsageAmount>, key: string): UsageAmount {
  let u = map.get(key);
  if (!u) map.set(key, (u = zero()));
  return u;
}

function add(into: UsageAmount, u: UsageAmount): void {
  into.input += u.input;
  into.output += u.output;
  into.costUsd += u.costUsd;
  into.turns += u.turns;
}

/** The local calendar day of a time, "YYYY-MM-DD". */
export function dayKey(at: number): string {
  const d = new Date(at);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function emptyFile(): StatsFile {
  return { version: 1, since: null, days: {}, projects: {}, agents: {}, lines: { added: 0, removed: 0 } };
}

export class StatsStore {
  private data: StatsFile;
  private dirty = false;
  private total: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string | null,
    private readonly saveDelayMs = 3000,
  ) {
    this.data = this.read();
  }

  private read(): StatsFile {
    if (!this.file) return emptyFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StatsFile>;
      if (!parsed || parsed.version !== 1) return emptyFile();
      return { ...emptyFile(), ...parsed, lines: { added: 0, removed: 0, ...(parsed.lines ?? {}) } } as StatsFile;
    } catch {
      return emptyFile();
    }
  }

  /** Adds one usage report. */
  record(r: UsageRecord): void {
    if (!r.input && !r.output && !r.costUsd && !r.turns) return;
    const day = dayKey(r.at);
    const key = `${r.provider}/${r.model}`;
    const amount: UsageAmount = { input: r.input, output: r.output, costUsd: r.costUsd, turns: r.turns ?? 1 };
    const byModel = (this.data.days[day] ??= {});
    add((byModel[key] ??= zero()), amount);
    if (this.total !== null) this.total += r.input + r.output;
    const project = (this.data.projects[r.project.cwd] ??= { ...zero(), name: r.project.name, lastUsed: r.at });
    add(project, amount);
    project.name = r.project.name;
    project.lastUsed = r.at;
    if (!this.data.since || day < this.data.since) this.data.since = day;
    this.touch();
  }

  agentStarted(provider: string): void {
    this.data.agents[provider] = (this.data.agents[provider] ?? 0) + 1;
    this.touch();
  }

  addLines(added: number, removed: number): void {
    if (!added && !removed) return;
    this.data.lines.added += added;
    this.data.lines.removed += removed;
    this.touch();
  }

  /** All tokens ever counted (read + written), cheap enough to show on every frame. */
  totalTokens(): number {
    if (this.total === null) {
      let t = 0;
      for (const byModel of Object.values(this.data.days)) for (const u of Object.values(byModel)) t += u.input + u.output;
      this.total = t;
    }
    return this.total;
  }

  summary(now = Date.now(), days = 14): StatsSummary {
    const allTime = zero();
    const today = zero();
    const week = zero();
    const month = zero();
    const models = new Map<string, UsageAmount>();
    const providers = new Map<string, UsageAmount>();
    const todayKey = dayKey(now);
    const weekStart = dayKey(now - 6 * 86_400_000);
    const monthStart = dayKey(now - 29 * 86_400_000);
    for (const [day, byModel] of Object.entries(this.data.days)) {
      for (const [model, u] of Object.entries(byModel)) {
        add(allTime, u);
        if (day === todayKey) add(today, u);
        if (day >= weekStart) add(week, u);
        if (day >= monthStart) add(month, u);
        add(bucket(models, model), u);
        add(bucket(providers, model.slice(0, model.indexOf("/"))), u);
      }
    }
    const daily: StatsSummary["daily"] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = dayKey(now - i * 86_400_000);
      const total = zero();
      for (const u of Object.values(this.data.days[day] ?? {})) add(total, u);
      daily.push({ day, ...total });
    }
    const byTokens = <T extends UsageAmount>(a: T, b: T) => b.input + b.output - (a.input + a.output);
    return {
      allTime,
      today,
      week,
      month,
      daily,
      models: [...models].map(([model, u]) => ({ model, ...u })).sort(byTokens),
      todayByModel: Object.fromEntries(Object.entries(this.data.days[todayKey] ?? {}).map(([m, u]) => [m, { ...u }])),
      providers: [...providers].map(([provider, u]) => ({ provider, ...u })).sort(byTokens),
      projects: Object.entries(this.data.projects)
        .map(([cwd, u]) => ({ cwd, ...u }))
        .sort(byTokens),
      agents: { ...this.data.agents },
      lines: { ...this.data.lines },
      since: this.data.since,
    };
  }

  reset(): void {
    this.data = emptyFile();
    this.total = null;
    this.touch();
  }

  private touch(): void {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.saveDelayMs);
    this.timer.unref();
  }

  /** Writes pending changes now (also called on exit). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomicSync(this.file, JSON.stringify(this.data));
      this.dirty = false;
    } catch {
      // Statistics are a nicety; a failed write is retried with the next change.
    }
  }
}
