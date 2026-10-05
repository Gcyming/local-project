





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


export function mindHooks(emotion: EmotionalState, behavior: BehaviorStore): InjectionHooks {
  return {
    fixedSegments: () => [],
    volatileSegments: () => buildMindSegments(emotion, behavior),
    retrieveSegments: async () => [],
  };
}