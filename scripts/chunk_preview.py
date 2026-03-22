#!/usr/bin/env python3

from __future__ import annotations

import argparse
import asyncio
import sys
from io import BytesIO
from pathlib import Path
from typing import Awaitable, Callable

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

load_dotenv(dotenv_path=ROOT_DIR / ".env", override=False)

from lightrag.operate import (
    chunking_by_structure_priority,
    chunking_by_structure_priority_with_reranker,
    chunking_by_token_size,
)
from lightrag.utils import (
    HuggingFaceTokenizer,
    TiktokenTokenizer,
    Tokenizer,
    get_env_value,
)


def _extract_docx(file_bytes: bytes) -> str:
    """Extract DOCX content preserving paragraphs and table order."""
    from docx import Document  # type: ignore
    from docx.table import Table  # type: ignore
    from docx.text.paragraph import Paragraph  # type: ignore

    doc = Document(BytesIO(file_bytes))

    def escape_cell(cell_value: str | None) -> str:
        if cell_value is None:
            return ""
        text = str(cell_value)
        return (
            text.replace("\\", "\\\\")
            .replace("\t", "&emsp;&emsp;")
            .replace("\r\n", "<br>")
            .replace("\r", "<br>")
            .replace("\n", "<br>")
        )

    content_parts: list[str] = []
    in_table = False

    for element in doc.element.body:
        if element.tag.endswith("p"):
            if in_table:
                content_parts.append("")
                in_table = False

            paragraph = Paragraph(element, doc)
            content_parts.append(paragraph.text)
        elif element.tag.endswith("tbl"):
            if content_parts and not in_table:
                content_parts.append("")

            in_table = True
            table = Table(element, doc)
            for row in table.rows:
                row_text = [escape_cell(cell.text) for cell in row.cells]
                if any(cell for cell in row_text):
                    content_parts.append("\t".join(row_text))

    return "\n".join(content_parts)


def load_text(path: Path) -> str:
    suffix = path.suffix.lower()
    file_bytes = path.read_bytes()

    if suffix == ".docx":
        return _extract_docx(file_bytes)

    if suffix in {".txt", ".md", ".markdown", ".rst"}:
        return file_bytes.decode("utf-8")

    raise ValueError(
        f"Unsupported file type: {suffix or '<none>'}. "
        "Supported types: .docx, .txt, .md, .markdown, .rst"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Preview LightRAG chunking output for a local file."
    )
    parser.add_argument("file", type=Path, help="Path to input file")
    parser.add_argument(
        "--mode",
        choices=["structure", "token"],
        default=get_env_value("CHUNK_PREVIEW_MODE", "structure"),
        help="Chunking mode to preview (default: structure)",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=get_env_value("CHUNK_SIZE", 1200, int),
        help="Maximum tokens per chunk (default: 1200)",
    )
    parser.add_argument(
        "--chunk-overlap",
        type=int,
        default=get_env_value("CHUNK_OVERLAP_SIZE", 100, int),
        help="Overlap tokens for token fallback/windowing (default: 100)",
    )
    parser.add_argument(
        "--split-by-character",
        type=str,
        default=None,
        help="Optional explicit split delimiter passed into chunker",
    )
    parser.add_argument(
        "--split-by-character-only",
        action="store_true",
        help="Only split on the provided delimiter and error on oversized chunks",
    )
    parser.add_argument(
        "--model",
        default=get_env_value("TIKTOKEN_MODEL_NAME", "gpt-4o-mini"),
        help="Tokenizer model name for tiktoken (default: gpt-4o-mini)",
    )
    parser.add_argument(
        "--hf-tokenizer-model",
        default=get_env_value("HF_TOKENIZER_MODEL", None),
        help="Optional Hugging Face tokenizer model id or local path; overrides --model for token counting",
    )
    parser.add_argument(
        "--enable-rerank-merge",
        action="store_true",
        default=get_env_value("ENABLE_CHUNK_MERGE_BY_RERANK", False, bool),
        help="Enable reranker-based merge for small adjacent chunks (default: from .env)",
    )
    parser.add_argument(
        "--small-chunk-tokens",
        type=int,
        default=get_env_value("CHUNK_MERGE_SMALL_CHUNK_TOKENS", 100, int),
        help="Maximum token size eligible for reranker-based merge (default: from .env or 100)",
    )
    parser.add_argument(
        "--rerank-min-score",
        type=float,
        default=get_env_value("CHUNK_MERGE_RERANK_MIN_SCORE", 0.25, float),
        help="Minimum rerank score required before merging a small chunk (default: from .env or 0.25)",
    )
    parser.add_argument(
        "--rerank-score-margin",
        type=float,
        default=get_env_value("CHUNK_MERGE_RERANK_SCORE_MARGIN", 0.08, float),
        help="Minimum score gap required to choose left vs right merge (default: from .env or 0.08)",
    )
    parser.add_argument(
        "--debug-rerank-merge",
        action="store_true",
        help="Print reranker merge decisions for small chunks during structure preview",
    )
    parser.add_argument(
        "--debug-chunk-index",
        type=int,
        default=None,
        help="Only print reranker merge debug for the specified original chunk index",
    )
    parser.add_argument(
        "--show-original-index-map",
        action="store_true",
        help="Show which original chunk indices are contained in each final chunk",
    )
    parser.add_argument(
        "--preview-chars",
        type=int,
        default=180,
        help="Characters to show for each chunk preview (default: 180)",
    )
    return parser


def create_rerank_func_from_env() -> Callable[..., Awaitable[list[dict]]] | None:
    binding = get_env_value("RERANK_BINDING", "null")
    if binding == "null":
        return None

    if binding == "cohere":
        from lightrag.rerank import cohere_rerank
    elif binding == "jina":
        from lightrag.rerank import jina_rerank
    elif binding == "aliyun":
        from lightrag.rerank import ali_rerank

    model = get_env_value("RERANK_MODEL", None)
    host = get_env_value("RERANK_BINDING_HOST", None)
    api_key = get_env_value("RERANK_BINDING_API_KEY", None)

    if binding == "cohere":
        async def rerank_func(query: str, documents: list[str], top_n: int | None = None):
            return await cohere_rerank(
                query=query,
                documents=documents,
                top_n=top_n,
                api_key=api_key,
                model=model or "rerank-v3.5",
                base_url=host or "https://api.cohere.com/v2/rerank",
            )

        return rerank_func

    if binding == "jina":
        async def rerank_func(query: str, documents: list[str], top_n: int | None = None):
            return await jina_rerank(
                query=query,
                documents=documents,
                top_n=top_n,
                api_key=api_key,
                model=model or "jina-reranker-v2-base-multilingual",
                base_url=host or "https://api.jina.ai/v1/rerank",
            )

        return rerank_func

    if binding == "aliyun":
        async def rerank_func(query: str, documents: list[str], top_n: int | None = None):
            return await ali_rerank(
                query=query,
                documents=documents,
                top_n=top_n,
                api_key=api_key,
                model=model or "gte-rerank-v2",
                base_url=host
                or "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
            )

        return rerank_func

    raise ValueError(f"Unsupported RERANK_BINDING for chunk preview: {binding}")


async def amain() -> int:
    parser = build_parser()
    args = parser.parse_args()

    path = args.file.expanduser().resolve()
    if not path.is_file():
        parser.error(f"File not found: {path}")

    text = load_text(path)
    tokenizer: Tokenizer = (
        HuggingFaceTokenizer(args.hf_tokenizer_model)
        if args.hf_tokenizer_model
        else TiktokenTokenizer(model_name=args.model)
    )

    debug_records: list[dict] = []

    def debug_callback(record: dict) -> None:
        if (
            args.debug_chunk_index is not None
            and record.get("chunk_order_index") != args.debug_chunk_index
        ):
            return
        debug_records.append(record)

    if args.mode == "structure" and args.enable_rerank_merge:
        rerank_func = create_rerank_func_from_env()
        if rerank_func is None:
            parser.error(
                "ENABLE_CHUNK_MERGE_BY_RERANK is enabled, but RERANK_BINDING is null."
            )
        chunks = await chunking_by_structure_priority_with_reranker(
            tokenizer,
            text,
            args.split_by_character,
            args.split_by_character_only,
            args.chunk_overlap,
            args.chunk_size,
            rerank_model_func=rerank_func,
            small_chunk_token_size=args.small_chunk_tokens,
            rerank_min_score=args.rerank_min_score,
            rerank_score_margin=args.rerank_score_margin,
            debug_callback=debug_callback if args.debug_rerank_merge else None,
        )
    else:
        chunker: Callable[..., list[dict]] = (
            chunking_by_structure_priority
            if args.mode == "structure"
            else chunking_by_token_size
        )
        chunks = chunker(
            tokenizer,
            text,
            args.split_by_character,
            args.split_by_character_only,
            args.chunk_overlap,
            args.chunk_size,
        )

    print(f"file: {path}")
    print(f"mode: {args.mode}")
    print(f"chunk_count: {len(chunks)}")
    print(f"chunk_size: {args.chunk_size}")
    print(f"chunk_overlap: {args.chunk_overlap}")
    print(f"hf_tokenizer_model: {args.hf_tokenizer_model or '<none>'}")
    print(f"rerank_merge_enabled: {args.enable_rerank_merge and args.mode == 'structure'}")
    if args.enable_rerank_merge and args.mode == "structure":
        print(f"small_chunk_tokens: {args.small_chunk_tokens}")
        print(f"rerank_min_score: {args.rerank_min_score}")
        print(f"rerank_score_margin: {args.rerank_score_margin}")
    if args.debug_rerank_merge:
        print(f"debug_rerank_merge: True")
        if args.debug_chunk_index is not None:
            print(f"debug_chunk_index: {args.debug_chunk_index}")
    print()

    if args.debug_rerank_merge and debug_records:
        print("=== rerank_merge_debug ===")
        for record in debug_records:
            print(record)
        print()

    for chunk in chunks:
        content = chunk["content"].replace("\n", "\\n")
        preview = (
            f"{content[: args.preview_chars]}..."
            if len(content) > args.preview_chars
            else content
        )
        print(
            f"[{chunk['chunk_order_index']}] "
            f"tokens={chunk['tokens']} "
            f"chars={len(chunk['content'])}"
        )
        if args.show_original_index_map:
            print(f"original_indices={chunk.get('original_chunk_order_indices', [chunk['chunk_order_index']])}")
        print(preview)
        print()

    return 0


def main() -> int:
    return asyncio.run(amain())


if __name__ == "__main__":
    raise SystemExit(main())
