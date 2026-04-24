"""
Routes for storing and loading shared chat conversations.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from lightrag.api.utils_api import get_combined_auth_dependency

router = APIRouter(prefix="/shares", tags=["share"])

_SHARE_ID_BYTES = 9
_MAX_SHARE_BYTES = 1024 * 1024


class SharedReference(BaseModel):
    reference_id: str = Field(min_length=1, max_length=64)
    file_path: str = Field(min_length=1, max_length=1024)
    content: list[str] = Field(default_factory=list)
    entity_terms: list[str] = Field(default_factory=list)


class SharedMessage(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)
    createdAt: int
    references: list[SharedReference] = Field(default_factory=list)


class SharePayload(BaseModel):
    title: Optional[str] = Field(default=None, max_length=120)
    messages: list[SharedMessage] = Field(min_length=1, max_length=80)
    createdAt: int


class ShareCreateRequest(BaseModel):
    payload: SharePayload


class ShareCreateResponse(BaseModel):
    status: Literal["ok"] = "ok"
    share_id: str
    created_at: int


class ShareGetResponse(BaseModel):
    status: Literal["ok"] = "ok"
    share_id: str
    created_at: int
    payload: SharePayload


def _resolve_share_dir(working_dir: str | os.PathLike[str] | None = None) -> Path:
    configured_dir = os.getenv("LIGHTRAG_SHARE_DIR", "").strip()
    if configured_dir:
        return Path(configured_dir)

    base_dir = Path(working_dir or os.getenv("WORKING_DIR", "./rag_storage"))
    return base_dir / "shares"


def _validate_share_id(share_id: str) -> str:
    if not share_id or len(share_id) > 64:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Share not found",
        )

    if not all(char.isalnum() or char in {"-", "_"} for char in share_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Share not found",
        )

    return share_id


def _create_share_id(share_dir: Path) -> str:
    for _ in range(8):
        share_id = secrets.token_urlsafe(_SHARE_ID_BYTES)
        if not (share_dir / f"{share_id}.json").exists():
            return share_id

    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="Failed to create share link",
    )


def _dump_share_record(record: dict) -> str:
    encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _MAX_SHARE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Share content is too large",
        )
    return encoded


def create_share_routes(
    api_key: Optional[str] = None,
    working_dir: str | os.PathLike[str] | None = None,
):
    combined_auth = get_combined_auth_dependency(api_key)
    share_dir = _resolve_share_dir(working_dir)

    @router.post(
        "",
        response_model=ShareCreateResponse,
        dependencies=[Depends(combined_auth)],
    )
    async def create_share(request: ShareCreateRequest):
        share_dir.mkdir(parents=True, exist_ok=True)
        share_id = _create_share_id(share_dir)
        created_at = int(time.time() * 1000)
        record = {
            "share_id": share_id,
            "created_at": created_at,
            "payload": request.payload.model_dump(mode="json"),
        }
        encoded = _dump_share_record(record)
        target = share_dir / f"{share_id}.json"
        temp = share_dir / f".{share_id}.tmp"

        temp.write_text(encoded, encoding="utf-8")
        temp.replace(target)

        return ShareCreateResponse(share_id=share_id, created_at=created_at)

    @router.get("/{share_id}", response_model=ShareGetResponse)
    async def get_share(share_id: str):
        safe_share_id = _validate_share_id(share_id)
        target = share_dir / f"{safe_share_id}.json"
        if not target.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Share not found",
            )

        try:
            record = json.loads(target.read_text(encoding="utf-8"))
            payload = SharePayload.model_validate(record["payload"])
            return ShareGetResponse(
                share_id=safe_share_id,
                created_at=int(record.get("created_at", 0)),
                payload=payload,
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Share content is corrupted",
            ) from exc

    return router
