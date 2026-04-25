import type { AppConfig, ChatSession } from '../types/chat'

const CONFIG_STORAGE_KEY = 'LIGHTRAG_CHATUI_CONFIG'
const SESSION_STORAGE_KEY = 'LIGHTRAG_CHATUI_SESSIONS'

const getDefaultBaseUrl = () => {
  if (typeof window === 'undefined') {
    return 'http://121.41.189.137/chat-api/'
  }

  return `${window.location.origin}/chat-api/`
}

export const defaultConfig: AppConfig = {
  baseUrl: getDefaultBaseUrl(),
  apiKey: '',
  bearerToken: '',
  mode: 'mix',
  speechSettings: {}
}

export const loadConfig = (): AppConfig => {
  if (typeof window === 'undefined') {
    return defaultConfig
  }

  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY)
    if (!raw) {
      return defaultConfig
    }

    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return {
      ...defaultConfig,
      apiKey: parsed.apiKey ?? defaultConfig.apiKey,
      bearerToken: parsed.bearerToken ?? defaultConfig.bearerToken,
      mode: parsed.mode ?? defaultConfig.mode,
      baseUrl: defaultConfig.baseUrl,
      speechSettings: {
        ...defaultConfig.speechSettings,
        ...(parsed.speechSettings ?? {})
      }
    }
  } catch {
    return defaultConfig
  }
}

export const saveConfig = (config: AppConfig) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config))
}

export const loadSessions = (): ChatSession[] => {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as ChatSession[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const saveSessions = (sessions: ChatSession[]) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions))
}
