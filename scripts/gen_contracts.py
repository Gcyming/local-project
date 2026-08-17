"""
scripts/gen_contracts.py — 契约层生成器（唯一真相源: shared/openapi.yaml）。

输出（生成物，禁止手改）：
- shared/gen/schemas.ts    zod v3 schemas + 类型推导（Node 侧）
- shared/gen/schemas.py    pydantic v2 模型（Python 侧）

设计要点：
- components.schemas 顶层项 → 具名模型；内联 object → 按路径提升为具名类
  （ChatRequest.messages.items → ChatRequestMessages），双端对称、嵌套引用合法
- $ref 引用保留类名，不内联展开
- 确定性：字段按 yaml 声明顺序输出

用法：
- py scripts/gen_contracts.py            重新生成
- py scripts/gen_contracts.py --check    幂等校验（与磁盘 diff，无差异退出 0）
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OPENAPI = PROJECT_ROOT / "shared" / "openapi.yaml"
GEN_DIR = PROJECT_ROOT / "shared" / "gen"

TS_HEADER = "// 本文件由 scripts/gen_contracts.py 从 shared/openapi.yaml 自动生成，禁止手改。\n"
PY_HEADER = "# 本文件由 scripts/gen_contracts.py 从 shared/openapi.yaml 自动生成，禁止手改。\n"

_CLASSES: dict[str, dict] = {}          # 类名 -> {"ts": [...], "py": [...]}
_CLASS_ORDER: list[str] = []


def _ref_name(schema: dict) -> str | None:
    ref = schema.get("$ref")
    return ref.rsplit("/", 1)[-1] if ref else None


def _cls_name(path: str) -> str:
    segs = [s for s in re.split(r"[.\[]", path) if s and s != "items"]
    return _pascal(".".join(segs))


def _pascal(s: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[^0-9a-zA-Z]", s) if p)


def _register_object(path: str, schema: dict, components: dict) -> str:
    """内联 object 提升为具名类；返回类名。子类先注册（DFS）。"""
    name = _cls_name(path)
    if name in _CLASSES:
        return name
    props = schema.get("properties", {})
    req = set(schema.get("required", []))
    ts_fields: list[str] = []
    py_fields: list[str] = []
    for fname, fsch in props.items():
        tse = _ts_expr(f"{path}.{fname}", fsch, components)
        pye = _py_expr(f"{path}.{fname}", fsch, components)
        if fname in req:
            ts_fields.append(f"{fname}: {tse}")
            py_fields.append(f"{fname}: {pye}")
        else:
            ts_fields.append(f"{fname}: {tse}.optional()")
            py_fields.append(f"{fname}: Optional[{pye}] = None")
    _CLASSES[name] = {"ts": ts_fields, "py": py_fields}
    _CLASS_ORDER.append(name)
    return name


def _ts_expr(path: str, schema: dict, components: dict) -> str:
    ref = _ref_name(schema)
    if ref:
        return ref
    t = schema.get("type")
    if t == "object" and schema.get("properties"):
        return _register_object(path, schema, components)
    if t == "string":
        if schema.get("enum"):
            lit = ", ".join(repr(v) for v in schema["enum"])
            out = f"z.enum([{lit}])"
        elif schema.get("pattern"):
            out = f"z.string().regex(new RegExp({schema['pattern']!r}))"
        else:
            out = "z.string()"
    elif t == "integer":
        out = "z.number()"
    elif t == "number":
        out = "z.number()"
    elif t == "boolean":
        out = "z.boolean()"
    elif t == "array":
        out = f"z.array({_ts_expr(path, schema['items'], components)})"
    elif t == "object":
        out = "z.record(z.any())"
    elif "oneOf" in schema:
        out = f"z.union([{', '.join(_ts_expr(path, s, components) for s in schema['oneOf'])}])"
    else:
        out = "z.any()"
    if schema.get("nullable"):
        out = f"{out}.nullable()"
    return out


def _py_expr(path: str, schema: dict, components: dict) -> str:
    ref = _ref_name(schema)
    if ref:
        return ref
    t = schema.get("type")
    if t == "object" and schema.get("properties"):
        return _register_object(path, schema, components)
    if t == "string":
        if schema.get("enum"):
            return f"Literal[{', '.join(repr(v) for v in schema['enum'])}]"
        if schema.get("pattern"):
            return f"Annotated[str, Field(pattern={schema['pattern']!r})]"
        return "str"
    if t == "integer":
        return "int"
    if t == "number":
        return "float"
    if t == "boolean":
        return "bool"
    if t == "array":
        return f"List[{_py_expr(path, schema['items'], components)}]"
    if t == "object":
        return "Dict[str, Any]"
    if "oneOf" in schema:
        return f"Union[{', '.join(_py_expr(path, s, components) for s in schema['oneOf'])}]"
    return "Any"


def gen_ts(components: dict) -> str:
    lines = [TS_HEADER, 'import { z } from "zod";', ""]
    for name in _CLASS_ORDER:
        fields = _CLASSES[name]["ts"]
        lines.append(f"export const {name} = z.object({{ {', '.join(fields)} }});")
        lines.append(f"export type {name} = z.infer<typeof {name}>;")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def gen_py(components: dict) -> str:
    lines = [PY_HEADER,
             "from typing import Annotated, Any, Dict, List, Literal, Optional, Union",
             "",
             "from pydantic import BaseModel, Field",
             "",
             ]
    for name in _CLASS_ORDER:
        lines.append(f"class {name}(BaseModel):")
        for field in _CLASSES[name]["py"]:
            lines.append(f"    {field}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _reset() -> None:
    _CLASSES.clear()
    _CLASS_ORDER.clear()


def main() -> int:
    data = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
    components = data.get("components", {})
    schemas = components.get("schemas", {})
    _reset()
    for name, sch in schemas.items():
        _ts_expr(name, sch, components)
        _py_expr(name, sch, components)
    ts = gen_ts(components)
    py = gen_py(components)

    if "--check" in sys.argv:
        out_ts = GEN_DIR / "schemas.ts"
        out_py = GEN_DIR / "schemas.py"
        if not out_ts.exists() or not out_py.exists():
            print("[contract] 生成物缺失，先运行 py scripts/gen_contracts.py")
            return 1
        if out_ts.read_text(encoding="utf-8") != ts:
            print("[contract] FAIL: shared/gen/schemas.ts 与 openapi.yaml 不一致")
            return 1
        if out_py.read_text(encoding="utf-8") != py:
            print("[contract] FAIL: shared/gen/schemas.py 与 openapi.yaml 不一致")
            return 1
        print("[contract] 生成物与契约源一致（无漂移）")
        return 0

    GEN_DIR.mkdir(parents=True, exist_ok=True)
    (GEN_DIR / "schemas.ts").write_text(ts, encoding="utf-8")
    (GEN_DIR / "schemas.py").write_text(py, encoding="utf-8")
    print("[contract] 已生成 shared/gen/schemas.ts + schemas.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
