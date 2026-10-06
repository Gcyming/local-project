import { ContributionScope } from "./scope.js";
import type { DisposeReport } from "./scope.js";
import type { PluginManifest } from "./manifest.js";

export type PluginStatus = "loaded" | "disabled" | "failed";

export interface PluginRecord {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  contributions: string[];
  /** 系统默认插件（origin === "builtin"）不可卸载 */
  unloadable: boolean;
}

export interface PluginContributionHandle {
  /** 展示名，用于 contributions 列表 */
  label: string;
  dispose: () => void | Promise<void>;
}

export interface PluginHostOptions {
  /** 登记工具贡献；返回要 track 进 scope 的撤销函数（label 用于 contributions 展示） */
  registerTools?: (manifest: PluginManifest) => PluginContributionHandle[];
  /** 登记指令（技能）贡献 */
  registerInstructions?: (manifest: PluginManifest) => PluginContributionHandle[];
  /** 可覆盖默认的「是否可卸载」判定；默认 origin !== "builtin" */
  unloadable?: (manifest: PluginManifest) => boolean;
}

interface HostEntry {
  record: PluginRecord;
  scope: ContributionScope | null;
}

export const WIRING_PENDING = "尚未接线";

export class PluginHost {
  private entries = new Map<string, HostEntry>();
  private order: string[] = [];
  private registerTools: ((manifest: PluginManifest) => PluginContributionHandle[]) | null;
  private registerInstructions: ((manifest: PluginManifest) => PluginContributionHandle[]) | null;
  private unloadable: (manifest: PluginManifest) => boolean;

  constructor(opts: PluginHostOptions) {
    this.registerTools = opts.registerTools ?? null;
    this.registerInstructions = opts.registerInstructions ?? null;
    this.unloadable = opts.unloadable ?? ((m) => m.origin !== "builtin");
  }

  list(): PluginRecord[] {
    return this.order.map((n) => this.entries.get(n)!.record);
  }

  get(name: string): PluginRecord | undefined {
    return this.entries.get(name)?.record;
  }

  async unload(name: string): Promise<DisposeReport> {
    const entry = this.entries.get(name);
    if (!entry) {
      return { ok: 0, failed: [] };
    }
    if (!entry.record.unloadable) {
      return {
        ok: 0,
        failed: [{ index: 0, error: new Error(`插件 '${name}' 是系统默认插件，不可卸载`) }],
      };
    }
    const report = entry.scope ? await entry.scope.disposeAll() : { ok: 0, failed: [] };
    entry.scope = null;
    entry.record.status = "disabled";
    entry.record.contributions = [];
    return report;
  }

  /**
   * 全量装配（reconcile）：先撤销上一轮全部贡献，再按新清单重建。
   *
   * A-1195：此前直接 entries.clear() —— 旧 scope 连同 disposer 一起被丢弃，
   * 「绕过接线层直接调 load 重装」会永久泄漏句柄（技能留在注册表里再也撤不掉）。
   * 现在撤销是重建的前置条件（async 等待完成，新旧世界不交错 —— 否则旧撤销会
   * 摘掉新装配记录的名字）；单条撤销失败不阻断重建，但如实 console.error（不静默）。
   */
  async load(manifests: PluginManifest[]): Promise<PluginRecord[]> {
    await this.disposeAllEntries();
    this.entries.clear();
    this.order = [];
    const nodes = new Map<string, PluginManifest>();
    const duplicates = new Set<string>();
    for (const manifest of manifests) {
      if (nodes.has(manifest.name)) {
        duplicates.add(manifest.name);
        continue;
      }
      nodes.set(manifest.name, manifest);
      this.order.push(manifest.name);
    }

    const failed = new Map<string, string>();
    for (const name of duplicates) {
      failed.set(name, `插件名重复：'${name}' 在清单中出现多次`);
    }
    for (const name of this.order) {
      if (failed.has(name)) {
        continue;
      }
      const gaps = (nodes.get(name)!.requires ?? []).filter((dep) => !nodes.has(dep));
      if (gaps.length > 0) {
        failed.set(name, `缺少依赖插件：${gaps.join("、")}`);
      }
    }

    const settled = this.topoSort(nodes, failed);
    this.order = settled.filter((name) => this.order.includes(name));

    for (const name of this.order) {
      const manifest = nodes.get(name)!;
      this.entries.set(name, {
        record: {
          manifest,
          status: "disabled",
          contributions: [],
          unloadable: this.unloadable(manifest),
        },
        scope: null,
      });
    }

    for (const name of settled) {
      const entry = this.entries.get(name);
      if (!entry) {
        continue;
      }

      const error = failed.get(name);
      if (error !== undefined) {
        entry.record.status = "failed";
        entry.record.error = error;
        continue;
      }
      this.activate(entry);
    }

    return this.list();
  }

  /** A-1195：逆序（依赖者先撤）撤销当前全部 scope；失败项如实上报、不中断。 */
  private async disposeAllEntries(): Promise<void> {
    const names = [...this.order].reverse();
    for (const name of names) {
      const entry = this.entries.get(name);
      if (!entry?.scope) {
        continue;
      }
      const report = await entry.scope.disposeAll();
      for (const f of report.failed) {
        console.error(
          `[plugin-host] 插件 '${name}' 的贡献撤销失败（第 ${f.index} 个）：${f.error instanceof Error ? f.error.message : String(f.error)}`,
        );
      }
      entry.scope = null;
    }
  }

  private topoSort(nodes: Map<string, PluginManifest>, failed: Map<string, string>): string[] {
    const emitted = new Set<string>();
    const loadable = new Set<string>();
    const order: string[] = [];
    const inputOrder = [...nodes.keys()];

    let progress = true;
    while (progress) {
      progress = false;
      for (const name of inputOrder) {
        if (emitted.has(name)) {
          continue;
        }
        const gap = (nodes.get(name)?.requires ?? []).find((dep) => failed.has(dep));
        if (gap !== undefined) {
          failed.set(name, `依赖的插件 '${gap}' 加载失败`);
          emitted.add(name);
          order.push(name);
          progress = true;
          continue;
        }
        const deps: string[] = nodes.get(name)?.requires ?? [];
        if (!deps.every((dep) => loadable.has(dep))) {
          continue;
        }
        emitted.add(name);
        loadable.add(name);
        order.push(name);
        progress = true;
      }
    }

    for (const name of inputOrder) {
      if (emitted.has(name)) {
        continue;
      }
      failed.set(name, `无法确定加载顺序（循环依赖）：${this.describeCycle(name, nodes, emitted)}`);
      emitted.add(name);
      order.push(name);
    }

    return order;
  }

  private describeCycle(
    start: string,
    nodes: Map<string, PluginManifest>,
    settled: Set<string>,
  ): string {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      const deps: string[] = nodes.get(current)?.requires ?? [];
      current = deps.find((dep) => !settled.has(dep));
    }
    if (current !== undefined && seen.has(current)) {
      chain.push(current);
    }
    return chain.join(" → ");
  }

  private activate(entry: HostEntry): void {
    const manifest = entry.record.manifest;
    const scope = new ContributionScope();
    const contributions: string[] = [];

    for (const kind of manifest.provides) {
      if (kind === "tools") {
        contributions.push(`tools:${this.contribute(scope, this.registerTools, manifest)}`);
      } else if (kind === "instructions") {
        contributions.push(
          `instructions:${this.contribute(scope, this.registerInstructions, manifest)}`,
        );
      } else {
        contributions.push(`${kind}:${WIRING_PENDING}`);
      }
    }

    entry.scope = scope;
    entry.record.status = "loaded";
    entry.record.error = undefined;
    entry.record.contributions = contributions;
  }

  /**
   * 调用宿主注入的登记钩子，把返回的撤销函数 track 进 scope。
   * 钩子缺失或登记为空 ⇒ 该贡献不登记，如实记「尚未接线」，不假装已生效。
   */
  private contribute(
    scope: ContributionScope,
    hook: ((manifest: PluginManifest) => PluginContributionHandle[]) | null,
    manifest: PluginManifest,
  ): string {
    if (!hook) {
      return WIRING_PENDING;
    }
    const handles = hook(manifest);
    if (handles.length === 0) {
      return WIRING_PENDING;
    }
    for (const handle of handles) {
      scope.track(() => handle.dispose());
    }
    return handles.map((handle) => handle.label).join("/");
  }
}
