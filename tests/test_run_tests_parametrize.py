"""run_tests.py 的 parametrize 展开能力自测（对齐 run_tests.py 约定：仅 setup_method / tmp_path）。"""

from pathlib import Path

import pytest


class TestParametrizeExpansion:
    def setup_method(self):
        self.ready = True

    @pytest.mark.parametrize("banned", ["text", "encoding"])
    def test_单名_逐值展开(self, banned):
        assert banned in ("text", "encoding")
        assert self.ready is True

    @pytest.mark.parametrize("a,b", [(1, 2), (3, 4)])
    def test_具名元组_多参数展开(self, a, b):
        assert b == a + 1

    @pytest.mark.parametrize("x", [0, 1])
    @pytest.mark.parametrize("y", [2, 3])
    def test_叠加_笛卡尔积(self, x, y):
        assert x in (0, 1) and y in (2, 3)

    @pytest.mark.parametrize(
        "v", [pytest.param("a", id="first"), pytest.param("b", id="second")]
    )
    def test_pytest_param_带_id(self, v):
        assert v in ("a", "b")

    @pytest.mark.parametrize("v", [pytest.param("a", marks=pytest.mark.skip(reason="demo"))])
    def test_pytest_param_带_skip(self, v):
        raise AssertionError(f"被 skip 的用例不应执行: {v}")

    @pytest.mark.parametrize("p", [1], ids=["一号"])
    def test_ids_列表(self, p):
        assert p == 1

    @pytest.mark.parametrize("d", [Path("x")])
    def test_参数值是_Path_不被当_tmp_path_删掉(self, d, tmp_path):
        assert d.name == "x"
        assert tmp_path.is_dir()
