import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

// 最后防线：任何未捕获的渲染/副作用错误都不再导致整站白屏（此前 localStorage
// 配额溢出就会把 React 整棵树卸载成空白页），至少给用户一个可操作的提示。
class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[chatui] 未捕获错误:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            padding: 24,
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            color: '#1f332e',
            textAlign: 'center'
          }}
        >
          <p style={{ fontSize: 16, margin: 0 }}>页面出了点问题，刷新一下通常即可恢复。</p>
          <p
            style={{
              fontSize: 12,
              margin: 0,
              opacity: 0.6,
              maxWidth: 320,
              wordBreak: 'break-all'
            }}
          >
            {String(this.state.error.message || this.state.error).slice(0, 200)}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 28px',
              fontSize: 15,
              borderRadius: 8,
              border: 'none',
              background: '#2f6f4f',
              color: '#fff'
            }}
          >
            刷新页面
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
