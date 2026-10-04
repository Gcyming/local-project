"""
slime 人格画像模块
初始状态：空骨架（无 traits、无 preferences）
每次对话后调用 evolve 分析交互模式，逐步演化
"""

import copy
from datetime import datetime, timezone




EMPTY = {
    "traits": [],
    "preferences": [],
    "skill_ownership": [],
    "interactions": [],
    "created_at": None,
    "updated_at": None,
}




def _normalize_traits(value: list) -> list:
    """
    标准化 traits 格式。
    支持两种输入：
    1. 字符串列表: ['helpful', 'precise'] → [{'name': 'helpful', 'weight': 0.5, 'last_used': None}, ...]
    2. Dict 列表: [{'name': 'helpful', 'weight': 0.5}, ...] → 补全 last_used
    """
    if not value:
        return []

    normalized = []
    for item in value:
        if isinstance(item, str):
            normalized.append({"name": item, "weight": 0.5, "last_used": None})
        elif isinstance(item, dict):
            normalized.append({
                "name": item.get("name") or item.get("trait", "unknown"),
                "weight": item.get("weight", 0.5),
                "last_used": item.get("last_used"),
            })
        else:
            continue
    return normalized




class Persona:
    """Agent 人格画像，支持克隆和演化"""

    def __init__(self, data: dict | None = None):
        if data is None:
            self.data = copy.deepcopy(EMPTY)
        else:
            
            self.data = copy.deepcopy(EMPTY)
            for key in EMPTY:
                if key in data:
                    if key == "traits":
                        
                        self.data[key] = _normalize_traits(data[key])
                    else:
                        self.data[key] = copy.deepcopy(data[key])
        if self.data["created_at"] is None:
            self.data["created_at"] = datetime.now(timezone.utc).isoformat()
        self.data["updated_at"] = datetime.now(timezone.utc).isoformat()

    

    @property
    def traits(self) -> list:
        return self.data["traits"]

    @traits.setter
    def traits(self, value: list):
        self.data["traits"] = _normalize_traits(value)
        self._touch()

    @property
    def preferences(self) -> list:
        return self.data["preferences"]

    @preferences.setter
    def preferences(self, value: list):
        self.data["preferences"] = value
        self._touch()

    @property
    def skill_ownership(self) -> list:
        return self.data["skill_ownership"]

    @skill_ownership.setter
    def skill_ownership(self, value: list):
        self.data["skill_ownership"] = value
        self._touch()

    @property
    def interactions(self) -> list:
        return self.data["interactions"]

    

    def add_interaction(self, user_msg: str, ai_reply: str, success: bool = True):
        """记录一次对话交互（保留最近 200 条）"""
        self.data["interactions"].append({
            "user": user_msg,
            "ai": ai_reply,
            "success": success,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        
        if len(self.data["interactions"]) > 200:
            self.data["interactions"] = self.data["interactions"][-200:]
        self._touch()

    

    def clone(self) -> "Persona":
        """深拷贝，用于分裂时创建子 Agent 人格"""
        return Persona(self.data)

    

    def to_dict(self) -> dict:
        return copy.deepcopy(self.data)

    @classmethod
    def from_dict(cls, data: dict) -> "Persona":
        return cls(data)

    

    def _touch(self):
        self.data["updated_at"] = datetime.now(timezone.utc).isoformat()
