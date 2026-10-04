














import { randomUUID } from "node:crypto";


const RANGES: Array<[number, number]> = [
  [0, 59], 
  [0, 23], 
  [1, 31], 
  [1, 12], 
  [0, 7],  
];

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}


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



export function nextRunAfter(sch: CronSchedule, from: Date): Date | null {
  
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
  
  name: string;
  
  cron: string;
  
  prompt: string;
  
  agentId?: string;
  
  target?: string;
}


export interface CronJobState {
  lastRun?: number;
  nextRun?: number;
  
  running?: boolean;
  
  paused?: boolean;
  
  lastResult?: string;
}

export interface CronJob extends CronJobDef {
  id: string;
  schedule: CronSchedule;
  state: CronJobState;
}


export type CronHandler = (job: CronJob) => Promise<void>;


const MAX_TIMER_MS = 2 ** 31 - 1;

export class SchedulerService {
  private jobs = new Map<string, CronJob>();
  private handler: CronHandler | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  
  setHandler(h: CronHandler): void {
    if (this.handler) { throw new Error("scheduler handler 已注册"); }
    this.handler = h;
  }

  
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

  
  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  
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

  
  start(): void {
    if (this.stopped || this.timer) { return; }
    this.stopped = false;
    this.arm();
  }

  
  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = null;
  }

  private arm(): void {
    if (this.stopped) { return; }
    
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
      if (job.state.running) { continue; } 
      if (job.state.paused) { continue; }  
      
      job.state.nextRun = nextRunAfter(job.schedule, new Date(now))?.getTime();
      void this.runJob(job);
    }
  }

  



  pause(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) { return false; }
    job.state.paused = true;
    job.state.nextRun = undefined;
    return true;
  }

  
  resume(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) { return false; }
    if (!job.state.paused) { return true; }
    job.state.paused = false;
    job.state.nextRun = nextRunAfter(job.schedule, new Date())?.getTime();
    
    this.stop();
    this.start();
    return true;
  }

  


  trigger(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) { return false; }
    if (job.state.running) { return false; }
    void this.runJob(job, { manual: true });
    return true;
  }

  
  exportState(): string {
    const payload = [...this.jobs.values()].map((j) => ({
      id: j.id, name: j.name, cron: j.cron, prompt: j.prompt,
      agentId: j.agentId, target: j.target,
      state: { ...j.state, schedule: undefined },
    }));
    return JSON.stringify(payload, null, 2);
  }

  
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
      } catch {  }
    }
    return n;
  }

  private async runJob(job: CronJob, opts: { manual?: boolean } = {}): Promise<void> {
    job.state.running = true;
    job.state.lastRun = Date.now();
    
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