"""测试 SILAM 集成端点（4C 阶段验收）。

注意：本模块是对外部 SILAM HTTP 服务（localhost:19100，slime-infer-sidecar）
的集成测试——服务不在本仓库内，需手动启动后才真正执行。
服务未启动时整模块显式 skip（保留服务在时的真实验证能力），
避免让常驻全量 QA（py qa.py）被环境依赖卡死（A-122 修复）。
"""
import json
import sys
import requests
import pytest

BASE_URL = "http://localhost:19100"


def _sidecar_up() -> bool:
    try:
        requests.get(f"{BASE_URL}/health", timeout=1.0)
        return True
    except requests.RequestException:
        return False


pytestmark = pytest.mark.skipif(
    not _sidecar_up(),
    reason="SILAM HTTP sidecar(:19100) 未启动——集成测试跳过（启动后自动恢复）")


def test_silam_health():
    """测试 /silam/health 端点。"""
    resp = requests.get(f"{BASE_URL}/silam/health")
    assert resp.status_code == 200, f"health failed: {resp.status_code}"
    data = resp.json()
    print(f"[OK] /silam/health: {json.dumps(data, ensure_ascii=False)}")
    assert data["service"] == "silam"
    return data


def test_silam_inference():
    """测试 /silam/inference 端点。"""
    test_cases = [
        ("磁盘快满了", "error"),
        ("系统空闲待命中", "idle"),
        ("用户要求删除缓存但权限不足", "conflict"),
        ("任务完成：日志分析成功", "normal"),
    ]
    results = []
    for text, label in test_cases:
        payload = {
            "request_id": f"test-{label}",
            "type": "inference",
            "payload": {"state_text": text}
        }
        resp = requests.post(f"{BASE_URL}/silam/inference", json=payload)
        assert resp.status_code == 200, f"inference failed for {text}: {resp.status_code}"
        data = resp.json()
        assert data["status"] == "success"
        payload_data = data["payload"]
        tool_call = payload_data.get("tool_call", {})
        code = payload_data.get("code") or tool_call.get("tool", "unknown")
        results.append({
            "text": text,
            "code": code,
            "fear": payload_data["new_fear"],
            "nodes": payload_data["n_nodes"],
        })
        print(f"  [{label}] {text[:20]:20s} -> code={code:<12s} fear={payload_data['new_fear']:.2f} nodes={payload_data['n_nodes']}")
    return results


def test_original_health():
    """测试原有 /health 端点未被破坏。"""
    resp = requests.get(f"{BASE_URL}/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "slime-infer-sidecar"
    print(f"[OK] /health: 原有端点正常（{data['port']} 端口）")


def test_silam_status():
    """测试 /silam/status 端点。"""
    resp = requests.get(f"{BASE_URL}/silam/status")
    assert resp.status_code == 200
    data = resp.json()
    print(f"[OK] /silam/status: step={data.get('step', 'N/A')}, nodes={data.get('n_nodes', 'N/A')}")
    return data


def main():
    print("=== SILAM 集成测试 ===")
    try:
        health = test_silam_health()
        inference_results = test_silam_inference()
        test_original_health()
        status = test_silam_status()

        print("\n=== 测试结果 ===")
        print(f"SILAM 状态: {'启用' if health.get('status') == 'ok' else '禁用'}")
        print(f"推理测试: {len(inference_results)} 条全部通过")
        print(f"原有功能: /health 正常")
        print("\n[PASS] 4C 集成验收通过！")
        return 0
    except Exception as e:
        print(f"\n[FAIL] 测试失败: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
