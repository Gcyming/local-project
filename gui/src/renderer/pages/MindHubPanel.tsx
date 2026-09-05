/**
 * gui/src/renderer/pages/MindHubPanel.tsx — 心智中枢（记忆/学习/进化/情绪整合栏目）。
 * - 依赖状态：llama.cpp / BGE-M3 / 本地模型（不在 git 仓库，换设备需手动就位）
 * - 向量工具：bge = 真实 BGE-M3 嵌入（高优）；basic = LanceDB + 哈希占位向量（基础）
 * - 情绪调节：PAD 三轴滑块 + 8 种情绪编码表一键套用（仅调基线，不影响自动演化）
 * - 记忆：存储位置展示 + 可改根目录（重启生效）
 * - 学习：book-to-skill（拖入文档 → 生成技能 SKILL.md → 化为己用）
 * - 进化：规划占位
 */
import React, { type JSX } from "react";
import type { MindConfigInfo, VectorTool, EmotionSnapshot, EvolutionSnapshot, DownloadProgressInfo } from "../../shared/ipc.js";
import { CheckIcon, CloseIcon, PlusIcon } from "../components/Icon.js";
import { confirmAsync, alertAsync } from "../dialog.js";

const MOOD_CN: Record<string, string> = {
  neutral: "平静", happy: "快乐", content: "满足", interested: "好奇",
  concerned: "谨慎", frustrated: "受挫", angry: "愤怒", disgusted: "厌恶",
};

/** 8 种情绪编码表（与 core-ts/mind/emotion.ts MOODS 对齐） */
const MOOD_DEFS: Array<{ key: string; cn: string; valence: number; arousal: number; dominance: number }> = [
  { key: "happy", cn: "快乐", valence: 0.7, arousal: 0.65, dominance: 0.7 },
  { key: "content", cn: "满足", valence: 0.4, arousal: 0.2, dominance: 0.7 },
  { key: "interested", cn: "好奇", valence: 0.5, arousal: 0.75, dominance: 0.65 },
  { key: "neutral", cn: "平静", valence: 0.0, arousal: 0.3, dominance: 0.5 },
  { key: "concerned", cn: "谨慎", valence: -0.3, arousal: 0.55, dominance: 0.35 },
  { key: "frustrated", cn: "受挫", valence: -0.5, arousal: 0.7, dominance: 0.45 },
  { key: "angry", cn: "愤怒", valence: -0.6, arousal: 0.8, dominance: 0.6 },
  { key: "disgusted", cn: "厌恶", valence: -0.7, arousal: 0.15, dominance: 0.55 },
];

const pct = (v: number, lo: number, hi: number): number => Math.round(((v - lo) / (hi - lo)) * 100);

/** 自定义情绪存储键（localStorage，前端偏好） */
const CUSTOM_MOODS_KEY = "slime.custom_moods";

interface CustomMood {
  key: string;
  cn: string;
  valence: number;
  arousal: number;
  dominance: number;
}

function loadCustomMoods(): CustomMood[] {
  try {
    const raw = localStorage.getItem(CUSTOM_MOODS_KEY);
    if (!raw) { return []; }
    const parsed = JSON.parse(raw) as CustomMood[];
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.cn === "string") : [];
  } catch {
    return [];
  }
}

function saveCustomMoods(list: CustomMood[]): void {
  try {
    localStorage.setItem(CUSTOM_MOODS_KEY, JSON.stringify(list));
  } catch {
    // localStorage 不可用时静默失败（自定义情绪仅本机偏好）
  }
}

/** PAD → 最近情绪点（与 core-ts/mind/emotion.ts nearestMood 同逻辑） */
function nearestMood(v: number, a: number, d: number): string {
  let best = "neutral";
  let bestDist = Infinity;
  for (const m of MOOD_DEFS) {
    const dist = Math.sqrt((v - m.valence) ** 2 + (a - m.arousal) ** 2 + (d - m.dominance) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      best = m.key;
    }
  }
  return best;
}

function Slider({
  label, value, onChange, min, max, fmt,
}: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; fmt: (v: number) => string;
}): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <span style={{ width: 76, fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
      <input
        type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: "var(--accent)" }}
      />
      <span style={{ width: 42, textAlign: "right", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
        {fmt(value)}
      </span>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="card" style={{ padding: "14px 16px", marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--text-muted)" }}>{title}</div>
      {children}
    </div>
  );
}

/**
 * 路径展示：短路径完整显示（允许在 `\` 处折行），长路径省略中间部分、末尾高亮文件名，
 * 悬停 tooltip 显示完整路径。绝不在文件名中间拦腰截断。
 * 关键：容器必须设 `minWidth: 0`（flex 子项默认 minWidth=auto 会强制溢出断行）。
 */
function DispPath({ path }: { path: string }): JSX.Element {
  if (!path) {
    return <span style={{ color: "var(--text-dim)" }}>（未配置）</span>;
  }
  const segs = path.split(/[\\/]/).filter(Boolean);
  const fileName = segs[segs.length - 1] ?? path;
  // 短路径（<=60 字符）：完整显示，用零宽空格让浏览器优先在 `\` 处折行
  if (path.length <= 60) {
    const withBreaks = path.replace(/[\\/]/g, (m) => `${m}\u200B`);
    return (
      <span
        title={path}
        style={{ wordBreak: "break-word", overflowWrap: "break-word" }}
      >
        {withBreaks}
      </span>
    );
  }
  // 长路径：显示 "C:\Users\MR\…\fileName"，文件名完整不截断
  const head = segs.slice(0, 3).join("\\");
  return (
    <span
      title={path}
      style={{ display: "inline-flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}
    >
      <span style={{ color: "var(--text-muted)" }}>{head}\u200B…\u200B</span>
      <span style={{ fontWeight: 600, color: "var(--text)", wordBreak: "break-word" }}>{fileName}</span>
    </span>
  );
}

/** 依赖下载控件：进度条 + 暂停/继续/取消 */
function DownloadControls({
  target, dl,
}: {
  target: "llama" | "bge"; dl: Record<string, DownloadProgressInfo>;
}): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const t = dl[target];
  const ctl = (action: "pause" | "cancel" | "resume"): void => {
    void api?.mind?.downloadControl(target, action).catch(console.error);
  };
  const start = (): void => {
    void api?.mind?.download(target).catch(console.error);
  };
  const bar = (p: number): JSX.Element => (
    <div style={{
      width: 150, height: 6, borderRadius: 3, background: "var(--border)",
      overflow: "hidden", display: "inline-block", verticalAlign: "middle",
    }}>
      <div style={{
        width: `${Math.max(2, Math.min(100, p))}%`, height: "100%",
        background: "var(--accent)", transition: "width 0.25s",
      }} />
    </div>
  );
  if (!t || t.state === "idle") {
    return <button className="btn" style={{ fontSize: 11, padding: "2px 10px" }} onClick={start}>下载</button>;
  }
  if (t.state === "error") {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <button className="btn" style={{ fontSize: 11, padding: "2px 10px" }} onClick={start}>重试</button>
        <span style={{ fontSize: 10.5, color: "var(--warning)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.error}>
          {t.error ?? "下载失败"}
        </span>
      </span>
    );
  }
  if (t.state === "done") {
    return (
      <span style={{ fontSize: 11, color: "var(--ok, #4ade80)", display: "inline-flex", alignItems: "center", gap: 6 }}>
        <CheckIcon size={13} /> 已下载
        <span style={{ fontSize: 10, color: "var(--text-dim)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.path}>
          {t.path}
        </span>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      {bar(t.percent)}
      <span style={{ fontSize: 10.5, color: "var(--text-muted)", minWidth: 46 }}>{t.percent}%</span>
      {t.state === "downloading"
        ? <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => ctl("pause")}>暂停</button>
        : <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => ctl("resume")}>继续</button>}
      <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => ctl("cancel")}>取消</button>
    </span>
  );
}

export default function MindHubPanel({
  selectedAgentId, dl,
}: { selectedAgentId?: string; dl?: Record<string, DownloadProgressInfo> }): JSX.Element {
  const [cfg, setCfg] = React.useState<MindConfigInfo | null>(null);
  const [agents, setAgents] = React.useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = React.useState<string>(selectedAgentId ?? "");
  const [emotion, setEmotion] = React.useState<EmotionSnapshot | null>(null);
  /** 本地预览（套用情绪表/拖滑块时即时反馈，保存才写服务器） */
  const [preview, setPreview] = React.useState<EmotionSnapshot | null>(null);
  const [valence, setValence] = React.useState(0);
  const [arousal, setArousal] = React.useState(30);
  const [dominance, setDominance] = React.useState(50);
  const [saved, setSaved] = React.useState("");
  const [skillName, setSkillName] = React.useState("");
  const [skillFile, setSkillFile] = React.useState<{ name: string; content: string } | null>(null);
  const [skillResult, setSkillResult] = React.useState("");
  const [dragOver, setDragOver] = React.useState(false);
  /** 依赖定位反馈消息（按 key） */
  const [locateMsg, setLocateMsg] = React.useState<Record<string, string>>({});
  /** 自定义情绪（localStorage 持久化） */
  const [customMoods, setCustomMoods] = React.useState<CustomMood[]>(loadCustomMoods);
  const [customAdding, setCustomAdding] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  /** 进化快照（生命周期 + 人格特质 + 行为/交互积累） */
  const [evolution, setEvolution] = React.useState<EvolutionSnapshot | null>(null);

  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;

  /** 依赖定位：auto=项目文件夹内自动检索；pick=手动选择。命中写入 slime.toml 并刷新状态 */
  async function locateDep(key: "llama_bin" | "model_path" | "models_dir", mode: "auto" | "pick"): Promise<void> {
    if (!api?.mind?.locateDep) return;
    const res = await api.mind.locateDep(mode, key).catch((e: unknown) => ({ found: false, error: String(e) }));
    setLocateMsg((prev) => {
      const next = { ...prev };
      if (!res.found) {
        next[key] = mode === "auto"
          ? "⚠ 项目文件夹内未找到，可点击「手动选择」定位外部路径"
          : "✕ 未选择";
      } else {
        next[key] = res.written === false ? "⚠ 已找到，但 slime.toml 无此键（可手动编辑）" : "✅ 已定位并写入 slime.toml";
      }
      return next;
    });
    if (res.deps) setCfg((c) => (c ? { ...c, deps: res.deps } : c));
    window.setTimeout(() => {
      setLocateMsg((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, 5000);
  }

  React.useEffect(() => {
    if (api?.mind?.configGet) {
      void api.mind.configGet().then((c: MindConfigInfo) => setCfg(c)).catch(console.error);
    }
    if (api?.agents?.list) {
      void api.agents.list().then((list: Array<{ id: string; name: string }>) => {
        setAgents(list);
        if (list.length > 0 && !selectedAgentId) {
          setAgentId(list[0].id);
        }
      }).catch(console.error);
    }
    // 下载状态：App 层全局订阅（本组件卸载时进度不丢失，见 App.tsx）；未注入时本地拉快照兜底
    if (api?.mind && !dl) {
      void api.mind.downloadSnapshot("llama").then((p: DownloadProgressInfo) => setDl0((prev) => ({ ...prev, llama: p }))).catch(() => {});
      void api.mind.downloadSnapshot("bge").then((p: DownloadProgressInfo) => setDl0((prev) => ({ ...prev, bge: p }))).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId]);

  // 无全局 dl（未从 App 注入）时兜底：本地快照
  const [dl0, setDl0] = React.useState<Record<string, DownloadProgressInfo>>({});
  const dlMap = dl ?? dl0;

  // 下载中轮询兜底：即使推送事件偶发丢失，进度条也能实时刷新（1s 拉一次快照）
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.mind?.downloadSnapshot) return;
    const active = (Object.values(dlMap) as DownloadProgressInfo[]).some((p) => p.state === "downloading" || p.state === "paused");
    if (!active) return;
    const timer = window.setInterval(() => {
      void api.mind.downloadSnapshot("llama").then((p: DownloadProgressInfo) => {
        setDl0((prev) => ({ ...prev, llama: p }));
      }).catch(() => {});
      void api.mind.downloadSnapshot("bge").then((p: DownloadProgressInfo) => {
        setDl0((prev) => ({ ...prev, bge: p }));
      }).catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlMap.llama?.state, dlMap.bge?.state]);

  // 下载完成 → 刷新依赖状态：左侧 ✅/❌ 图标跟随真实文件状态（此前 cfg 只在挂载时加载一次，
  // 下载完成后图标仍停留 ❌ 而右侧已显示"已下载"）。立即刷一次 + 延迟 2s 再刷一次：
  // bge 归位是同步的，llama 解压 + 改写 llama_bin 是异步的（finishLlama）。
  const prevDoneRef = React.useRef<Record<string, boolean>>({});
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.mind?.configGet) return;
    let timer: number | undefined;
    for (const target of ["llama", "bge"] as const) {
      const isDone = dlMap[target]?.state === "done";
      if (isDone && !prevDoneRef.current[target]) {
        void api.mind.configGet().then((c: MindConfigInfo) => setCfg(c)).catch(console.error);
        timer = window.setTimeout(() => {
          void api.mind.configGet().then((c: MindConfigInfo) => setCfg(c)).catch(console.error);
        }, 2000);
      }
      prevDoneRef.current[target] = isDone;
    }
    return () => { if (timer) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlMap.llama?.state, dlMap.bge?.state]);

  React.useEffect(() => {
    if (!agentId || !api?.mind?.emotionGet) return;
    void api.mind.emotionGet(agentId).then((e: EmotionSnapshot) => {
      setEmotion(e);
      setPreview(null);
      setValence(pct(e.valence, -1, 1));
      setArousal(pct(e.arousal, 0, 1));
      setDominance(pct(e.dominance, 0, 1));
    }).catch(console.error);
  }, [agentId]);

  /** 进化快照：随选中 Agent 加载（生命周期 + 特质权重 + 行为/交互积累） */
  React.useEffect(() => {
    if (!agentId || !api?.mind?.evolutionGet) return;
    void api.mind.evolutionGet(agentId).then((e: EvolutionSnapshot) => {
      setEvolution(e);
    }).catch(console.error);
  }, [agentId]);

  /** 一键套用情绪编码表：立即进入预览态（高亮跟随），可微调后再保存 */
  function applyMood(m: { key: string; valence: number; arousal: number; dominance: number }): void {
    setValence(pct(m.valence, -1, 1));
    setArousal(pct(m.arousal, 0, 1));
    setDominance(pct(m.dominance, 0, 1));
    setPreview({
      valence: m.valence, arousal: m.arousal, dominance: m.dominance,
      mood: m.key, relational_depth: emotion?.relational_depth ?? 0,
      last_updated: null, events: emotion?.events ?? [],
    });
  }

  /** 添加自定义情绪：以当前滑块 PAD 值为基线，保存到 localStorage */
  function addCustomMood(): void {
    const name = customName.trim();
    if (!name) { return; }
    const key = `custom_${name}`;
    const next = [
      ...customMoods.filter((m) => m.key !== key),
      {
        key,
        cn: name,
        valence: valence / 100 * 2 - 1,
        arousal: arousal / 100,
        dominance: dominance / 100,
      },
    ];
    setCustomMoods(next);
    saveCustomMoods(next);
    setCustomName("");
    setCustomAdding(false);
    setSaved(`自定义情绪「${name}」已添加（可点击套用）`);
    window.setTimeout(() => setSaved(""), 4000);
  }

  /** 删除自定义情绪 */
  function removeCustomMood(key: string): void {
    const next = customMoods.filter((m) => m.key !== key);
    setCustomMoods(next);
    saveCustomMoods(next);
  }

  /** 滑块微调：同步预览 mood（最近邻）；首拖（无 preview）时从当前 emotion 构造基线 */
  function onSliderChange(kind: "v" | "a" | "d", v: number): void {
    if (kind === "v") setValence(v);
    if (kind === "a") setArousal(v);
    if (kind === "d") setDominance(v);
    setPreview((prev) => {
      const base = prev ?? {
        valence: emotion?.valence ?? 0,
        arousal: emotion?.arousal ?? 0.3,
        dominance: emotion?.dominance ?? 0.5,
        mood: emotion?.mood ?? "neutral",
        relational_depth: emotion?.relational_depth ?? 0,
        last_updated: null,
        events: emotion?.events ?? [],
      };
      const nv = kind === "v" ? v / 100 * 2 - 1 : base.valence;
      const na = kind === "a" ? v / 100 : base.arousal;
      const nd = kind === "d" ? v / 100 : base.dominance;
      return { ...base, valence: nv, arousal: na, dominance: nd, mood: nearestMood(nv, na, nd) };
    });
  }

  async function saveEmotion(): Promise<void> {
    if (!agentId || !api?.mind?.emotionSet) return;
    const res = await api.mind.emotionSet({
      agentId,
      valence: valence / 100 * 2 - 1,
      arousal: arousal / 100,
      dominance: dominance / 100,
    }).catch((e: unknown) => {
      console.error(e);
      return { ok: false, error: String(e) };
    });
    if (res.ok) {
      setEmotion(res.emotion ?? emotion);
      setPreview(null);
      setSaved("情绪基线已保存（后续对话自动演化会在此之上继续累积，不受影响）");
      window.setTimeout(() => setSaved(""), 4000);
    } else {
      setSaved(`保存失败：${res.error ?? "未知错误"}`);
    }
  }

  async function pickMemoryRoot(): Promise<void> {
    if (!api?.conversations?.pickFolder || !api?.mind?.configSet) return;
    const picked = await api.conversations.pickFolder();
    if (picked.ok && picked.path) {
      const res = await api.mind.configSet({ memoryRoot: picked.path });
      setCfg((prev) => (prev ? { ...prev, memoryRoot: res.memoryRoot } : prev));
      setSaved("记忆存储位置已更新（重启应用后新建记忆写入新位置；现有记忆保留原位）");
      window.setTimeout(() => setSaved(""), 6000);
    }
  }

  async function setVectorTool(tool: VectorTool): Promise<void> {
    if (!api?.mind?.configSet) return;
    const res = await api.mind.configSet({ vectorTool: tool });
    setCfg((prev) => (prev ? { ...prev, vectorTool: res.vectorTool } : prev));
  }

  /** 重置本地数据（清空 Provider/Agent/会话与历史；记忆保留）。确认后执行并整页刷新 */
  async function handleResetData(): Promise<void> {
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!a?.data?.reset) { return; }
    if (!(await confirmAsync(
      "确定要重置本地数据？",
      "将清除（仅应用数据目录 config/ 下的 4 个文件）：\n" +
      "· providers.enc.json —— 所有 API Provider 及本地保存的密钥\n" +
      "· agents.json —— 所有 Agent 及其配置\n" +
      "· history.jsonl —— 全部对话历史\n" +
      "· sessions.json —— 会话列表\n\n" +
      "【保留】记忆文件（Knowledge/）、模型下载文件、slime.toml 配置、仓库与 Obsidian 笔记均不受影响。\n\n" +
      "此操作不可撤销",
    ))) { return; }
    const res = await a.data.reset().catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    if (res.ok) {
      window.setTimeout(() => window.location.reload(), 400);
    } else {
      void alertAsync(`重置失败：${res.error ?? "未知错误"}`);
    }
  }

  async function convertToSkill(): Promise<void> {
    if (!skillName.trim() || !skillFile) return;
    const res = await api.mind.bookToSkill(skillName.trim(), skillFile.content)
      .catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (res.ok) {
      setSkillResult(`✅ 技能「${skillName.trim()}」已生成：${res.path}`);
      setSkillName("");
      setSkillFile(null);
    } else {
      setSkillResult(`❌ 转换失败：${res.error ?? "未知错误"}`);
    }
  }

  /** 拖放/选择文件 → 读取文本 */
  function readFile(file: File): void {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setSkillResult("❌ 文件过大（>2MB），请裁剪后重试");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setSkillFile({ name: file.name, content: String(reader.result ?? "") });
      if (!skillName) {
        setSkillName(file.name.replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fa5-]/g, "-").slice(0, 60));
      }
    };
    reader.onerror = () => setSkillResult("❌ 文件读取失败");
    reader.readAsText(file);
  }

  const shown = preview ?? emotion;
  const moodCn = shown ? (MOOD_CN[shown.mood] ?? shown.mood) : "—";

  return (
    <div style={{ padding: 12, overflowY: "auto", height: "100%" }}>
      {/* 依赖状态 */}
      <SectionCard title="依赖状态（换设备部署检查 + 一键下载）">
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
          代码与依赖清单在 GitHub 仓库内（pnpm-lock.yaml / requirements.txt 锁版本），
          但 <b>模型文件与 llama.cpp 二进制不在仓库</b>。每条依赖可「自动检索」（扫描项目文件夹）
          或「手动选择」（定位外部路径，写入 slime.toml）；缺失项也可直接点「下载」——
          走<b>国内镜像</b>（嵌入模型经 hf-mirror.com；llama.cpp 经 gh-proxy 系列加速），
          应用内下载、支持断点续传，可随时暂停/取消：
        </div>
        {cfg && [
          { label: "llama.cpp（推理服务）", path: cfg.deps.llamaBin, ok: cfg.deps.ok.llamaBin, target: "llama" as const, key: "llama_bin" as const },
          { label: "嵌入模型（bge-m3-q8_0.gguf）", path: cfg.deps.bgeModel, ok: cfg.deps.ok.bgeModel, target: "bge" as const, key: "model_path" as const },
          { label: "本地聊天模型目录", path: cfg.deps.localModelsDir, ok: cfg.deps.ok.localModelsDir, target: null as null, key: "models_dir" as const },
        ].map((d) => (
          <div key={d.label} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
            <span style={{ color: d.ok ? "var(--ok, #4ade80)" : "var(--warning)" }}>{d.ok ? <CheckIcon size={13} /> : <CloseIcon size={13} style={{ color: "var(--warning)" }} />}</span>
            <span style={{ width: 150, color: "var(--text-muted)", flexShrink: 0 }}>{d.label}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11 }}><DispPath path={d.path} /></span>
            {!d.ok && d.target && <DownloadControls target={d.target} dl={dlMap} />}
            {d.ok && d.target === "llama" && dlMap.llama?.extractedDir && (
              <span style={{ fontSize: 10, color: "var(--text-dim)" }} title={dlMap.llama.extractedDir}>已解压</span>
            )}
            <button className="btn" title="扫描项目文件夹自动定位该依赖" style={{ fontSize: 10.5, padding: "1px 8px" }} onClick={() => void locateDep(d.key, "auto")}>自动检索</button>
            <button className="btn" title="手动选择文件/目录并写入 slime.toml" style={{ fontSize: 10.5, padding: "1px 8px" }} onClick={() => void locateDep(d.key, "pick")}>手动选择</button>
            {locateMsg[d.key] && (
              <span style={{ fontSize: 10.5, color: locateMsg[d.key].startsWith("✅") ? "var(--ok, #4ade80)" : "var(--warning)", flex: "1 1 100%" }}>{locateMsg[d.key]}</span>
            )}
          </div>
        ))}
        <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.6 }}>
          版本说明：llama.cpp 下载官方「Windows x64 (CPU)」通用包（AVX2，约 17MB）——不依赖显卡驱动版本，
          兼容全部 GGUF 模型（含嵌入模型）；如需要 GPU 加速可自行另下 CUDA 版并在 slime.toml 更换 llama_bin。
          嵌入模型来自 llama.cpp 官方转换仓库（ggml-org/bge-m3-Q8_0-GGUF），635MB，下载后放置到 slime.toml 配置路径即可。
        </div>
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <button className="btn" style={{ fontSize: 12, color: "var(--warning)" }}
            onClick={() => void handleResetData()}>
            重置本地数据（清空 Provider / Agent / 会话与历史）
          </button>
          <span style={{ fontSize: 10.5, color: "var(--text-dim)", marginLeft: 8 }}>提示：安装包内不附带任何用户数据；此处用于清理应用数据目录（%APPDATA%\\slime-gui\\slime-data）中的旧数据。</span>
        </div>
      </SectionCard>

      {/* 向量工具 */}
      <SectionCard title="向量工具（记忆检索的嵌入方式）">
        <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
          {([
            { id: "bge" as VectorTool, name: "高优模式", desc: "真实语义嵌入（本地嵌入模型服务 :8999），相似记忆召回准确；需要嵌入模型与 llama.cpp 就位，失败自动降级基础模式" },
            { id: "basic" as VectorTool, name: "基础模式", desc: "字符级哈希占位向量 + LanceDB 四阶段检索（种子→链接遍历→标签过滤→艾宾浩斯权重排序），无需模型文件，离线可用" },
          ]).map((t) => (
            <button key={t.id}
              onClick={() => void setVectorTool(t.id)}
              style={{
                flex: 1, textAlign: "left", cursor: "pointer", borderRadius: 10,
                border: `1.5px solid ${cfg?.vectorTool === t.id ? "var(--accent)" : "var(--border)"}`,
                background: cfg?.vectorTool === t.id ? "var(--accent-soft)" : "var(--bg-input)",
                padding: "10px 12px",
              }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                {cfg?.vectorTool === t.id ? "● " : "○ "}{t.name}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{t.desc}</div>
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          高优模式需自行配置嵌入模型：在 slime.toml 的 [model_server.embedding] 段填入模型文件路径（如开源 bge-m3 的 q8_0 GGUF，可从上方向下依赖按钮获取）即可启用。
          记忆写入管线（LLM 提取记忆/演化沉淀）当前未接入 GUI 服务端，此开关控制检索侧嵌入质量；两份模式共享同一 LanceDB 存储。
        </div>
      </SectionCard>

      {/* 情绪调节 */}
      <SectionCard title="情绪调节（手动拉情绪基线，不影响自动演化）">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>目标 Agent：</span>
          <select
            className="input-field" style={{ maxWidth: 240, fontSize: 12.5 }}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            当前情绪：<b style={{ color: "var(--accent-hover)" }}>{moodCn}</b>
            {shown ? `（V=${shown.valence.toFixed(2)} A=${shown.arousal.toFixed(2)} D=${shown.dominance.toFixed(2)}）` : ""}
            {preview ? " · 未保存" : ""}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>
          情绪由愉悦度（Valence）/ 唤醒度（Arousal）/ 支配度（Dominance）三维唯一决定；
          8 种情绪是 PAD 空间中的预置编码点，当前情绪 = 距 PAD 坐标最近的点。拖动滑块或套用编码表即调整基线（仅调初始值，自动演化不受影响）。
        </div>
        <div style={{ padding: "2px 0 6px" }}>
          <Slider label="愉悦度 Valence" min={0} max={100} value={valence} onChange={(v) => onSliderChange("v", v)} fmt={(v) => `${(v / 100 * 2 - 1).toFixed(2)}`} />
          <Slider label="唤醒度 Arousal" min={0} max={100} value={arousal} onChange={(v) => onSliderChange("a", v)} fmt={(v) => `${(v / 100).toFixed(2)}`} />
          <Slider label="支配度 Dominance" min={0} max={100} value={dominance} onChange={(v) => onSliderChange("d", v)} fmt={(v) => `${(v / 100).toFixed(2)}`} />
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
          情绪编码表（点击套用其 PAD 基线，可继续微调后保存；仅调初始值，对话自动演化不受影响）：
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10 }}>
          {MOOD_DEFS.map((m) => (
            <button key={m.key}
              onClick={() => applyMood(m)}
              title={`valence=${m.valence} arousal=${m.arousal} dominance=${m.dominance}`}
              style={{
                cursor: "pointer", borderRadius: 8, padding: "6px 8px", textAlign: "left",
                border: (shown?.mood === m.key) ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                background: (shown?.mood === m.key) ? "var(--accent-soft)" : "var(--bg-input)",
                fontSize: 11.5,
              }}>
              <span style={{ fontWeight: 700, color: "var(--text)" }}>{m.cn}</span>
              <span style={{ color: "var(--text-dim)", fontSize: 10.5, display: "block" }}>
                V{m.valence.toFixed(1)} A{m.arousal.toFixed(2)} D{m.dominance.toFixed(1)}
              </span>
            </button>
          ))}
        </div>
        {/* 自定义情绪：以当前滑块 PAD 值为基线保存 */}
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
          自定义情绪（先拖动上方滑块到目标 PAD 值，再命名添加；可一键套用 / 删除）：
        </div>
        {customMoods.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
            {customMoods.map((m) => (
              <div key={m.key}
                title={`valence=${m.valence} arousal=${m.arousal} dominance=${m.dominance}`}
                style={{
                  position: "relative", borderRadius: 8, padding: "6px 8px",
                  border: (shown?.mood === m.key) ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                  background: (shown?.mood === m.key) ? "var(--accent-soft)" : "var(--bg-input)",
                  fontSize: 11.5, cursor: "pointer",
                }}
                onClick={() => applyMood(m)}>
                <span style={{ fontWeight: 700, color: "var(--accent-hover)" }}>{m.cn}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 10.5, display: "block" }}>
                  V{m.valence.toFixed(1)} A{m.arousal.toFixed(2)} D{m.dominance.toFixed(1)}
                </span>
                <button
                  title="删除该自定义情绪"
                  onClick={(e) => { e.stopPropagation(); removeCustomMood(m.key); }}
                  style={{
                    position: "absolute", top: 2, right: 4, border: "none", background: "transparent",
                    color: "var(--text-dim)", fontSize: 11, cursor: "pointer", padding: "0 2px",
                  }}>
                   <CloseIcon size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {customAdding ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              className="input-field" style={{ flex: 1, fontSize: 12.5 }}
              placeholder="自定义情绪名称（如：雀跃）"
              value={customName}
              autoFocus
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { addCustomMood(); }
                if (e.key === "Escape") { setCustomAdding(false); setCustomName(""); }
              }}
            />
            <button className="btn primary" style={{ fontSize: 12.5 }} disabled={!customName.trim()} onClick={addCustomMood}>保存</button>
            <button className="btn" style={{ fontSize: 12.5 }} onClick={() => { setCustomAdding(false); setCustomName(""); }}>取消</button>
          </div>
        ) : (
          <button className="btn" style={{ fontSize: 12.5, marginBottom: 8 }}
            onClick={() => setCustomAdding(true)}>
            <PlusIcon size={12} /> 添加自定义情绪
          </button>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn primary" style={{ fontSize: 12.5 }} onClick={() => void saveEmotion()}>保存情绪基线</button>
          <span style={{ fontSize: 11.5, color: "var(--ok, #4ade80)" }}>{saved}</span>
        </div>
      </SectionCard>

      {/* 记忆 */}
      <SectionCard title="记忆（存储位置）">
        <div style={{ fontSize: 12, lineHeight: 1.8 }}>
          <div><span style={{ color: "var(--text-muted)" }}>记忆本体（memory.json）：</span>
            <span style={{ fontSize: 11, wordBreak: "break-all" }}>{cfg?.memoryRoot || (cfg?.memoryPaths.knowledge ?? "读取中…")}</span>
          </div>
          <div><span style={{ color: "var(--text-muted)" }}>向量库（LanceDB）：</span>
            <span style={{ fontSize: 11, wordBreak: "break-all" }}>{cfg?.memoryPaths.lance ?? "读取中…"}</span>
          </div>
        </div>
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn" style={{ fontSize: 12.5 }} onClick={() => void pickMemoryRoot()}>
            更改存储位置…
          </button>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {cfg?.memoryRoot ? `当前自定义根目录：${cfg.memoryRoot}（重启后生效）` : "当前为默认位置（重启后生效变更）"}
          </span>
        </div>
      </SectionCard>

      {/* 学习：book-to-skill */}
      <SectionCard title="学习 · book-to-skill（文档 → 技能，化为己用）">
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
          拖入或选择一份文档（.md / .txt 等文本，≤2MB），生成专属技能（config/skills/&lt;名称&gt;/SKILL.md）。
          生成后 Agent 即能在对话中通过技能搜索调用——不影响既有自动学习（记忆提取/行为沉淀）管线，仅作拓展。
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) { readFile(f); }
          }}
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".md,.txt,.markdown,.text,.json,.yaml,.yml";
            input.onchange = () => {
              const f = input.files?.[0];
              if (f) { readFile(f); }
            };
            input.click();
          }}
          style={{
            border: `1.5px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 10, padding: "16px 12px", textAlign: "center", cursor: "pointer",
            background: dragOver ? "var(--accent-soft)" : "var(--bg-input)",
            fontSize: 12.5, color: "var(--text-muted)", marginBottom: 10,
          }}
        >
          {skillFile
            ? <><CheckIcon size={13} /> 已载入：{skillFile.name}（{(skillFile.content.length / 1024).toFixed(1)} KB）— 再次点击可更换</>
            : <><PlusIcon size={13} /> 点击选择文件，或将文档拖放到此处</>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="input-field" style={{ flex: 1, fontSize: 12.5 }}
            placeholder="技能名称（如：产品需求分析）"
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
          />
          <button className="btn primary" style={{ fontSize: 12.5 }}
            disabled={!skillName.trim() || !skillFile}
            onClick={() => void convertToSkill()}>
            转换为技能
          </button>
        </div>
        {skillResult && (
          <div style={{ fontSize: 11.5, color: "var(--ok, #4ade80)", marginTop: 8, wordBreak: "break-all" }}>
            {skillResult}
          </div>
        )}
      </SectionCard>

      {/* 进化：生命周期 + 人格特质权重曲线 + 行为/交互积累 */}
      <SectionCard title="进化（人格特质权重 + 行为沉淀）">
        {!evolution?.ok ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7 }}>
            演化引擎（生命周期状态机 + trait 强化/弱化/遗忘）已在 core-ts 完整实现；
            请先在「情绪调节」中选择目标 Agent 后查看其进化状态。
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>生命周期：</span>
              <span style={{
                padding: "2px 10px", borderRadius: 10, fontSize: 11.5, fontWeight: 700,
                background: "var(--accent-soft)", color: "var(--accent-hover)",
              }}>
                {evolution.lifecycle ?? "unknown"}
              </span>
              {evolution.created_at && (
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  创建于 {new Date(evolution.created_at).toLocaleDateString("zh-CN")}
                </span>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12 }}>
              {[
                { label: "人格特质", value: evolution.traits?.length ?? 0 },
                { label: "行为沉淀", value: evolution.behaviorCount ?? 0 },
                { label: "交互积累", value: evolution.interactionCount ?? 0 },
              ].map((s) => (
                <div key={s.label} style={{
                  textAlign: "center", padding: "8px 4px", borderRadius: 10,
                  background: "var(--bg-input)", border: "1px solid var(--border)",
                }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "var(--accent-hover)" }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
              人格特质权重（0–1，越高代表该特质在交互中被强化得越稳固）：
            </div>
            {(evolution.traits ?? []).length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "6px 0" }}>
                暂无已沉淀的人格特质 — 与 {evolution.agentName ?? "该 Agent"} 多轮对话后，高频行为模式会自动固化为特质。
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(evolution.traits ?? []).map((t) => (
                  <div key={t.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 90, fontSize: 11.5, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t.name}
                    </span>
                    <div style={{
                      flex: 1, height: 10, borderRadius: 5, background: "var(--border)",
                      overflow: "hidden",
                    }}>
                      <div style={{
                        width: `${Math.max(2, Math.min(100, (t.weight ?? 0) * 100))}%`, height: "100%",
                        background: "linear-gradient(90deg, var(--accent-soft), var(--accent))",
                        borderRadius: 5, transition: "width 0.4s",
                      }} />
                    </div>
                    <span style={{ width: 40, textAlign: "right", fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>
                      {(t.weight ?? 0).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.6 }}>
              特质权重由演化引擎在对话中按成功/失败反馈强化或弱化（半衰期遗忘），行为沉淀将高频交互固化为稳定习惯；
              完整演化状态可经 CLI（/evolve）查看。
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}