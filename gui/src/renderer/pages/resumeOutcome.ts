


































export const RESUME_MAX_ATTEMPTS = 3;


export const RESUME_QUERY_RETRY_MS = 700;


export type ResumeQueryResult = { active: boolean } | null | undefined;


export type ResumeBubbleAction = "settle" | "drop" | "keep";

export interface ResumeOutcome {
  
  endLoading: boolean;
  
  bubble: ResumeBubbleAction;
  
  retry: boolean;
  




  confirmedDead: boolean;
}

export interface ResumeOutcomeInput {
  
  query: ResumeQueryResult;
  
  attempts: number;
  
  maxAttempts: number;
  
  partial: string;
  
  hasTailError: boolean;
}















export function decideResumeOutcome(input: ResumeOutcomeInput): ResumeOutcome {
  const partial = (input.partial ?? "").trim();
  const settledOk = partial.length > 0 && !input.hasTailError;

  if (input.query && input.query.active) {
    return { endLoading: false, bubble: "keep", retry: false, confirmedDead: false };
  }
  if (input.query) {
    
    
    return {
      endLoading: true,
      bubble: settledOk ? "settle" : "drop",
      retry: false,
      confirmedDead: true,
    };
  }
  
  if (input.attempts < input.maxAttempts) {
    return { endLoading: false, bubble: "keep", retry: true, confirmedDead: false };
  }
  return { endLoading: true, bubble: "keep", retry: false, confirmedDead: false };
}
