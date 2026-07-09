import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider, createGlobalStyle } from 'antd-style'
import { piDarkTheme, piLightTheme } from './theme'
import App from './App'
import './index.css'

/**
 * @lobehub/ui 的静态样式(ActionIcon hover 等)引用 var(--ant-xxx) CSS 变量,
 * 这些变量本该由 lobehub 自家 ThemeProvider 注入 —— 我们没用它,导致
 * hover 色失效回退到 body 继承色(浅色主题下 = 白色,图标 hover 即"消失")。
 * 这里把 antd token 桥接成同名 CSS 变量,随主题切换自动更新。
 */
const CssVarBridge = createGlobalStyle`
  :root {
    --ant-color-text: ${(p) => p.theme.colorText};
    --ant-color-text-secondary: ${(p) => p.theme.colorTextSecondary};
    --ant-color-text-tertiary: ${(p) => p.theme.colorTextTertiary};
    --ant-color-fill: ${(p) => p.theme.colorFill};
    --ant-color-fill-secondary: ${(p) => p.theme.colorFillSecondary};
    --ant-color-fill-tertiary: ${(p) => p.theme.colorFillTertiary};
    --ant-color-bg-container: ${(p) => p.theme.colorBgContainer};
    --ant-color-bg-layout: ${(p) => p.theme.colorBgLayout};
    --ant-color-border: ${(p) => p.theme.colorBorder};
    --ant-color-border-secondary: ${(p) => p.theme.colorBorderSecondary};
    --ant-color-error: ${(p) => p.theme.colorError};
    --ant-color-error-active: ${(p) => p.theme.colorErrorActive};
    --ant-color-error-bg: ${(p) => p.theme.colorErrorBg};
    --ant-color-error-bg-hover: ${(p) => p.theme.colorErrorBgHover};
    --ant-color-error-border: ${(p) => p.theme.colorErrorBorder};
    --ant-motion-ease-out: ${(p) => p.theme.motionEaseOut};
  }
`

function applyAppearance(a: 'dark' | 'light') {
  document.documentElement.setAttribute('data-appearance', a)
  document.documentElement.style.colorScheme = a
}

function Root() {
  const [appearance, setAppearance] = useState<'dark' | 'light'>(() => {
    const saved = (localStorage.getItem('pi-studio-theme') ?? 'dark') as 'dark' | 'light'
    applyAppearance(saved)
    return saved
  })

  function toggleAppearance() {
    setAppearance((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem('pi-studio-theme', next)
      applyAppearance(next)
      return next
    })
  }

  return (
    <ThemeProvider appearance={appearance} theme={appearance === 'dark' ? piDarkTheme : piLightTheme}>
      <CssVarBridge />
      <App appearance={appearance} onToggleTheme={toggleAppearance} />
    </ThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
