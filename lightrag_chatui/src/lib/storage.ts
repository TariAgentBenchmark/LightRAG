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

// 引用全文是可按需重新加载的缓存数据，不落盘。
// 手机浏览器（微信/WKWebView、Safari）的 localStorage 只有 ~5MB，
// 历史会话若连引用全文一起存，长期使用必然撞上限：
// setItem 报 QuotaExceededError → useEffect 内未捕获 → React 卸载整棵树 → 页面白屏、提问无结果。
const toPersistableSession = (session: ChatSession): ChatSession => ({
  ...session,
  messages: session.messages.map((message) => {
    if (!message.references || message.references.length === 0) {
      return message
    }

    let changed = false
    const references = message.references.map((reference) => {
      if (reference.content && reference.content.length > 0) {
        changed = true
        return { ...reference, content: [] }
      }
      return reference
    })

    return changed ? { ...message, references } : message
  })
})

export const saveSessions = (sessions: ChatSession[]) => {
  if (typeof window === 'undefined') {
    return
  }

  // 仍写不下时，逐步丢弃最旧的会话（至少保留最近 10 个；不足 10 个时至少尝试全量一次），绝不抛异常到 React
  const minKeep = Math.min(sessions.length, 10)
  for (let keep = sessions.length; keep >= minKeep && keep >= 1; keep--) {
    try {
      window.localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify(sessions.slice(0, keep).map(toPersistableSession))
      )
      return
    } catch {
      // 容量不够，继续缩减
    }
  }

  // 全部失败：放弃本次持久化（不影响当前页面使用，仅下次打开时历史可能缺失）
}
