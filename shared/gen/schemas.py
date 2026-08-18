# 本文件由 scripts/gen_contracts.py 从 shared/openapi.yaml 自动生成，禁止手改。

from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field

class ChatToolCallFunction(BaseModel):
    name: str
    arguments: str

class ChatToolCall(BaseModel):
    id: str
    type: Literal['function']
    function: ChatToolCallFunction

class ChatToolSchemaFunction(BaseModel):
    name: str
    description: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None

class ChatToolSchema(BaseModel):
    type: Literal['function']
    function: ChatToolSchemaFunction

class ChatMessage(BaseModel):
    role: Literal['system', 'user', 'assistant', 'tool']
    content: str
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[ChatToolCall]] = None

class ChatRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    tools: Optional[List[ChatToolSchema]] = None
    stream: Optional[bool] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    stop: Optional[Union[str, List[str]]] = None
    presence_penalty: Optional[float] = None
    frequency_penalty: Optional[float] = None

class ChatUsage(BaseModel):
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None

class ChatChoice(BaseModel):
    index: Optional[int] = None
    message: Optional[ChatMessage] = None
    finish_reason: Optional[str] = None

class ChatResponse(BaseModel):
    id: str
    object: Literal['chat.completion']
    created: int
    model: str
    choices: List[ChatChoice]
    usage: Optional[ChatUsage] = None

class ChatDelta(BaseModel):
    role: Optional[str] = None
    content: Optional[str] = None

class ChatChunkChoice(BaseModel):
    index: Optional[int] = None
    delta: Optional[ChatDelta] = None
    finish_reason: Optional[str] = None

class ChatCompletionChunk(BaseModel):
    id: str
    object: Literal['chat.completion.chunk']
    created: int
    model: str
    choices: List[ChatChunkChoice]

class EmbeddingsRequest(BaseModel):
    model: Optional[str] = None
    input: Union[str, List[str]]

class EmbeddingData(BaseModel):
    object: Literal['embedding']
    index: int
    embedding: List[float]

class EmbeddingsResponse(BaseModel):
    object: Literal['list']
    data: List[EmbeddingData]
    model: str
    usage: ChatUsage

class RetrieveRequest(BaseModel):
    agent_id: Annotated[str, Field(pattern='^[A-Za-z0-9_-]{1,64}$')]
    query: str
    top_k: Optional[int] = None
    max_hops: Optional[int] = None
    tags: Optional[Union[str, List[str]]] = None

class MemoryItem(BaseModel):
    id: str
    content: str
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    importance: Optional[int] = None
    links: Optional[List[str]] = None
    backlinks: Optional[List[str]] = None
    weight: Optional[float] = None

class RetrieveStages(BaseModel):
    seeds: Optional[int] = None
    link_walked: Optional[int] = None
    tag_filtered: Optional[int] = None
    ranked: Optional[int] = None

class RetrieveResponse(BaseModel):
    agent_id: str
    query: str
    count: int
    stages: Optional[RetrieveStages] = None
    items: List[MemoryItem]

class ModelInstance(BaseModel):
    role: Optional[str] = None
    model: Optional[str] = None
    port: Optional[int] = None
    pid: Optional[int] = None
    state: Optional[str] = None
    persistent: Optional[bool] = None
    external: Optional[bool] = None
    vram_gb: Optional[Dict[str, Any]] = None

class VRAMInfo(BaseModel):
    total_gb: Optional[float] = None
    free_gb: Optional[float] = None
    used_gb: Optional[float] = None

class HealthResponse(BaseModel):
    status: Literal['ok']
    service: str
    port: Optional[int] = None
    vram: Optional[VRAMInfo] = None
    instances: Optional[List[ModelInstance]] = None

class StatsResponseMemory(BaseModel):
    dir: Optional[str] = None
    lancedb_enabled: Optional[bool] = None
    lancedb_uri: Optional[str] = None

class StatsResponse(BaseModel):
    vram: Optional[VRAMInfo] = None
    instances: Optional[List[ModelInstance]] = None
    memory: Optional[StatsResponseMemory] = None

class ModelLoadRequest(BaseModel):
    role: Literal['chat', 'embedding']

class ModelLoadResponse(BaseModel):
    ok: bool
    port: Optional[int] = None
    state: Optional[str] = None
    error: Optional[str] = None
    detail: Optional[str] = None

class ModelUnloadResponse(BaseModel):
    ok: bool
    state: Optional[str] = None
    error: Optional[str] = None
