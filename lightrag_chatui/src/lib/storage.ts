import type { AppConfig, ChatSession } from '../types/chat'

const CONFIG_STORAGE_KEY = 'LIGHTRAG_CHATUI_CONFIG'
const SESSION_STORAGE_KEY = 'LIGHTRAG_CHATUI_SESSIONS'

export const defaultConfig: AppConfig = {
  baseUrl: 'http://localhost:9621',
  apiKey: '',
  bearerToken: '',
  mode: 'mix',
  topK: 12,
  historyTurns: 4
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
      ...parsed
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
