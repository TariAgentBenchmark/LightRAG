#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from io import BytesIO
from pathlib import Path
from typing import Callable

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from lightrag.operate import chunking_by_structure_priority, chunking_by_token_size
from lightrag.utils import HuggingFaceTokenizer, TiktokenTokenizer, Tokenizer


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
        default="structure",
        help="Chunking mode to preview (default: structure)",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=1200,
        help="Maximum tokens per chunk (default: 1200)",
    )
    parser.add_argument(
        "--chunk-overlap",
        type=int,
        default=100,
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
        default="gpt-4o-mini",
        help="Tokenizer model name for tiktoken (default: gpt-4o-mini)",
    )
    parser.add_argument(
        "--hf-tokenizer-model",
        default=None,
        help="Optional Hugging Face tokenizer model id or local path; overrides --model for token counting",
    )
    parser.add_argument(
        "--preview-chars",
        type=int,
        default=180,
        help="Characters to show for each chunk preview (default: 180)",
    )
    return parser


def main() -> int:
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
        print(preview)
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
