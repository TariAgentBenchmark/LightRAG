"""
Volcengine speech helpers for ASR and TTS.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import json
import os
import uuid
from dataclasses import dataclass
from json import JSONDecodeError
from typing import Any, AsyncIterator, Optional

import aiohttp
import httpx
from fastapi import HTTPException, status

from lightrag.utils import logger

ASR_PROTOCOL_VERSION = 0x1
ASR_HEADER_SIZE = 0x1

ASR_FULL_CLIENT_REQUEST = 0x1
ASR_AUDIO_ONLY_REQUEST = 0x2
ASR_FULL_SERVER_RESPONSE = 0x9
ASR_SERVER_ACK = 0xB
ASR_SERVER_ERROR = 0xF

ASR_NO_SERIALIZATION = 0x0
ASR_JSON_SERIALIZATION = 0x1

ASR_NO_COMPRESSION = 0x0
ASR_GZIP_COMPRESSION = 0x1


@dataclass(slots=True)
class VolcSpeechConfig:
    enabled: bool
    app_id: str
    access_token: str
    asr_resource_id: str
    tts_resource_id: str
    tts_speaker_id: str
    asr_ws_url: str
    asr_model_name: str
    asr_audio_format: str
    asr_audio_codec: str
    asr_sample_rate: int
    asr_bits: int
    asr_channels: int
    asr_language: str
    tts_url: str
    tts_audio_format: str
    tts_sample_rate: int
    tts_speed_ratio: float
    tts_volume_ratio: float
    tts_pitch_ratio: float


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_float(value: str | None, default: float) -> float:
    if value is None:
        return default
    try:
        return float(value.strip())
    except ValueError:
        logger.warning(
            "Invalid float configuration value %r, falling back to %s",
            value,
            default,
        )
        return default


def load_volc_speech_config() -> VolcSpeechConfig:
    return VolcSpeechConfig(
        enabled=_as_bool(os.getenv("VOLC_SPEECH_ENABLED"), default=False),
        app_id=os.getenv("VOLC_SPEECH_APP_ID", "").strip(),
        access_token=os.getenv("VOLC_SPEECH_ACCESS_TOKEN", "").strip(),
        asr_resource_id=os.getenv("VOLC_ASR_RESOURCE_ID", "").strip(),
        tts_resource_id=os.getenv("VOLC_TTS_RESOURCE_ID", "").strip(),
        tts_speaker_id=os.getenv("VOLC_TTS_SPEAKER_ID", "").strip(),
        asr_ws_url=os.getenv(
            "VOLC_ASR_WS_URL",
            "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
        ).strip(),
        asr_model_name=os.getenv("VOLC_ASR_MODEL_NAME", "bigmodel_nostream").strip(),
        asr_audio_format=os.getenv("VOLC_ASR_AUDIO_FORMAT", "pcm").strip(),
        asr_audio_codec=os.getenv("VOLC_ASR_AUDIO_CODEC", "raw").strip(),
        asr_sample_rate=int(os.getenv("VOLC_ASR_SAMPLE_RATE", "16000")),
        asr_bits=int(os.getenv("VOLC_ASR_BITS", "16")),
        asr_channels=int(os.getenv("VOLC_ASR_CHANNELS", "1")),
        asr_language=os.getenv("VOLC_ASR_LANGUAGE", "").strip(),
        tts_url=os.getenv(
            "VOLC_TTS_URL",
            "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
        ).strip(),
        tts_audio_format=os.getenv("VOLC_TTS_AUDIO_FORMAT", "mp3").strip(),
        tts_sample_rate=int(os.getenv("VOLC_TTS_SAMPLE_RATE", "24000")),
        tts_speed_ratio=_as_float(os.getenv("VOLC_TTS_SPEED_RATIO"), 1.0),
        tts_volume_ratio=_as_float(os.getenv("VOLC_TTS_VOLUME_RATIO"), 1.0),
        tts_pitch_ratio=_as_float(os.getenv("VOLC_TTS_PITCH_RATIO"), 1.0),
    )


def ensure_volc_speech_config(
    require_asr: bool = True,
    require_tts: bool = True,
    require_tts_speaker: bool = False,
) -> VolcSpeechConfig:
    config = load_volc_speech_config()
    if not config.enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech integration is disabled. Set VOLC_SPEECH_ENABLED=true.",
        )

    missing: list[str] = []
    if not config.app_id:
        missing.append("VOLC_SPEECH_APP_ID")
    if not config.access_token:
        missing.append("VOLC_SPEECH_ACCESS_TOKEN")
    if require_asr and not config.asr_resource_id:
        missing.append("VOLC_ASR_RESOURCE_ID")
    if require_tts and not config.tts_resource_id:
        missing.append("VOLC_TTS_RESOURCE_ID")
    if require_tts_speaker and not config.tts_speaker_id:
        missing.append("VOLC_TTS_SPEAKER_ID")

    if missing:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Missing speech configuration: {', '.join(missing)}",
        )

    return config


def build_asr_headers(config: VolcSpeechConfig) -> dict[str, str]:
    return {
        "X-Api-App-Key": config.app_id,
        "X-Api-Access-Key": config.access_token,
        "X-Api-Resource-Id": config.asr_resource_id,
        "X-Api-Connect-Id": str(uuid.uuid4()),
    }


def build_tts_headers(config: VolcSpeechConfig) -> dict[str, str]:
    return {
        "X-Api-App-Id": config.app_id,
        "X-Api-Access-Key": config.access_token,
        "X-Api-Resource-Id": config.tts_resource_id,
        "X-Api-Request-Id": str(uuid.uuid4()),
        "Content-Type": "application/json",
        "Accept": "application/json,text/event-stream",
    }


def _generate_header(
    message_type: int,
    message_flags: int,
    serialization: int,
    compression: int,
) -> bytes:
    return bytes(
        [
            (ASR_PROTOCOL_VERSION << 4) | ASR_HEADER_SIZE,
            (message_type << 4) | (message_flags & 0x0F),
            (serialization << 4) | (compression & 0x0F),
            0x00,
        ]
    )


def build_asr_full_request(config: VolcSpeechConfig) -> bytes:
    audio: dict[str, Any] = {
        "format": config.asr_audio_format,
        "codec": config.asr_audio_codec,
        "rate": config.asr_sample_rate,
        "bits": config.asr_bits,
        "channel": config.asr_channels,
    }
    if config.asr_language:
        audio["language"] = config.asr_language

    payload = {
        "user": {"uid": config.app_id},
        "audio": audio,
        "request": {
            "model_name": config.asr_model_name,
            "show_utterances": True,
            "show_words": False,
            "enable_itn": True,
            "enable_punc": True,
        },
    }

    compressed = gzip.compress(json.dumps(payload).encode("utf-8"))
    header = _generate_header(
        ASR_FULL_CLIENT_REQUEST,
        0x0,
        ASR_JSON_SERIALIZATION,
        ASR_GZIP_COMPRESSION,
    )
    return header + len(compressed).to_bytes(4, "big", signed=True) + compressed


def build_asr_audio_request(audio_chunk: bytes, is_last: bool = False) -> bytes:
    compressed = gzip.compress(audio_chunk)
    header = _generate_header(
        ASR_AUDIO_ONLY_REQUEST,
        0x2 if is_last else 0x0,
        ASR_NO_SERIALIZATION,
        ASR_GZIP_COMPRESSION,
    )
    return header + len(compressed).to_bytes(4, "big", signed=True) + compressed


def parse_asr_server_message(packet: bytes) -> dict[str, Any]:
    if len(packet) < 4:
        return {"type": "error", "message": "ASR server returned an invalid packet."}

    header_size = packet[0] & 0x0F
    offset = header_size * 4
    message_type = packet[1] >> 4
    message_flags = packet[1] & 0x0F
    serialization = packet[2] >> 4
    compression = packet[2] & 0x0F

    sequence: Optional[int] = None
    payload = b""

    if message_type == ASR_FULL_SERVER_RESPONSE:
        if message_flags in {0x1, 0x3} and len(packet) >= offset + 8:
            sequence = int.from_bytes(packet[offset : offset + 4], "big", signed=True)
            offset += 4
            payload_size = int.from_bytes(packet[offset : offset + 4], "big", signed=True)
            offset += 4
            payload = packet[offset : offset + max(payload_size, 0)]
        elif len(packet) >= offset + 4:
            payload_size = int.from_bytes(packet[offset : offset + 4], "big", signed=True)
            offset += 4
            payload = packet[offset : offset + max(payload_size, 0)]
    elif message_type == ASR_SERVER_ERROR:
        if len(packet) >= offset + 4:
            error_code = int.from_bytes(packet[offset : offset + 4], "big", signed=True)
            offset += 4
        else:
            error_code = None
        if len(packet) >= offset + 4:
            payload_size = int.from_bytes(packet[offset : offset + 4], "big", signed=True)
            offset += 4
            payload = packet[offset : offset + max(payload_size, 0)]
        else:
            payload_size = None
    elif message_type == ASR_SERVER_ACK:
        if len(packet) >= offset + 4:
            sequence = int.from_bytes(packet[offset : offset + 4], "big", signed=True)
            offset += 4
        if len(packet) >= offset + 4:
            payload_size = int.from_bytes(packet[offset : offset + 4], "big", signed=True)
            offset += 4
            if payload_size > 0:
                payload = packet[offset : offset + payload_size]
    else:
        payload = packet[offset:]

    if compression == ASR_GZIP_COMPRESSION and payload:
        payload = gzip.decompress(payload)

    decoded: dict[str, Any] = {}
    if serialization == ASR_JSON_SERIALIZATION and payload:
        decoded = json.loads(payload.decode("utf-8"))

    return {
        "message_type": message_type,
        "message_flags": message_flags,
        "sequence": sequence,
        "error_code": error_code if message_type == ASR_SERVER_ERROR else None,
        "payload": decoded,
    }


def extract_asr_text(payload: dict[str, Any]) -> tuple[str, bool]:
    results = payload.get("result")
    if isinstance(results, dict):
        first = results
    elif isinstance(results, list) and results:
        first = results[0] if isinstance(results[0], dict) else {}
    else:
        return ("", False)

    text = str(first.get("text") or "").strip()
    utterances = first.get("utterances") or []
    definite = False
    if isinstance(utterances, list):
        definite = any(
            isinstance(utterance, dict) and bool(utterance.get("definite"))
            for utterance in utterances
        )
    return (text, definite)


async def synthesize_tts_audio(
    text: str,
    speaker_id: str,
    audio_format: Optional[str] = None,
    sample_rate: Optional[int] = None,
    speed_ratio: Optional[float] = None,
    volume_ratio: Optional[float] = None,
    pitch_ratio: Optional[float] = None,
) -> tuple[bytes, str]:
    config = ensure_volc_speech_config(
        require_asr=False, require_tts=True, require_tts_speaker=False
    )

    payload = {
        "user": {"uid": config.app_id},
        "req_params": {
            "speaker": speaker_id,
            "text": text,
            "text_type": "plain",
            "audio_params": {
                "format": audio_format or config.tts_audio_format,
                "sample_rate": sample_rate or config.tts_sample_rate,
                "speed_ratio": (
                    speed_ratio if speed_ratio is not None else config.tts_speed_ratio
                ),
                "volume_ratio": (
                    volume_ratio if volume_ratio is not None else config.tts_volume_ratio
                ),
                "pitch_ratio": (
                    pitch_ratio if pitch_ratio is not None else config.tts_pitch_ratio
                ),
            },
        },
    }

    headers = build_tts_headers(config)
    audio_bytes = bytearray()

    timeout = httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", config.tts_url, headers=headers, json=payload) as response:
            if response.status_code >= 400:
                body = await response.aread()
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=(
                        "Volcengine TTS request failed: "
                        f"HTTP {response.status_code} {body.decode('utf-8', errors='ignore')}"
                    ),
                )

            async for event in _iter_tts_events(response):
                code = event.get("code")
                if code not in (None, 0, 3000, 20000000):
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=(
                            "Volcengine TTS returned an error: "
                            f"{event.get('message', 'unknown error')}"
                        ),
                    )

                chunk = event.get("data")
                if isinstance(chunk, str) and chunk:
                    audio_bytes.extend(base64.b64decode(chunk))

                sequence = event.get("sequence")
                if isinstance(sequence, int) and sequence < 0:
                    break

    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Volcengine TTS returned no audio data.",
        )

    fmt = (audio_format or config.tts_audio_format).lower()
    media_type = {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "pcm": "audio/pcm",
        "opus": "audio/ogg",
    }.get(fmt, "application/octet-stream")
    return (bytes(audio_bytes), media_type)


async def _iter_tts_events(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    buffer = ""
    decoder = json.JSONDecoder()

    async for chunk in response.aiter_text():
        buffer += chunk

        while True:
            stripped = buffer.lstrip()
            if not stripped:
                buffer = ""
                break

            if stripped.startswith("data:"):
                boundary = stripped.find("\n\n")
                if boundary == -1:
                    buffer = stripped
                    break
                raw_event = stripped[:boundary]
                buffer = stripped[boundary + 2 :]
                lines = [
                    line[5:].strip()
                    for line in raw_event.splitlines()
                    if line.startswith("data:")
                ]
                payload = "".join(lines).strip()
                if payload and payload != "[DONE]":
                    yield json.loads(payload)
                continue

            try:
                parsed, index = decoder.raw_decode(stripped)
            except JSONDecodeError:
                buffer = stripped
                break

            yield parsed
            buffer = stripped[index:]


async def bridge_asr_session(
    websocket,
    on_client_json,
) -> None:
    config = ensure_volc_speech_config(
        require_asr=True, require_tts=False, require_tts_speaker=False
    )
    headers = build_asr_headers(config)

    upstream_timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=None)
    session = aiohttp.ClientSession(timeout=upstream_timeout)
    try:
        async with session.ws_connect(
            config.asr_ws_url,
            headers=headers,
            autoping=True,
            heartbeat=30,
            max_msg_size=0,
        ) as upstream:
            await upstream.send_bytes(build_asr_full_request(config))
            await websocket.send_json({"type": "ready"})

            finish_event = asyncio.Event()
            error_event = asyncio.Event()
            pending_audio_chunk: bytes | None = None

            async def client_to_upstream() -> None:
                nonlocal pending_audio_chunk
                try:
                    while True:
                        message = await websocket.receive()
                        message_type = message.get("type")

                        if message_type == "websocket.receive":
                            if message.get("bytes") is not None:
                                audio_chunk = bytes(message["bytes"])
                                if pending_audio_chunk is not None:
                                    await upstream.send_bytes(
                                        build_asr_audio_request(pending_audio_chunk)
                                    )
                                pending_audio_chunk = audio_chunk
                                continue

                            text_data = message.get("text")
                            if not text_data:
                                continue

                            parsed = json.loads(text_data)
                            await on_client_json(parsed)
                            if parsed.get("type") == "end":
                                if pending_audio_chunk is not None:
                                    await upstream.send_bytes(
                                        build_asr_audio_request(
                                            pending_audio_chunk, is_last=True
                                        )
                                    )
                                    pending_audio_chunk = None
                                finish_event.set()
                                return

                        if message_type in {"websocket.disconnect", "websocket.close"}:
                            if pending_audio_chunk is not None:
                                await upstream.send_bytes(
                                    build_asr_audio_request(
                                        pending_audio_chunk, is_last=True
                                    )
                                )
                                pending_audio_chunk = None
                            finish_event.set()
                            return
                except Exception as exc:  # noqa: BLE001
                    logger.exception("ASR client->upstream bridge failed: %s", exc)
                    error_event.set()
                    finish_event.set()

            async def upstream_to_client() -> None:
                try:
                    while True:
                        message = await upstream.receive()

                        if message.type == aiohttp.WSMsgType.BINARY:
                            parsed = parse_asr_server_message(message.data)
                            payload = parsed.get("payload") or {}
                            text, definite = extract_asr_text(payload)
                            is_final = bool(
                                definite or ((parsed.get("message_flags", 0) & 0x2) != 0)
                            )

                            if text:
                                await websocket.send_json(
                                    {
                                        "type": "transcript",
                                        "text": text,
                                        "is_final": is_final,
                                        "payload": payload,
                                    }
                                )

                            if is_final:
                                return

                        elif message.type == aiohttp.WSMsgType.ERROR:
                            raise message.data
                        elif message.type in {
                            aiohttp.WSMsgType.CLOSE,
                            aiohttp.WSMsgType.CLOSED,
                            aiohttp.WSMsgType.CLOSING,
                        }:
                            return
                except Exception as exc:  # noqa: BLE001
                    logger.exception("ASR upstream->client bridge failed: %s", exc)
                    if websocket.client_state.name == "CONNECTED":
                        await websocket.send_json(
                            {
                                "type": "error",
                                "message": f"Volcengine ASR bridge failed: {exc}",
                            }
                        )
                    error_event.set()
                    finish_event.set()

            client_task = asyncio.create_task(client_to_upstream())
            upstream_task = asyncio.create_task(upstream_to_client())

            try:
                await client_task
                if error_event.is_set():
                    upstream_task.cancel()
                    await asyncio.gather(upstream_task, return_exceptions=True)
                else:
                    await asyncio.wait_for(upstream_task, timeout=30)
            finally:
                if not client_task.done():
                    client_task.cancel()
                if not upstream_task.done():
                    upstream_task.cancel()
                await asyncio.gather(client_task, upstream_task, return_exceptions=True)

            if error_event.is_set():
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Volcengine ASR bridge failed.",
                )
    finally:
        await session.close()
