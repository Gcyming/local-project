// 本文件由 scripts/gen_contracts.py 从 shared/openapi.yaml 自动生成，禁止手改。

import { z } from "zod";

export const ChatMessage = z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string(), name: z.string().optional() });
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatRequest = z.object({ model: z.string().optional(), messages: z.array(ChatMessage), stream: z.boolean().optional(), max_tokens: z.number().optional(), temperature: z.number().optional(), top_p: z.number().optional(), stop: z.union([z.string(), z.array(z.string())]).optional(), presence_penalty: z.number().optional(), frequency_penalty: z.number().optional() });
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatUsage = z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), total_tokens: z.number().optional() });
export type ChatUsage = z.infer<typeof ChatUsage>;

export const ChatChoice = z.object({ index: z.number().optional(), message: ChatMessage.optional(), finish_reason: z.string().nullable().optional() });
export type ChatChoice = z.infer<typeof ChatChoice>;

export const ChatResponse = z.object({ id: z.string(), object: z.enum(['chat.completion']), created: z.number(), model: z.string(), choices: z.array(ChatChoice), usage: ChatUsage.optional() });
export type ChatResponse = z.infer<typeof ChatResponse>;

export const ChatDelta = z.object({ role: z.string().optional(), content: z.string().optional() });
export type ChatDelta = z.infer<typeof ChatDelta>;

export const ChatChunkChoice = z.object({ index: z.number().optional(), delta: ChatDelta.optional(), finish_reason: z.string().nullable().optional() });
export type ChatChunkChoice = z.infer<typeof ChatChunkChoice>;

export const ChatCompletionChunk = z.object({ id: z.string(), object: z.enum(['chat.completion.chunk']), created: z.number(), model: z.string(), choices: z.array(ChatChunkChoice) });
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunk>;

export const EmbeddingsRequest = z.object({ model: z.string().optional(), input: z.union([z.string(), z.array(z.string())]) });
export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequest>;

export const EmbeddingData = z.object({ object: z.enum(['embedding']), index: z.number(), embedding: z.array(z.number()) });
export type EmbeddingData = z.infer<typeof EmbeddingData>;

export const EmbeddingsResponse = z.object({ object: z.enum(['list']), data: z.array(EmbeddingData), model: z.string(), usage: ChatUsage });
export type EmbeddingsResponse = z.infer<typeof EmbeddingsResponse>;

export const RetrieveRequest = z.object({ agent_id: z.string().regex(new RegExp('^[A-Za-z0-9_-]{1,64}$')), query: z.string(), top_k: z.number().optional(), max_hops: z.number().optional(), tags: z.union([z.string(), z.array(z.string())]).optional() });
export type RetrieveRequest = z.infer<typeof RetrieveRequest>;

export const MemoryItem = z.object({ id: z.string(), content: z.string(), category: z.string().optional(), tags: z.array(z.string()).optional(), importance: z.number().optional(), links: z.array(z.string()).optional(), backlinks: z.array(z.string()).optional(), weight: z.number().optional() });
export type MemoryItem = z.infer<typeof MemoryItem>;

export const RetrieveStages = z.object({ seeds: z.number().optional(), link_walked: z.number().optional(), tag_filtered: z.number().optional(), ranked: z.number().optional() });
export type RetrieveStages = z.infer<typeof RetrieveStages>;

export const RetrieveResponse = z.object({ agent_id: z.string(), query: z.string(), count: z.number(), stages: RetrieveStages.optional(), items: z.array(MemoryItem) });
export type RetrieveResponse = z.infer<typeof RetrieveResponse>;

export const ModelInstance = z.object({ role: z.string().optional(), model: z.string().optional(), port: z.number().optional(), pid: z.number().nullable().optional(), state: z.string().optional(), persistent: z.boolean().optional(), external: z.boolean().optional(), vram_gb: z.record(z.any()).optional() });
export type ModelInstance = z.infer<typeof ModelInstance>;

export const VRAMInfo = z.object({ total_gb: z.number().optional(), free_gb: z.number().optional(), used_gb: z.number().optional() });
export type VRAMInfo = z.infer<typeof VRAMInfo>;

export const HealthResponse = z.object({ status: z.enum(['ok']), service: z.string(), port: z.number().optional(), vram: VRAMInfo.optional(), instances: z.array(ModelInstance).optional() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const StatsResponseMemory = z.object({ dir: z.string().optional(), lancedb_enabled: z.boolean().optional(), lancedb_uri: z.string().optional() });
export type StatsResponseMemory = z.infer<typeof StatsResponseMemory>;

export const StatsResponse = z.object({ vram: VRAMInfo.optional(), instances: z.array(ModelInstance).optional(), memory: StatsResponseMemory.optional() });
export type StatsResponse = z.infer<typeof StatsResponse>;

export const ModelLoadRequest = z.object({ role: z.enum(['chat', 'embedding']) });
export type ModelLoadRequest = z.infer<typeof ModelLoadRequest>;

export const ModelLoadResponse = z.object({ ok: z.boolean(), port: z.number().nullable().optional(), state: z.string().optional(), error: z.string().optional(), detail: z.string().optional() });
export type ModelLoadResponse = z.infer<typeof ModelLoadResponse>;

export const ModelUnloadResponse = z.object({ ok: z.boolean(), state: z.string().optional(), error: z.string().optional() });
export type ModelUnloadResponse = z.infer<typeof ModelUnloadResponse>;
