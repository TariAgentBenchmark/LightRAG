export type QueryMode = 'naive' | 'local' | 'global' | 'hybrid' | 'mix' | 'bypass'

export type ReferenceItem = {
  reference_id: string
  file_path: string
  content?: string[]
  entity_terms?: string[]
}

export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  references?: ReferenceItem[]
  isStreaming?: boolean
  error?: string
}

export type ChatSession = {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
}

export type SpeechSettings = {
  speakerId?: string
  speedRatio?: number
  volumeRatio?: number
  pitchRatio?: number
}

export type AppConfig = {
  baseUrl: string
  apiKey: string
  bearerToken: string
  mode: QueryMode
  speechSettings: SpeechSettings
}

export type SpeechProviderConfig = {
  provider: 'volcengine'
  enabled: boolean
  configured: boolean
  app_id_present: boolean
  access_token_present: boolean
  asr_resource_id?: string | null
  tts_resource_id?: string | null
  tts_speaker_id?: string | null
  asr_audio_format: string
  asr_sample_rate: number
  asr_channels: number
  tts_audio_format: string
  tts_sample_rate: number
  tts_speed_ratio: number
  tts_volume_ratio: number
  tts_pitch_ratio: number
}

export type SpeechStatusResponse = {
  status: 'ok'
  provider: SpeechProviderConfig
}

export type SpeechVoiceOption = {
  category: string
  name: string
  speaker_id: string
  language: string
  gender: 'female' | 'male' | 'unknown'
  recommended: boolean
}

export type SpeechVoicesResponse = {
  status: 'ok'
  voices: SpeechVoiceOption[]
  default_speaker_id?: string | null
  source: string
}

export type SharePayload = {
  title?: string
  messages?: ChatMessage[]
  createdAt: number
  question?: string
  answer?: string
  references?: ReferenceItem[]
}

export type ShareCreateResponse = {
  status: 'ok'
  share_id: string
  created_at: number
}

export type ShareGetResponse = {
  status: 'ok'
  share_id: string
  created_at: number
  payload: SharePayload
}

export type QuestionPoolItem = {
  id: string
  question: string
  category: string
}

export type QuestionPoolResponse = {
  status: 'ok'
  questions: QuestionPoolItem[]
}

export type StreamEvent =
  | { type: 'references'; references: ReferenceItem[] }
  | { type: 'response'; chunk: string }
  | { type: 'response_final'; content: string; references?: ReferenceItem[] }
  | { type: 'error'; error: string }

export type QueryRequest = {
  query: string
  mode: QueryMode
  stream: boolean
  include_references: boolean
  include_chunk_content: boolean
  conversation_history: Array<{ role: 'user' | 'assistant'; content: string }>
  use_conversation_history?: boolean
}
