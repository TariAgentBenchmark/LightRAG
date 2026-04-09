import pytest

from lightrag.base import QueryParam
from lightrag.prompt import PROMPTS
from lightrag.operate import (
    _build_additional_prompt_instructions,
    _get_effective_history_messages,
    _is_definition_query,
    _prepare_effective_query_param,
)


@pytest.mark.offline
def test_definition_query_detection_handles_zh_and_en():
    assert _is_definition_query("道法自然是什么意思")
    assert _is_definition_query("What is Tao?")
    assert not _is_definition_query("请总结这一章")


@pytest.mark.offline
def test_prepare_effective_query_param_expands_retrieval_for_definition_queries():
    query_param = QueryParam(top_k=8, chunk_top_k=6)

    effective = _prepare_effective_query_param(query_param, "道法自然的定义")

    assert effective.is_definition_query is True
    assert effective.top_k > query_param.top_k
    assert effective.chunk_top_k > query_param.chunk_top_k
    assert effective.retrieval_query == "道法自然的定义"


@pytest.mark.offline
def test_history_messages_are_disabled_by_default():
    query_param = QueryParam(
        conversation_history=[{"role": "user", "content": "上一题"}],
        use_conversation_history=False,
    )
    assert _get_effective_history_messages(query_param) is None

    query_param.use_conversation_history = True
    assert _get_effective_history_messages(query_param) == [
        {"role": "user", "content": "上一题"}
    ]


@pytest.mark.offline
def test_additional_prompt_instructions_emphasize_grounded_followups():
    instructions = _build_additional_prompt_instructions(QueryParam())

    assert "Do not add unsupported comparisons" in instructions
    assert "cover the major supported points explicitly" in instructions
    assert "exactly 3 short related follow-up questions" in instructions


@pytest.mark.offline
def test_rag_prompts_require_follow_up_questions_before_references():
    for prompt_name in ("rag_response", "naive_rag_response"):
        prompt = PROMPTS[prompt_name]
        assert "exactly 3 related questions" in prompt
        assert "immediately before the references section" in prompt
        assert "at the very end of the response" in prompt
