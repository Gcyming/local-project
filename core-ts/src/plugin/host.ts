import { ContributionScope } from "./scope.js";
import type { DisposeReport } from "./scope.js";
import type { PluginManifest } from "./manifest.js";
import { describePluginSettings, describePluginUi, describePluginScripts, describePluginTheme } from "./contributes.js";
import { describeMode } from "./mode.js";

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
  /** A-1197 · B2（L4a）：登记 UI 槽位贡献（主进程侧维护 slot 汇总表）；返回撤销函数。 */
  registerUi?: (manifest: PluginManifest) => PluginContributionHandle[];
  /** A-1197 · B4（T1 脚本信任）：装配**脚本工具**（仅在用户信任该插件的脚本后，
   *  由主进程实现读 `trust.json` 判断；未信任 ⇒ 返回空 ⇒ 记「尚未接线」）。 */
  registerScripts?: (manifest: PluginManifest) => PluginContributionHandle[];
  /** A-1197 · B5（L4a page）：登记扩展**自有页面**（按需起 127.0.0.1 静态服务；
   *  dispose 负责 stop —— 服务泄漏的兜底，见设计 §4.1「失控时怎么兜」）。 */
  registerPage?: (manifest: PluginManifest) => PluginContributionHandle[];
  /** A-1198 · 主题贡献点（皮肤）：登记**声明式设计令牌**（主进程侧维护主题汇总表）。
   *  纯数据、无副作用 —— 撤销 = 按插件名精确移除（渲染层按 `plugins_changed` 重算并回落默认）。 */
  registerTheme?: (manifest: PluginManifest) => PluginContributionHandle[];
  /** A-1197 · B3（L4c）第二层：**装载时查一次**模式声明的工具名（由**有工具表**的装配侧注入）。
   *  返回该清单里「不存在于当前工具表」的工具名；非空 ⇒ 该插件 `failed`（不给
   *  「配了但不生效」的假自由度，设计 §4.3）。运行前每阶段还会重查（执行侧）。 */
  checkModeTools?: (manifest: PluginManifest) => string[];
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
  private registerUi: ((manifest: PluginManifest) => PluginContributionHandle[]) | null;
  private registerScripts: ((manifest: PluginManifest) => PluginContributionHandle[]) | null;
  private registerPage: ((manifest: PluginManifest) => PluginContributionHandle[]) | null;
  private registerTheme: ((manifest: PluginManifest) => PluginContributionHandle[]) | null;
  private checkModeTools: ((manifest: PluginManifest) => string[]) | null;
  private unloadable: (manifest: PluginManifest) => boolean;

  constructor(opts: PluginHostOptions) {
    this.registerTools = opts.registerTools ?? null;
    this.registerInstructions = opts.registerInstructions ?? null;
    this.registerUi = opts.registerUi ?? null;
    this.registerScripts = opts.registerScripts ?? null;
    this.registerPage = opts.registerPage ?? null;
    this.registerTheme = opts.registerTheme ?? null;
    this.checkModeTools = opts.checkModeTools ?? null;
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
    /* A-1197 · B3（L4c）第二层其一：**装载时查一次**模式声明的工具名。
       装配侧没注入钩子（纯层不知道工具表）⇒ 不查、留运行前重查兜底；
       注入了但返回空数组 = 「当前工具表判不了」（如引擎尚未装配）——
       那不是「不存在」，不得据此拒绝装载（避免把加载顺序误判成非法清单）。 */
    if (this.checkModeTools) {
      for (const name of this.order) {
        if (failed.has(name)) {
          continue;
        }
        const manifest = nodes.get(name)!;
        if (!manifest.mode) {
          continue;
        }
        const missing = this.checkModeTools(manifest);
        if (missing.length > 0) {
          failed.set(name, `mode 声明的工具不存在于当前工具表：${missing.join("、")}（拒绝装载 —— 不留「配了但不生效」的假自由度）`);
        }
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
      } else if (kind === "mode") {
        /* A-1197 · B3（L4c）：mode 的「接线」在**会话侧**（下拉选中 → 阶段流分派），
           这里没有可注册的句柄（装载时已做工具存在性检查，见 `checkModeTools`）——
           所以如实登记**声明摘要**（阶段步数），不套用「尚未接线」（那是假陈述：
           用户确实能在会话顶选中它）。 */
        contributions.push(`mode:${describeMode(manifest.mode)}`);
      } else {
        contributions.push(`${kind}:${WIRING_PENDING}`);
      }
    }

    entry.scope = scope;
    entry.record.status = "loaded";
    entry.record.error = undefined;
    /* A-1197 · B1（L4b 设置贡献点）：设置项是**持久数据**而非运行期副作用，
       所以刻意**不进 scope**（禁用插件后数据保留、启用后仍在 —— 关插件不该丢用户配置）。
       代价是它不参与撤销：本层只登记「声明了几项」，真正的读写在settings-store（按需读盘），
       卸载后前端不再回传该插件的声明 ⇒ 界面自然摘除，不留幽灵设置项。 */
    const settingCount = manifest.contributes?.settings;
    if (settingCount !== undefined) {
      contributions.push(`settings:${describePluginSettings(settingCount)}`);
    }
    /* A-1197 · B2（L4a UI 贡献点）：槽位是**运行期接线**（主进程注册 → 按需回传渲染层），
       所以走 `contribute`（进 scope、卸载可撤销）；卸载后渲染层按 `plugins_changed`
       全量重算自然摘除（UI 侧不做增量 diff，见 UiSlotHost）。 */
    const uiDecl = manifest.contributes?.ui;
    if (uiDecl !== undefined) {
      const wiring = this.contribute(scope, this.registerUi, manifest);
      contributions.push(`ui:${wiring === WIRING_PENDING ? WIRING_PENDING : describePluginUi(uiDecl)}`);
    }
    /* A-1197 · B4（T1 脚本信任）：脚本贡献走 `contribute`（进 scope、卸载/关信任立即撤装）。
       「装不装」由主进程实现读 `trust.json` 判定（未信任 ⇒ 钩子返回空 ⇒ 如实记「尚未接线」，
       不假装已生效）；这里只负责「声明了脚本就调钩子」。 */
    const scriptDecl = manifest.contributes?.scripts;
    if (scriptDecl !== undefined) {
      const wiring = this.contribute(scope, this.registerScripts, manifest);
      contributions.push(`scripts:${wiring === WIRING_PENDING ? WIRING_PENDING : describePluginScripts(scriptDecl)}`);
    }
    /* A-1197 · B5（L4a page）：自有页面走 `contribute`（进 scope —— dispose 负责 stop 静态服务，
       防「page 的 http 服务泄漏」，见设计 §4.1 兜底表）。 */
    const pageDecl = manifest.contributes?.page;
    if (pageDecl !== undefined) {
      const wiring = this.contribute(scope, this.registerPage, manifest);
      contributions.push(`page:${wiring === WIRING_PENDING ? WIRING_PENDING : pageDecl.kind}`);
    }
    /* A-1198 · 主题贡献点（皮肤）：走 `contribute`（进 scope —— 卸载/停用即从主题表移除，
       渲染层回落默认皮肤；纯数据无副作用，撤销句柄只做「按插件名精确移除」）。 */
    const themeDecl = manifest.contributes?.theme;
    if (themeDecl !== undefined) {
      const wiring = this.contribute(scope, this.registerTheme, manifest);
      contributions.push(`theme:${wiring === WIRING_PENDING ? WIRING_PENDING : describePluginTheme(themeDecl)}`);
    }
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
