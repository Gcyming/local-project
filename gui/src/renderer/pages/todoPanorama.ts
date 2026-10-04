

















export interface TimelineStep {
  kind: "think" | "body" | "tool" | "plan" | "todo" | "steer";
  



  text?: string;
  
  name?: string;
  
  label?: string;
  
  detail?: string;
  
  result?: string;
  




  running?: boolean;
  




  diffTrimmed?: boolean;
  





  items?: TodoPanoramaItem[];
  
  state?: "start" | "done";
}


export interface TodoPanoramaItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}













export function parseTodoPanorama(raw: string): { items: TodoPanoramaItem[] } | null {
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  if (!text) { return null; }
  
  const lines = text.split("\n").filter((l) => /^\s*-\s*\[[ xX]\]\s+/.test(l));
  if (lines.length === 0) { return null; }
  const items: TodoPanoramaItem[] = lines.map((l, i) => {
    const done = /^\s*-\s*\[[xX]\]/.test(l);
    
    const body = l.replace(/^\s*-\s*\[[ xX]\]\s*/, "").replace(/\s*←\s*进行中\s*$/, "").trim();
    const inProgress = /←\s*进行中\s*$/.test(l);
    return {
      id: String(i + 1),
      content: body,
      status: done ? "completed" : inProgress ? "in_progress" : "pending",
    };
  });
  return { items };
}


export function planSignature(items: TodoPanoramaItem[]): string {
  return items.map((i) => i.content).join("\u0001");
}






export function appendTimelineStep(
  steps: TimelineStep[],
  ev:
    | { kind: "think"; text: string }
    | { kind: "body"; text: string }
    | { kind: "tool"; name?: string; label?: string; detail?: string; result?: string; running?: boolean }
    | { kind: "plan"; items: TodoPanoramaItem[] }
    | { kind: "todo"; text: string; state: "start" | "done" }
    | { kind: "steer"; text: string },
): TimelineStep[] {
  if (ev.kind === "think") {
    if (!ev.text) { return steps; }
    const last = steps[steps.length - 1];
    
    if (last && last.kind === "think") {
      return [...steps.slice(0, -1), { kind: "think", text: (last.text ?? "") + ev.text }];
    }
    return [...steps, { kind: "think", text: ev.text }];
  }
  



















  if (ev.kind === "body") {
    if (!ev.text) { return steps; }
    const last = steps[steps.length - 1];
    if (last && last.kind === "body") {
      return [...steps.slice(0, -1), { kind: "body", text: (last.text ?? "") + ev.text }];
    }
    return [...steps, { kind: "body", text: ev.text }];
  }
  









  if (ev.kind === "steer") {
    if (!ev.text) { return steps; }
    return [...steps, { kind: "steer", text: ev.text }];
  }
  if (ev.kind === "plan") { return [...steps, { kind: "plan", items: ev.items }]; }
  if (ev.kind === "todo") { return [...steps, { kind: "todo", text: ev.text, state: ev.state }]; }
  
  return [...steps, { kind: "tool", name: ev.name, label: ev.label, detail: ev.detail, result: ev.result, running: ev.running }];
}









export function lastPlanItems(steps: TimelineStep[]): TodoPanoramaItem[] | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "plan") { return steps[i].items ?? null; }
  }
  return null;
}













export function foldTodoWriteIntoSteps(
  steps: TimelineStep[],
  items: TodoPanoramaItem[],
  prevItems: TodoPanoramaItem[] | null,
): { steps: TimelineStep[]; items: TodoPanoramaItem[] } {
  if (items.length === 0) { return { steps, items: prevItems ?? [] }; }
  let next = steps;
  const prevSig = prevItems ? planSignature(prevItems) : "";
  const sig = planSignature(items);
  if (prevItems === null || prevSig !== sig) {
    
    next = appendTimelineStep(next, { kind: "plan", items });
  } else {
    
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].kind === "plan") {
        next = [...next.slice(0, i), { ...next[i], items }, ...next.slice(i + 1)];
        break;
      }
    }
  }
  if (prevItems === null) { return { steps: next, items }; }
  
  
  
  const prevStatus = new Map(prevItems.map((it) => [it.content, it.status]));
  for (const it of items) {
    const before = prevStatus.get(it.content);
    const wasCompleted = before === "completed";
    const wasInProgress = before === "in_progress";
    if (it.status === "completed" && !wasCompleted) {
      next = appendTimelineStep(next, { kind: "todo", text: it.content, state: "done" });
    } else if (it.status === "in_progress" && !wasInProgress && !wasCompleted) {
      next = appendTimelineStep(next, { kind: "todo", text: it.content, state: "start" });
    }
  }
  return { steps: next, items };
}























export interface TimelineGroup {
  
  from: number;
  to: number;
  
  steps: TimelineStep[];
  
  headline: string;
  
  toolCount: number;
  
  isLast: boolean;
}


function headlineOf(step: TimelineStep): string {
  const raw = (step.kind === "think" ? step.text : "")
    || step.text
    || step.label
    || step.name
    || "";
  const firstLine = String(raw).split("\n").find((l) => l.trim() !== "") ?? "";
  const t = firstLine.replace(/[#*`>]/g, "").trim();
  if (!t) { return "工作阶段"; }
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}









export function groupTimeline(steps: TimelineStep[]): TimelineGroup[] {
  if (steps.length === 0) { return []; }
  const groups: TimelineGroup[] = [];
  let start = 0;
  for (let i = 1; i <= steps.length; i++) {
    
    
    const boundary = i === steps.length || steps[i].kind === "think";
    if (!boundary) { continue; }
    const slice = steps.slice(start, i);
    const thinkStep = slice.find((s) => s.kind === "think");
    groups.push({
      from: start,
      to: i - 1,
      steps: slice,
      headline: headlineOf(thinkStep ?? slice[0]),
      toolCount: slice.filter((s) => s.kind === "tool").length,
      isLast: false,
    });
    start = i;
  }
  if (groups.length > 0) { groups[groups.length - 1] = { ...groups[groups.length - 1], isLast: true }; }
  return groups;
}
