import pytest

from lightrag.operate import (
    chunking_by_structure_priority,
    merge_small_adjacent_chunks_by_reranker,
)
from lightrag.utils import Tokenizer, TokenizerInterface


class DummyTokenizer(TokenizerInterface):
    def encode(self, content: str):
        return [ord(ch) for ch in content]

    def decode(self, tokens):
        return "".join(chr(token) for token in tokens)


def make_tokenizer() -> Tokenizer:
    return Tokenizer(model_name="dummy", tokenizer=DummyTokenizer())


pytestmark = pytest.mark.offline


def test_structure_priority_splits_sections_on_headings():
    tokenizer = make_tokenizer()

    chunks = chunking_by_structure_priority(
        tokenizer,
        "一、总论\n修炼先修心。\n二、次第\n次第须分明。",
        chunk_token_size=100,
    )

    assert [chunk["content"] for chunk in chunks] == [
        "一、总论\n\n修炼先修心。",
        "二、次第\n\n次第须分明。",
    ]


def test_structure_priority_uses_sentence_boundaries_for_oversized_paragraph():
    tokenizer = make_tokenizer()

    chunks = chunking_by_structure_priority(
        tokenizer,
        "甲乙。丙丁。戊己。庚辛。",
        chunk_token_size=4,
        chunk_overlap_token_size=0,
    )

    assert [chunk["content"] for chunk in chunks] == [
        "甲乙。",
        "丙丁。",
        "戊己。",
        "庚辛。",
    ]


def test_structure_priority_keeps_table_rows_in_single_block_when_possible():
    tokenizer = make_tokenizer()

    chunks = chunking_by_structure_priority(
        tokenizer,
        "表格说明\n项目\t内容\n梦境\t观心\n修炼\t守一\n补充说明",
        chunk_token_size=100,
    )

    assert [chunk["content"] for chunk in chunks] == [
        "表格说明",
        "项目\t内容\n梦境\t观心\n修炼\t守一",
        "补充说明",
    ]


@pytest.mark.asyncio
async def test_merge_small_adjacent_chunks_by_reranker_prefers_right_neighbor():
    tokenizer = make_tokenizer()
    chunks = [
        {"content": "上一题答：性命双修。", "tokens": len(tokenizer.encode("上一题答：性命双修。")), "chunk_order_index": 0},
        {"content": "问：什么是无为？", "tokens": len(tokenizer.encode("问：什么是无为？")), "chunk_order_index": 1},
        {"content": "答：无为不是不做，而是不妄作。", "tokens": len(tokenizer.encode("答：无为不是不做，而是不妄作。")), "chunk_order_index": 2},
    ]

    async def fake_rerank(query: str, documents: list[str], top_n: int | None = None):
        assert query == "问：什么是无为？"
        return [
            {"index": 1, "relevance_score": 0.93},
            {"index": 0, "relevance_score": 0.11},
        ]

    merged = await merge_small_adjacent_chunks_by_reranker(
        tokenizer=tokenizer,
        chunks=chunks,
        rerank_model_func=fake_rerank,
        chunk_token_size=100,
        small_chunk_token_size=20,
        rerank_min_score=0.25,
        rerank_score_margin=0.08,
    )

    assert [chunk["content"] for chunk in merged] == [
        "上一题答：性命双修。",
        "问：什么是无为？\n\n答：无为不是不做，而是不妄作。",
    ]


@pytest.mark.asyncio
async def test_merge_small_adjacent_chunks_by_reranker_prefers_left_neighbor():
    tokenizer = make_tokenizer()
    chunks = [
        {
            "content": "梦境案例一：先讲背景，并说明前因后果与修炼处境。",
            "tokens": len(tokenizer.encode("梦境案例一：先讲背景，并说明前因后果与修炼处境。")),
            "chunk_order_index": 0,
        },
        {"content": "补充说明", "tokens": len(tokenizer.encode("补充说明")), "chunk_order_index": 1},
        {
            "content": "案例二：已经换了话题，开始分析另一个完全不同的梦境材料。",
            "tokens": len(tokenizer.encode("案例二：已经换了话题，开始分析另一个完全不同的梦境材料。")),
            "chunk_order_index": 2,
        },
    ]

    async def fake_rerank(query: str, documents: list[str], top_n: int | None = None):
        return [
            {"index": 0, "relevance_score": 0.84},
            {"index": 1, "relevance_score": 0.29},
        ]

    merged = await merge_small_adjacent_chunks_by_reranker(
        tokenizer=tokenizer,
        chunks=chunks,
        rerank_model_func=fake_rerank,
        chunk_token_size=100,
        small_chunk_token_size=20,
        rerank_min_score=0.25,
        rerank_score_margin=0.08,
    )

    assert [chunk["content"] for chunk in merged] == [
        "梦境案例一：先讲背景，并说明前因后果与修炼处境。\n\n补充说明",
        "案例二：已经换了话题，开始分析另一个完全不同的梦境材料。",
    ]


@pytest.mark.asyncio
async def test_merge_small_adjacent_chunks_by_reranker_skips_ambiguous_scores():
    tokenizer = make_tokenizer()
    chunks = [
        {
            "content": "上文已经在说明一个较完整的背景与推导过程。",
            "tokens": len(tokenizer.encode("上文已经在说明一个较完整的背景与推导过程。")),
            "chunk_order_index": 0,
        },
        {"content": "承接句", "tokens": len(tokenizer.encode("承接句")), "chunk_order_index": 1},
        {
            "content": "下文则会展开另一个方向的解释，但仍与前文部分相关。",
            "tokens": len(tokenizer.encode("下文则会展开另一个方向的解释，但仍与前文部分相关。")),
            "chunk_order_index": 2,
        },
    ]

    async def fake_rerank(query: str, documents: list[str], top_n: int | None = None):
        return [
            {"index": 0, "relevance_score": 0.61},
            {"index": 1, "relevance_score": 0.58},
        ]

    merged = await merge_small_adjacent_chunks_by_reranker(
        tokenizer=tokenizer,
        chunks=chunks,
        rerank_model_func=fake_rerank,
        chunk_token_size=100,
        small_chunk_token_size=20,
        rerank_min_score=0.25,
        rerank_score_margin=0.08,
    )

    assert [chunk["content"] for chunk in merged] == [
        "上文已经在说明一个较完整的背景与推导过程。",
        "承接句",
        "下文则会展开另一个方向的解释，但仍与前文部分相关。",
    ]
