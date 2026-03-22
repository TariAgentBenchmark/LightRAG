import pytest

from lightrag.operate import chunking_by_structure_priority
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
