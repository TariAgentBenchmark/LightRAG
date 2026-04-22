import importlib.util
import sys
import types
from pathlib import Path

import pytest


def load_query_routes():
    previous_utils_api = sys.modules.get("lightrag.api.utils_api")
    utils_api = types.ModuleType("lightrag.api.utils_api")
    utils_api.get_combined_auth_dependency = lambda _api_key=None: None
    sys.modules["lightrag.api.utils_api"] = utils_api

    module_path = Path(__file__).resolve().parents[1] / "lightrag/api/routers/query_routes.py"
    spec = importlib.util.spec_from_file_location("query_routes_under_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        if previous_utils_api is None:
            sys.modules.pop("lightrag.api.utils_api", None)
        else:
            sys.modules["lightrag.api.utils_api"] = previous_utils_api
    return module


query_routes = load_query_routes()
finalize_response_references = query_routes.finalize_response_references


@pytest.mark.offline
def test_finalize_response_references_rebuilds_list_from_body_citations():
    content = """第一句引用第三个来源[3]。
第二句同时引用第一个和第三个来源[1][3]。

### References

- [1] 模型自己写的旧引用
- [4] 模型自己写的跳号引用
"""
    references = [
        {"reference_id": "1", "file_path": "Book A.pdf", "content": ["a"]},
        {"reference_id": "3", "file_path": "Book C.pdf", "content": ["c"]},
        {"reference_id": "4", "file_path": "Unused.pdf", "content": ["unused"]},
    ]

    response, final_references = finalize_response_references(content, references)

    assert final_references == [
        {"reference_id": "1", "file_path": "Book C.pdf", "content": ["c"]},
        {"reference_id": "2", "file_path": "Book A.pdf", "content": ["a"]},
    ]
    assert "模型自己写的旧引用" not in response
    assert "Unused.pdf" not in response
    assert "第一句引用第三个来源[1]。" in response
    assert "第二句同时引用第一个和第三个来源[2][1]。" in response
    assert response.endswith("- [1] Book C.pdf\n- [2] Book A.pdf")


@pytest.mark.offline
def test_finalize_response_references_drops_unknown_citations():
    response, final_references = finalize_response_references(
        "可信内容[2]，未知来源[8]。",
        [{"reference_id": "2", "file_path": "Known.pdf"}],
    )

    assert final_references == [{"reference_id": "1", "file_path": "Known.pdf"}]
    assert "可信内容[1]，未知来源。" in response
