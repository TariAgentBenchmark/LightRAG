"""
Routes for the curated starter-question pool.
"""

from __future__ import annotations

import os
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from lightrag.api.question_pool import QuestionPoolService
from lightrag.api.utils_api import get_combined_auth_dependency


class QuestionPoolItem(BaseModel):
    id: str = Field(description="Stable question id")
    question: str = Field(description="Curated starter question")
    category: str = Field(description="Question category")


class QuestionPoolResponse(BaseModel):
    status: Literal["ok"] = "ok"
    questions: list[QuestionPoolItem]


def create_question_pool_routes(
    api_key: Optional[str] = None,
    working_dir: str | os.PathLike[str] | None = None,
):
    router = APIRouter(prefix="/question-pool", tags=["question-pool"])
    combined_auth = get_combined_auth_dependency(api_key)
    question_pool = QuestionPoolService(working_dir)

    @router.get(
        "",
        response_model=QuestionPoolResponse,
        dependencies=[Depends(combined_auth)],
    )
    async def get_question_pool(
        limit: int = Query(default=6, ge=1, le=50),
    ):
        return QuestionPoolResponse(
            questions=question_pool.list_random_questions(limit=limit)
        )

    return router

