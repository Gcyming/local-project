/**
 * core-ts/src/mind/hooks.ts — 心智注入默认实现（Session 双路径注入骨架的 fixedSegments 消费方）。
 * L2 固定段：行为模式提示 + 情绪风格/工具倾向/自我认知叙事（阶段 4.1 接入）。
 * shadow 预留：BehaviorStore.clone() 供分裂继承使用（阶段 4.5 Swarm 消费），此处不持有实例。
 */

import { EmotionalState } from "./emotion.js";
import { BehaviorStore } from "./behavior.js";
import { InjectionHooks } from "../session.js";

export function buildMindSegments(emotion: EmotionalState, behavior: BehaviorStore): string[] {
  const parts: string[] = [];
  const behaviorPrompt = behavior.toPrompt(5);
  if (behaviorPrompt) {
    parts.push(behaviorPrompt);
  }
  parts.push(`## 当前状态\n${emotion.toIdentityPrompt()}\n\n${emotion.toPrompt()}`);
  return parts;
}

/** 默认心智注入 hooks：fixedSegments 注入情绪/行为；检索段阶段 4.2 接入 */
export function mindHooks(emotion: EmotionalState, behavior: BehaviorStore): InjectionHooks {
  return {
    fixedSegments: () => buildMindSegments(emotion, behavior),
    retrieveSegments: async () => [],
  };
}