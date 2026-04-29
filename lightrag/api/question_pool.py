"""
Curated starter-question pool for the lightweight chat UI.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from lightrag.utils import logger


QUESTION_POOL_SCREENING_SYSTEM_PROMPT = """你是一个面向道教知识问答产品的首页问题池审核器。

任务：判断候选问题是否适合作为首页随机推荐问题。你不回答问题，只做筛选和规范化。

保留标准：
1. 问题必须能脱离上下文独立成立。
2. 问题要适合新用户点击，表达自然、简洁、有启发性。
3. 问题应贴合道教、经典、修持、概念辨析、身心实践或相关思想理解。
4. 问题应大概率能被资料库严谨回答，而不是纯个人隐私、闲聊、操作反馈或技术问题。
5. 如原问题有价值但表述口语化，可以改写为一个自然、通用、完整的问题。

剔除标准：
1. 依赖上下文的问题，例如“这个是什么意思”“继续讲”“上面那个再展开”。
2. 含具体个人隐私、联系方式、账号、地址、真实姓名等信息的问题。
3. 投诉、调试、页面操作、费用咨询、技术实现、产品反馈等非道教问答内容。
4. 过宽泛、过短、过长、含混不清或不适合首页展示的问题。
5. 会诱导无依据修法步骤、医疗承诺、占卜断事或危险建议的问题。

只输出合法 JSON，不要输出 Markdown，不要解释。格式：
{
  "items": [
    {
      "id": "候选id",
      "keep": true,
      "normalized_question": "规范化后的问题",
      "category": "概念辨析",
      "quality_score": 88,
      "reason": "简短原因"
    }
  ]
}
"""

_DEFAULT_POOL_FILE = "question_pool.json"
_MAX_POOL_ITEMS = int(os.getenv("LIGHTRAG_QUESTION_POOL_MAX_ITEMS", "1000"))
_MIN_QUALITY_SCORE = int(os.getenv("LIGHTRAG_QUESTION_POOL_MIN_SCORE", "70"))
_MAX_CANDIDATES_PER_ANSWER = int(
    os.getenv("LIGHTRAG_QUESTION_POOL_MAX_CANDIDATES_PER_ANSWER", "4")
)
_QUESTION_MIN_CHARS = int(os.getenv("LIGHTRAG_QUESTION_POOL_MIN_CHARS", "4"))
_QUESTION_MAX_CHARS = int(os.getenv("LIGHTRAG_QUESTION_POOL_MAX_CHARS", "80"))
_DISPLAY_CATEGORY_SOFT_LIMIT = int(
    os.getenv("LIGHTRAG_QUESTION_POOL_DISPLAY_CATEGORY_LIMIT", "2")
)
_DISPLAY_SIMILARITY_THRESHOLD = float(
    os.getenv("LIGHTRAG_QUESTION_POOL_DISPLAY_SIMILARITY_THRESHOLD", "0.72")
)

_FOLLOWUP_HEADER_RE = re.compile(
    r"^\s{0,3}#{1,6}\s*(?:延伸追问|follow[-\s]*up questions?)\s*$",
    re.IGNORECASE,
)
_STOP_SECTION_RE = re.compile(
    r"^\s{0,3}#{1,6}\s*(?:references?|参考资料|引用文献)\s*$",
    re.IGNORECASE,
)
_ANY_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+\S+")
_BULLET_RE = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)、．]\s*)")
_MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_INLINE_CITATION_RE = re.compile(r"\[(?:\^?\d+(?:\s*,\s*\d+)*)\]")
_THINK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_WHITESPACE_RE = re.compile(r"\s+")
_QUESTION_HINT_RE = re.compile(
    r"[？?]|什么|为何|为什么|如何|怎么|怎样|是否|能否|是不是|哪[些个]|区别|关系|意义|含义|理解|解释|讲什么|是什么"
)
_CONTEXT_DEPENDENT_RE = re.compile(
    r"^(?:这个|那个|上面|前面|刚才|继续|再讲|展开|详细说|这段|这些|那些|它|他说|其)"
)
_PRIVATE_RE = re.compile(
    r"(?:\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+\.\w+|微信|手机号|电话|地址|身份证|银行卡|账号|密码)"
)
_QUESTION_SEMANTIC_FILLER_RE = re.compile(
    r"(?:"
    r"什么是|是什么|什么叫|如何理解|怎么理解|怎样理解|为什么|为何|"
    r"有何|有什么|能否|是否|是不是|哪些|哪种|请问|请|"
    r"的含义|的意义|含义|意义|关系|区别|体现|应该|可以|"
    r"在修行中|在修炼中|修行中|修炼中|修持中|"
    r"对修行|对修炼|意味着什么|指什么|怎么体现|如何体现|"
    r"[的了呢啊吗么]|[？?]"
    r")"
)


@dataclass(frozen=True)
class QuestionCandidate:
    id: str
    question: str
    source: str


@dataclass(frozen=True)
class AcceptedQuestion:
    question: str
    category: str
    quality_score: int
    source: str
    reason: str


def _resolve_pool_file(working_dir: str | os.PathLike[str] | None = None) -> Path:
    configured_file = os.getenv("LIGHTRAG_QUESTION_POOL_FILE", "").strip()
    if configured_file:
        return Path(configured_file)

    base_dir = Path(working_dir or os.getenv("WORKING_DIR", "./rag_storage"))
    return base_dir / _DEFAULT_POOL_FILE


def _now_ms() -> int:
    return int(time.time() * 1000)


def _stable_id(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _dedupe_key(text: str) -> str:
    normalized = re.sub(r"[^\w\u4e00-\u9fff]+", "", text.lower())
    return normalized[:120]


def _semantic_key(text: str) -> str:
    key = _dedupe_key(text)
    semantic_key = _QUESTION_SEMANTIC_FILLER_RE.sub("", key)
    return semantic_key or key


def _bigrams(text: str) -> set[str]:
    if len(text) < 2:
        return {text} if text else set()
    return {text[index : index + 2] for index in range(len(text) - 1)}


def _question_similarity(left: str, right: str) -> float:
    left_key = _semantic_key(left)
    right_key = _semantic_key(right)
    if not left_key or not right_key:
        return 0.0
    if left_key == right_key:
        return 1.0

    left_bigrams = _bigrams(left_key)
    right_bigrams = _bigrams(right_key)
    bigram_union = left_bigrams | right_bigrams
    bigram_score = (
        len(left_bigrams & right_bigrams) / len(bigram_union)
        if bigram_union
        else 0.0
    )

    left_chars = set(left_key)
    right_chars = set(right_key)
    overlap_score = (
        len(left_chars & right_chars) / min(len(left_chars), len(right_chars))
        if left_chars and right_chars and min(len(left_chars), len(right_chars)) >= 4
        else 0.0
    )
    return max(bigram_score, overlap_score)


def _clean_question(raw: str) -> str:
    text = _THINK_RE.sub("", raw)
    text = _MARKDOWN_LINK_RE.sub(r"\1", text)
    text = _INLINE_CITATION_RE.sub("", text)
    text = _BULLET_RE.sub("", text)
    text = text.strip().strip("\"'“”‘’`")
    text = _WHITESPACE_RE.sub(" ", text).strip()
    return text


def _passes_rule_prefilter(question: str) -> bool:
    if len(question) < _QUESTION_MIN_CHARS or len(question) > _QUESTION_MAX_CHARS:
        return False
    if _PRIVATE_RE.search(question):
        return False
    if _CONTEXT_DEPENDENT_RE.search(question):
        return False
    return bool(_QUESTION_HINT_RE.search(question))


def extract_followup_questions(answer: str) -> list[str]:
    questions: list[str] = []
    in_followups = False

    for raw_line in answer.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        if _FOLLOWUP_HEADER_RE.match(line):
            in_followups = True
            continue

        if in_followups and (_STOP_SECTION_RE.match(line) or _ANY_HEADING_RE.match(line)):
            break

        if not in_followups:
            continue

        question = _clean_question(line)
        if question and _passes_rule_prefilter(question):
            questions.append(question)

    return questions


def build_question_candidates(user_question: str, answer: str) -> list[QuestionCandidate]:
    raw_candidates: list[tuple[str, str]] = [("user_question", user_question)]
    raw_candidates.extend(
        ("followup", question) for question in extract_followup_questions(answer)
    )

    candidates: list[QuestionCandidate] = []
    seen: set[str] = set()

    for source, raw_question in raw_candidates:
        question = _clean_question(raw_question)
        if not question or not _passes_rule_prefilter(question):
            continue

        key = _dedupe_key(question)
        if not key or key in seen:
            continue

        seen.add(key)
        candidates.append(
            QuestionCandidate(
                id=f"candidate-{len(candidates) + 1}",
                question=question,
                source=source,
            )
        )

        if len(candidates) >= _MAX_CANDIDATES_PER_ANSWER:
            break

    return candidates


def _parse_json_object(text: str) -> dict[str, Any]:
    cleaned = _THINK_RE.sub("", text).strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()

    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return {}
        try:
            parsed = json.loads(cleaned[start : end + 1])
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}


def _coerce_quality_score(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return max(0, min(100, int(value)))
    if isinstance(value, str) and value.strip().isdigit():
        return max(0, min(100, int(value.strip())))
    return 0


def _accepted_from_llm_result(
    candidates: Iterable[QuestionCandidate], raw_response: str
) -> list[AcceptedQuestion]:
    candidate_by_id = {candidate.id: candidate for candidate in candidates}
    payload = _parse_json_object(raw_response)
    items = payload.get("items")
    if not isinstance(items, list):
        return []

    accepted: list[AcceptedQuestion] = []
    seen: set[str] = set()

    for item in items:
        if not isinstance(item, dict):
            continue

        candidate_id = str(item.get("id", "")).strip()
        candidate = candidate_by_id.get(candidate_id)
        if not candidate or item.get("keep") is not True:
            continue

        question = _clean_question(
            str(item.get("normalized_question") or candidate.question)
        )
        quality_score = _coerce_quality_score(item.get("quality_score"))
        if quality_score < _MIN_QUALITY_SCORE or not _passes_rule_prefilter(question):
            continue

        key = _dedupe_key(question)
        if not key or key in seen:
            continue
        seen.add(key)

        category = str(item.get("category") or "推荐问题").strip()[:24]
        reason = str(item.get("reason") or "").strip()[:120]
        accepted.append(
            AcceptedQuestion(
                question=question,
                category=category or "推荐问题",
                quality_score=quality_score,
                source=candidate.source,
                reason=reason,
            )
        )

    return accepted


def _load_pool(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "items": {}}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("items"), dict):
            return data
    except Exception as exc:
        logger.warning("Failed to read question pool %s: %s", path, exc)

    return {"version": 1, "items": {}}


def _write_pool(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f"{path.suffix}.tmp")
    temp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    temp.replace(path)


def _select_diverse_questions(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    category_counts: dict[str, int] = {}

    def can_add(item: dict[str, Any], enforce_category_limit: bool) -> bool:
        question = str(item.get("question", ""))
        category = str(item.get("category", "推荐问题"))

        if (
            enforce_category_limit
            and category_counts.get(category, 0) >= _DISPLAY_CATEGORY_SOFT_LIMIT
        ):
            return False

        return all(
            _question_similarity(question, str(selected_item.get("question", "")))
            < _DISPLAY_SIMILARITY_THRESHOLD
            for selected_item in selected
        )

    for enforce_category_limit in (True, False):
        for item in items:
            if len(selected) >= limit:
                return selected
            if item in selected or not can_add(item, enforce_category_limit):
                continue

            selected.append(item)
            category = str(item.get("category", "推荐问题"))
            category_counts[category] = category_counts.get(category, 0) + 1

    return selected


class QuestionPoolService:
    def __init__(self, working_dir: str | os.PathLike[str] | None = None):
        self.path = _resolve_pool_file(working_dir)
        self.lock_path = self.path.with_suffix(f"{self.path.suffix}.lock")

    def _with_lock(self, exclusive: bool, callback: Callable[[], Any]) -> Any:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+", encoding="utf-8") as lock_file:
            try:
                import fcntl

                fcntl.flock(
                    lock_file.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
                )
                try:
                    return callback()
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except ImportError:
                return callback()

    def list_random_questions(self, limit: int = 6) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 50))

        def read_questions() -> list[dict[str, Any]]:
            data = _load_pool(self.path)
            items = [
                item
                for item in data.get("items", {}).values()
                if isinstance(item, dict)
                and isinstance(item.get("question"), str)
                and int(item.get("quality_score", 0)) >= _MIN_QUALITY_SCORE
            ]
            random.shuffle(items)
            selected_items = _select_diverse_questions(items, safe_limit)
            return [
                {
                    "id": str(item.get("id", "")),
                    "question": item["question"],
                    "category": str(item.get("category", "推荐问题")),
                }
                for item in selected_items
            ]

        return self._with_lock(False, read_questions)

    def upsert_questions(self, questions: list[AcceptedQuestion]) -> int:
        if not questions:
            return 0

        now = _now_ms()

        def update_pool() -> int:
            data = _load_pool(self.path)
            items = data.setdefault("items", {})
            changed = 0

            for question in questions:
                key = _dedupe_key(question.question)
                if not key:
                    continue

                item_id = _stable_id(key)
                existing = items.get(item_id, {})
                count = int(existing.get("count", 0)) + 1
                current_score = int(existing.get("quality_score", 0))
                items[item_id] = {
                    "id": item_id,
                    "question": question.question,
                    "category": question.category,
                    "quality_score": max(current_score, question.quality_score),
                    "source": question.source,
                    "reason": question.reason,
                    "count": count,
                    "created_at": int(existing.get("created_at", now)),
                    "updated_at": now,
                }
                changed += 1

            if len(items) > _MAX_POOL_ITEMS:
                sorted_items = sorted(
                    items.values(),
                    key=lambda item: (
                        int(item.get("quality_score", 0)),
                        int(item.get("count", 0)),
                        int(item.get("updated_at", 0)),
                    ),
                    reverse=True,
                )
                data["items"] = {
                    str(item["id"]): item for item in sorted_items[:_MAX_POOL_ITEMS]
                }

            _write_pool(self.path, data)
            return changed

        return self._with_lock(True, update_pool)

    async def screen_and_store(
        self,
        user_question: str,
        answer: str,
        llm_func: Callable[..., Any],
    ) -> None:
        candidates = build_question_candidates(user_question, answer)
        if not candidates:
            return

        prompt = json.dumps(
            {
                "candidates": [
                    {
                        "id": candidate.id,
                        "source": candidate.source,
                        "question": candidate.question,
                    }
                    for candidate in candidates
                ]
            },
            ensure_ascii=False,
        )

        try:
            response = await llm_func(
                prompt,
                system_prompt=QUESTION_POOL_SCREENING_SYSTEM_PROMPT,
                history_messages=[],
                enable_cot=False,
                stream=False,
                _priority=1,
            )
            if not isinstance(response, str):
                return

            accepted = _accepted_from_llm_result(candidates, response)
            inserted = self.upsert_questions(accepted)
            if inserted:
                logger.info("Question pool accepted %s new/updated questions", inserted)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Question pool screening failed: %s", exc)
