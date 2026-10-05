import { readMemoryConfig } from "./store.js";

export interface RecallSessionState {
  prev_task_type?: string | null;
  cur_task_type?: string | null;
}

export interface RecallGateOptions {
  enabled?: boolean;
  projectRoot?: string;
}

export interface RecallGateDecision {
  retrieve: boolean;
  signal: string;
  enabled: boolean;
}

const PAST_TENSE_RE = /(?:上次|上回|之前|刚才|刚|刚刚|当时|回头|那时|那时候|上周|上个月|last time|previously|earlier|that time|last week|last month)/i;

const WORD_BODY = "\\p{L}\\p{N}_";

const REFERENCE_RE = new RegExp(
  `(?:那个|那篇|那段|这款|它们|(?<![${WORD_BODY}])them(?![${WORD_BODY}])|(?<![${WORD_BODY}])it(?![${WORD_BODY}])|this one|that one|that thing|earlier|above)`,
  "u",
);

const NEW_ENTITY_RE = new RegExp(
  `(?:[A-Za-z][${WORD_BODY}.+\\-]{2,40}|[A-Z_][${WORD_BODY}]{3,40})`,
  "u",
);

const TASK_TYPE_RE = /(?:任务|作业|问题|故障|缺陷|bug|issue|task|job|problem|fix|debug|修复|报错|异常)/i;

export const RECALL_GATE_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["past_tense", PAST_TENSE_RE],
  ["reference", REFERENCE_RE],
  ["new_entity", NEW_ENTITY_RE],
  ["task_type", TASK_TYPE_RE],
];

function resolveEnabled(opts?: RecallGateOptions): boolean {
  if (typeof opts?.enabled === "boolean") return opts.enabled;
  return readMemoryConfig(opts?.projectRoot).recallGateEnabled;
}

export function recallGateDecision(
  message: string,
  sessionState?: RecallSessionState | null,
  opts?: RecallGateOptions,
): RecallGateDecision {
  const enabled = resolveEnabled(opts);
  if (!enabled) return { retrieve: true, signal: "gate_disabled", enabled: false };

  const msg = typeof message === "string" ? message.trim() : "";
  if (!msg) return { retrieve: false, signal: "empty", enabled: true };

  const prev = String(sessionState?.prev_task_type ?? "").trim().toLowerCase();
  const cur = String(sessionState?.cur_task_type ?? "").trim().toLowerCase();
  if (prev && cur && prev !== cur) {
    return { retrieve: true, signal: "task_type_switch", enabled: true };
  }

  for (const [name, pattern] of RECALL_GATE_SIGNALS) {
    if (pattern.test(msg)) return { retrieve: true, signal: name, enabled: true };
  }

  return { retrieve: false, signal: "no_signal", enabled: true };
}

export function shouldRetrieveMemory(
  message: string,
  sessionState?: RecallSessionState | null,
  opts?: RecallGateOptions,
): boolean {
  return recallGateDecision(message, sessionState, opts).retrieve;
}