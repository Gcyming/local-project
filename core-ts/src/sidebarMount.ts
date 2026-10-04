































export interface SidebarMountPayload {
  
  sessionId: string;
  
  text: string;
  
  at?: number;
}

let current: SidebarMountPayload | null = null;


export function setSidebarMount(p: SidebarMountPayload | null): void {
  if (!p || !p.sessionId || !String(p.text ?? "").trim()) {
    current = null;
    return;
  }
  current = { sessionId: p.sessionId, text: String(p.text), at: p.at ?? Date.now() };
}


export function getSidebarMount(): SidebarMountPayload | null {
  return current;
}









export function sidebarMountSection(sessionId?: string): string {
  const cur = current;
  if (!cur) { return ""; }
  const sid = String(sessionId ?? "").trim();
  if (!sid || sid !== cur.sessionId) { return ""; }
  const text = String(cur.text ?? "").trim();
  if (!text) { return ""; }
  return `【右侧边栏 · 实时挂载】\n${text}\n`
    + `（这是用户此刻在右栏看的东西，**不是**用户刚说的话。用户在对话里说「这个 / 这一页 / 它 / 帮我看看」`
    + `而上下文里没有别的指代对象时，优先理解成右栏这一项；需要正文就用 web_fetch 打开上面的地址，`
    + `不要反问用户「你指的是什么」。右栏换了内容这里会跟着变。）`;
}


export function __resetSidebarMountForTest(): void {
  current = null;
}
