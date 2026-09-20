/**
 * core-ts/src/services/scheduler.ts — 后台常驻定时唤醒（nanobot CronService 对标，Phase 1 骨架）。
 *
 * 语义对齐业界（nanobot / Sentinel Agents Schedule）核心思想：**定时触发 = 造一条"任务输入"
 * 交给现有 AgentLoop 跑一轮**——不复造 Agent 循环，只负责"唤醒 + 注入 prompt + 结果出口"。
 *
 * 能力边界（本期骨架，诚实标注）：
 * - 5 字段 cron：`分 时 日 月 周`，支持 `*` 通配 / 数字 / 步长（`*` 斜杠 n，如 `*`/15 表每 15 分钟）/ `a,b` 列表；
 *   不支持 `?` / `L` / `W` / `#` / 名称缩写（JAN/MON）——遇到即抛错并拒绝注册。
 * - 触发语义：到点执行注入的 handler(job)（外部注入，见装配方），记录 lastRun/nextRun；
 *   同一 job 上轮未跑完则跳过本轮（防重入积压）。
 * - 持久化：job 定义由调用方负责（schedules 文件）；本服务仅管理内存态 + 状态字段。
 * - 时钟：分段 setTimeout（规避 >2^31-1ms 上限），重启后从 nextRun 恢复（不补跑错过的轮次——按业界
 *   惯例，错过即跳过，不做 backfill，避免无人值守时风暴补跑）。
 */
import { randomUUID } from "node:crypto";

/** 5 字段 cron 的合法区间（分/时/日/月/周） */
const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7],  // day of week（0/7 均为周日）
];

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

/** 单字段解析：`*` 通配 / 数字 / 步长（`*`/n）/ `a,b` 列表。范围越界或非法语法抛错（fail-closed，防坏 job 静默吞掉）。 */
export function parseCronPart(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  const ctx = `字段"${field}"（合法区间 ${min}-${max}）`;
  for (const raw of field.split(",")) {
    const part = raw.trim();
    if (part === "*") {
      for (let v = min; v <= max; v++) { out.add(v); }
      continue;
    }
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) {
      const n = Number(step[1]);
      if (n <= 0) { throw new Error(`cron ${ctx} 步长必须为正整数`); }
      for (let v = min; v <= max; v += n) { out.add(v); }
      continue;
    }
    const num = Number(part);
    if (!Number.isInteger(num) || num < min || num > max) {
      throw new Error(`cron ${ctx} 非法值 "${part}"（仅支持 * 、数字 、*/n 、a,b ）`);
    }
    out.add(num);
  }
  return out;
}

const normalizeDow = (n: number): number => (n === 7 ? 0 : n);

/** 解析 5 字段 cron 表达式（失败抛错，装配方捕获后拒绝该 job） */
export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式必须为 5 字段（分 时 日 月 周），收到 ${parts.length} 个：${expr}`);
  }
  const sch: CronSchedule = {
    minute: parseCronPart(parts[0], RANGES[0][0], RANGES[0][1]),
    hour: parseCronPart(parts[1], RANGES[1][0], RANGES[1][1]),
    dom: parseCronPart(parts[2], RANGES[2][0], RANGES[2][1]),
    month: parseCronPart(parts[3], RANGES[3][0], RANGES[3][1]),
    dow: parseCronPart(parts[4], RANGES[4][0], RANGES[4][1]),
  };
  return sch;
}

const matches = (sch: CronSchedule, d: Date): boolean =>
  sch.minute.has(d.getMinutes()) &&
  sch.hour.has(d.getHours()) &&
  sch.dom.has(d.getDate()) &&
  sch.month.has(d.getMonth() + 1) &&
  sch.dow.has(normalizeDow(d.getDay()));

/** 距 from 之后的**下一次**满足时刻（不含 from 本身；cron 粒度到分钟，秒/毫秒归零）。
 *  搜索上限定为 366 天（全覆盖年历偏移），未找到返回 null。 */
export function nextRunAfter(sch: CronSchedule, from: Date): Date | null {
  // 秒/毫秒清零后从下一分钟整开始扫描，保证返回整分钟时刻（cron 语义）
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const deadline = from.getTime() + 366 * 24 * 3600_000;
  while (t.getTime() <= deadline) {
    if (matches(sch, t)) { return t; }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

export interface CronJobDef {
  id?: string;
  /** 人类可读名（日志/结果落盘文件名用） */
  name: string;
  /** 5 字段 cron 表达式 */
  cron: string;
  /** 定时触发时交给 Agent 的任务文本（nanobot payload.message 语义） */
  prompt: string;
  /** 执行该任务的 Agent id；缺省 = 装配方默认 Agent */
  agentId?: string;
  /** 结果投递目标（如 "file:data/generated"）；本期骨架以 file 落盘为主，其余由装配方解释 */
  target?: string;
}

/** 运行期状态 */
export interface CronJobState {
  lastRun?: number;
  nextRun?: number;
  /** 正在执行（防重入；上轮未跑完的下一轮直接跳过） */
  running?: boolean;
  /** 暂停（生命周期 pause/resume；暂停期间不参与时钟调度，resume 后重算 nextRun） */
  paused?: boolean;
  /** 最近一次执行结果摘要（成功/失败 + 原因），供观察 */
  lastResult?: string;
}

export interface CronJob extends CronJobDef {
  id: string;
  schedule: CronSchedule;
  state: CronJobState;
}

/** 到点回调：外部注入"用任务输入跑一轮 AgentLoop"的实现（装配方见 GUI main）。 */
export type CronHandler = (job: CronJob) => Promise<void>;

/** setTimeout 单次时长的安全上限（毫秒）：2^31-1 之上会被 Node 溢出为立即执行，故分段）。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class SchedulerService {
  private jobs = new Map<string, CronJob>();
  private handler: CronHandler | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** 注册到点执行逻辑（只能设一次，防多个装配源互相覆盖） */
  setHandler(h: CronHandler): void {
    if (this.handler) { throw new Error("scheduler handler 已注册"); }
    this.handler = h;
  }

  /** 添加一个 job（cron 非法时抛错且不落表）。返回 job。 */
  add(def: CronJobDef): CronJob {
    const schedule = parseCron(def.cron);
    const job: CronJob = {
      id: def.id ?? randomUUID(),
      name: def.name,
      cron: def.cron,
      prompt: def.prompt,
      agentId: def.agentId,
      target: def.target,
      schedule,
      state: {},
    };
    job.state.nextRun = nextRunAfter(schedule, new Date())?.getTime();
    this.jobs.set(job.id, job);
    return job;
  }

  remove(id: string): boolean {
    return this.jobs.delete(id);
  }

  /** 内部 job 引用（状态观察/测试用；勿改 schedule 结构） */
  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  /** 快照（深拷贝 schedule/state，防外部改 table 或运行态） */
  list(): CronJob[] {
    return [...this.jobs.values()].map((j) => ({
      ...j,
      schedule: {
        minute: new Set(j.schedule.minute),
        hour: new Set(j.schedule.hour),
        dom: new Set(j.schedule.dom),
        month: new Set(j.schedule.month),
        dow: new Set(j.schedule.dow),
      },
      state: { ...j.state },
    }));
  }

  /** 启动调度时钟（幂等） */
  start(): void {
    if (this.stopped || this.timer) { return; }
    this.stopped = false;
    this.arm();
  }

  /** 停止调度时钟（不删 job；重启后从 nextRun 继续） */
  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = null;
  }

  private arm(): void {
    if (this.stopped) { return; }
    // 每小时至少复查一次（即便只有远期 job，也保证到点唤醒不会因分段/时钟漂移错过太久）
    const horizon = 3_600_000;
    let delay = horizon;
    for (const job of this.jobs.values()) {
      const next = job.state.nextRun;
      if (next === undefined) { continue; }
      const d = next - Date.now();
      if (d <= 0) {
        delay = 0;
        break;
      }
      if (d < delay) { delay = d; }
    }
    const fireMs = Math.min(delay, MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
      this.arm();
    }, fireMs);
  }

  private tick(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      const next = job.state.nextRun;
      if (next === undefined || next > now) { continue; }
      if (job.state.running) { continue; } // 上轮未跑完 → 跳过（不重入）
      if (job.state.paused) { continue; }  // 暂停中 → 不触发（保留 resume 后重算）
      // 到点触发；执行期间先推进 nextRun，避免本轮执行耗时导致同一分钟重复触发
      job.state.nextRun = nextRunAfter(job.schedule, new Date(now))?.getTime();
      void this.runJob(job);
    }
  }

  /**
   * 生命周期：暂停 job（暂停期间不触发；不丢定义）。幂等。
   * 已运行中的本轮照常收尾（不中断副作用）。
   */
  pause(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) { return false; }
    job.state.paused = true;
    job.state.nextRun = undefined;
    return true;
  }

  /** 生命周期：恢复 job，重新计算下次触发时刻。幂等。 */
  resume(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) { return false; }
    if (!job.state.paused) { return true; }
    job.state.paused = false;
    job.state.nextRun = nextRunAfter(job.schedule, new Date())?.getTime();
    // 重新 arm：可能刚 resume 的任务比当前最近 timer 更早
    this.stop();
    this.start();
    return true;
  }

  /**
   * 外部事件触发（Phase 2：webhook / 手动 / 文件监听统一入口）：立即执行一次，
   * 不重排 nextRun（与 cron 时钟独立）。paused 状态下的手动触发仍允许（显式意图）。 */
  trigger(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) { return false; }
    if (job.state.running) { return false; }
    void this.runJob(job, { manual: true });
    return true;
  }

  /** 全量状态持久化（Phase 3 断点续跑依据）：定义 + 运行态 → JSON 字符串（装配方落盘）。 */
  exportState(): string {
    const payload = [...this.jobs.values()].map((j) => ({
      id: j.id, name: j.name, cron: j.cron, prompt: j.prompt,
      agentId: j.agentId, target: j.target,
      state: { ...j.state, schedule: undefined },
    }));
    return JSON.stringify(payload, null, 2);
  }

  /** 从持久化快照恢复：覆盖当前表并保留 paused/lastRun/lastResult，重算 nextRun（错过不补跑）。 */
  importState(json: string): number {
    const raw = JSON.parse(json) as Array<CronJobDef & { state?: Partial<CronJobState> }>;
    let n = 0;
    for (const d of raw) {
      if (!d.cron || !d.prompt) { continue; }
      try {
        const job = this.add({ id: d.id, name: d.name ?? d.id ?? "task", cron: d.cron, prompt: d.prompt, agentId: d.agentId, target: d.target });
        if (d.state?.paused) { job.state.paused = true; job.state.nextRun = undefined; }
        else { job.state.nextRun = nextRunAfter(job.schedule, new Date())?.getTime(); }
        job.state.lastRun = d.state?.lastRun;
        job.state.lastResult = d.state?.lastResult;
        n++;
      } catch { /* 非法定义跳过 */ }
    }
    return n;
  }

  private async runJob(job: CronJob, opts: { manual?: boolean } = {}): Promise<void> {
    job.state.running = true;
    job.state.lastRun = Date.now();
    // 手动触发（trigger）不推进 nextRun（与 cron 时钟解耦）
    if (!opts.manual) {
      job.state.nextRun = nextRunAfter(job.schedule, new Date(job.state.lastRun))?.getTime();
    }
    try {
      if (this.handler) {
        await this.handler(job);
        job.state.lastResult = "ok";
      } else {
        job.state.lastResult = "skipped（未注册 handler）";
      }
    } catch (e) {
      job.state.lastResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      job.state.running = false;
    }
  }
}