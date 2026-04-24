"""
Speech-related routes for external ASR/TTS providers.
"""

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, WebSocket, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from lightrag.api.auth import auth_handler
from lightrag.api.utils_api import get_combined_auth_dependency
from lightrag.api.volc_speech import (
    bridge_asr_session,
    ensure_volc_speech_config,
    get_tts_media_type,
    load_volc_speech_config,
    stream_tts_audio,
    synthesize_tts_audio,
)
from lightrag.api.volc_tts_voices import (
    VOLCENGINE_TTS_VOICE_SOURCE,
    VOLCENGINE_TTS_VOICES,
)

router = APIRouter(prefix="/speech", tags=["speech"])


class SpeechProviderConfig(BaseModel):
    provider: Literal["volcengine"] = "volcengine"
    enabled: bool
    configured: bool
    app_id_present: bool
    access_token_present: bool
    asr_resource_id: Optional[str] = None
    tts_resource_id: Optional[str] = None
    tts_speaker_id: Optional[str] = None
    asr_audio_format: str = "pcm"
    asr_sample_rate: int = 16000
    asr_channels: int = 1
    tts_audio_format: str = "mp3"
    tts_sample_rate: int = 24000
    tts_speed_ratio: float = 1.0
    tts_volume_ratio: float = 1.0
    tts_pitch_ratio: float = 1.0


class SpeechStatusResponse(BaseModel):
    status: Literal["ok"] = "ok"
    provider: SpeechProviderConfig


class SpeechVoice(BaseModel):
    category: str
    name: str
    speaker_id: str
    language: str
    gender: Literal["female", "male", "unknown"] = "unknown"
    recommended: bool = False


class SpeechVoicesResponse(BaseModel):
    status: Literal["ok"] = "ok"
    voices: list[SpeechVoice]
    default_speaker_id: Optional[str] = None
    source: str


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, description="Text to synthesize")
    speaker_id: Optional[str] = Field(
        default=None, description="Optional override speaker_id for synthesis"
    )
    audio_format: Optional[str] = Field(
        default=None, description="Optional override output format, e.g. mp3 or pcm"
    )
    sample_rate: Optional[int] = Field(
        default=None, description="Optional override output sample rate"
    )
    speed_ratio: Optional[float] = Field(
        default=None, description="Optional override speech speed ratio"
    )
    volume_ratio: Optional[float] = Field(
        default=None, description="Optional override speech volume ratio"
    )
    pitch_ratio: Optional[float] = Field(
        default=None, description="Optional override speech pitch ratio"
    )


def _get_provider_config() -> SpeechProviderConfig:
    config = load_volc_speech_config()
    configured = all(
        [
            config.app_id,
            config.access_token,
            config.asr_resource_id,
            config.tts_resource_id,
        ]
    )

    return SpeechProviderConfig(
        enabled=config.enabled,
        configured=configured,
        app_id_present=bool(config.app_id),
        access_token_present=bool(config.access_token),
        asr_resource_id=config.asr_resource_id or None,
        tts_resource_id=config.tts_resource_id or None,
        tts_speaker_id=config.tts_speaker_id or None,
        asr_audio_format=config.asr_audio_format,
        asr_sample_rate=config.asr_sample_rate,
        asr_channels=config.asr_channels,
        tts_audio_format=config.tts_audio_format,
        tts_sample_rate=config.tts_sample_rate,
        tts_speed_ratio=config.tts_speed_ratio,
        tts_volume_ratio=config.tts_volume_ratio,
        tts_pitch_ratio=config.tts_pitch_ratio,
    )


async def _authorize_websocket(
    websocket: WebSocket, api_key: Optional[str] = None
) -> bool:
    query_api_key = websocket.query_params.get("api_key")
    query_token = websocket.query_params.get("token")
    auth_configured = bool(auth_handler.accounts)
    api_key_configured = bool(api_key)

    if not auth_configured and not api_key_configured:
        return True

    if api_key and query_api_key == api_key:
        return True

    if not query_token:
        return False

    try:
        token_info = auth_handler.validate_token(query_token)
    except HTTPException:
        return False

    if not auth_configured and token_info.get("role") == "guest":
        return True
    if auth_configured and token_info.get("role") != "guest":
        return True
    return False


def create_speech_routes(api_key: Optional[str] = None):
    combined_auth = get_combined_auth_dependency(api_key)

    @router.get(
        "/status",
        response_model=SpeechStatusResponse,
        dependencies=[Depends(combined_auth)],
    )
    async def get_speech_status():
        """Return speech provider configuration status without exposing secrets."""
        return SpeechStatusResponse(provider=_get_provider_config())

    @router.get(
        "/voices",
        response_model=SpeechVoicesResponse,
        dependencies=[Depends(combined_auth)],
    )
    async def list_speech_voices():
        config = ensure_volc_speech_config(
            require_asr=False, require_tts=True, require_tts_speaker=False
        )
        return SpeechVoicesResponse(
            voices=[SpeechVoice(**voice) for voice in VOLCENGINE_TTS_VOICES],
            default_speaker_id=config.tts_speaker_id or None,
            source=VOLCENGINE_TTS_VOICE_SOURCE,
        )

    @router.post(
        "/tts",
        dependencies=[Depends(combined_auth)],
    )
    async def synthesize_speech(request: TTSRequest):
        config = ensure_volc_speech_config(
            require_asr=False, require_tts=True, require_tts_speaker=False
        )
        speaker_id = request.speaker_id or config.tts_speaker_id
        if not speaker_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "TTS speaker is not configured. Set VOLC_TTS_SPEAKER_ID "
                    "or provide speaker_id in the request."
                ),
            )

        audio, media_type = await synthesize_tts_audio(
            text=request.text,
            speaker_id=speaker_id,
            audio_format=request.audio_format,
            sample_rate=request.sample_rate,
            speed_ratio=request.speed_ratio,
            volume_ratio=request.volume_ratio,
            pitch_ratio=request.pitch_ratio,
        )
        return Response(content=audio, media_type=media_type)

    @router.post(
        "/tts/stream",
        dependencies=[Depends(combined_auth)],
    )
    async def stream_speech(request: TTSRequest):
        config = ensure_volc_speech_config(
            require_asr=False, require_tts=True, require_tts_speaker=False
        )
        speaker_id = request.speaker_id or config.tts_speaker_id
        if not speaker_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "TTS speaker is not configured. Set VOLC_TTS_SPEAKER_ID "
                    "or provide speaker_id in the request."
                ),
            )

        return StreamingResponse(
            stream_tts_audio(
                text=request.text,
                speaker_id=speaker_id,
                audio_format=request.audio_format,
                sample_rate=request.sample_rate,
                speed_ratio=request.speed_ratio,
                volume_ratio=request.volume_ratio,
                pitch_ratio=request.pitch_ratio,
            ),
            media_type=get_tts_media_type(config, request.audio_format),
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @router.websocket("/asr/stream")
    async def stream_asr(websocket: WebSocket):
        is_authorized = await _authorize_websocket(websocket, api_key=api_key)
        if not is_authorized:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        await websocket.accept()

        try:
            async def _ignore_client_json(_: dict) -> None:
                return

            await bridge_asr_session(websocket, on_client_json=_ignore_client_json)
        except HTTPException as exc:
            await websocket.send_json({"type": "error", "message": exc.detail})
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)

    return router
