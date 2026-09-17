"""tests/test_contract.py — 契约层双端互验（pydantic 侧；同一 fixtures 供 zod 侧复验）。

契约硬门槛（无 CI）：pnpm run contract:check 串行执行
① gen 无漂移（py scripts/gen_contracts.py --check）
② pydantic 导入 + 本文件假数据校验
③ zod 假数据校验（tests/core-ts/contract.spec.ts）
"""

import json
from pathlib import Path

import pytest

from shared.gen.schemas import (
    ChatCompletionChunk,
    ChatMessage,
    ChatRequest,
    ChatResponse,
    EmbeddingsRequest,
    EmbeddingsResponse,
    HealthResponse,
    ModelLoadRequest,
    ModelLoadResponse,
    ModelUnloadResponse,
    RetrieveRequest,
    RetrieveResponse,
    StatsResponse,
)

_FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures_contract.json").read_text(encoding="utf-8")
)

_VALID = _FIXTURES["valid"]
_INVALID = _FIXTURES["invalid"]

_MODELS = {
    "ChatMessage": ChatMessage,
    "ChatRequest": ChatRequest,
    "ChatResponse": ChatResponse,
    "ChatCompletionChunk": ChatCompletionChunk,
    "EmbeddingsRequest": EmbeddingsRequest,
    "EmbeddingsResponse": EmbeddingsResponse,
    "RetrieveRequest": RetrieveRequest,
    "RetrieveResponse": RetrieveResponse,
    "HealthResponse": HealthResponse,
    "StatsResponse": StatsResponse,
    "ModelLoadRequest": ModelLoadRequest,
    "ModelLoadResponse": ModelLoadResponse,
    "ModelUnloadResponse": ModelUnloadResponse,
}

# invalid fixtures 与模型名映射（_bad/_missing 后缀剔除）
_INVALID_MODELS = {
    "ChatRequest_missing_messages": ChatRequest,
    "ChatMessage_bad_role": ChatMessage,
    "ChatResponse_bad_object": ChatResponse,
    "RetrieveRequest_bad_agent": RetrieveRequest,
    "ModelLoadRequest_bad_role": ModelLoadRequest,
    "ModelLoadResponse_missing_ok": ModelLoadResponse,
}


@pytest.mark.parametrize("name", sorted(_VALID))
def test_valid_fixture(name):
    model = _MODELS.get(name) or _MODELS.get(name.replace("Batch", ""))
    assert model is not None, f"fixture {name} 无对应模型"
    obj = model.model_validate(_VALID[name])
    assert obj is not None


@pytest.mark.parametrize("name", sorted(_INVALID))
def test_invalid_fixture(name):
    model = _INVALID_MODELS[name]
    with pytest.raises(Exception):
        model.model_validate(_INVALID[name])