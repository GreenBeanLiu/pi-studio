import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp } from 'antd'
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
  :root,
  html[data-appearance] {
    --ant-color-text: ${(p) => p.theme.colorText};
    --ant-color-text-secondary: ${(p) => p.theme.colorTextSecondary};
    --ant-color-text-tertiary: ${(p) => p.theme.colorTextTertiary};
    --ant-color-text-disabled: ${(p) => p.theme.colorTextDisabled};
    --ant-color-fill: ${(p) => p.theme.colorFill};
    --ant-color-fill-secondary: ${(p) => p.theme.colorFillSecondary};
    --ant-color-fill-tertiary: ${(p) => p.theme.colorFillTertiary};
    --ant-color-fill-quaternary: ${(p) => p.theme.colorFillQuaternary};
    --ant-color-bg-base: ${(p) => p.theme.colorBgBase};
    --ant-color-bg-container: ${(p) => p.theme.colorBgContainer};
    --ant-color-bg-elevated: ${(p) => p.theme.colorBgElevated};
    --ant-color-bg-layout: ${(p) => p.theme.colorBgLayout};
    --ant-color-border: ${(p) => p.theme.colorBorder};
    --ant-color-border-secondary: ${(p) => p.theme.colorBorderSecondary};
    --ant-color-primary: ${(p) => p.theme.colorPrimary};
    --ant-color-primary-hover: ${(p) => p.theme.colorPrimaryHover};
    --ant-color-primary-bg: ${(p) => p.theme.colorPrimaryBg};
    --ant-color-primary-border: ${(p) => p.theme.colorPrimaryBorder};
    --ant-color-error: ${(p) => p.theme.colorError};
    --ant-color-error-active: ${(p) => p.theme.colorErrorActive};
    --ant-color-error-bg: ${(p) => p.theme.colorErrorBg};
    --ant-color-error-bg-hover: ${(p) => p.theme.colorErrorBgHover};
    --ant-color-error-border: ${(p) => p.theme.colorErrorBorder};
    --ant-motion-ease-out: ${(p) => p.theme.motionEaseOut};

    /* Tailwind utilities and legacy CSS consume the same semantic palette. */
    --color-background: var(--ant-color-bg-layout);
    --color-surface: var(--ant-color-bg-container);
    --color-surface-2: var(--ant-color-bg-elevated);
    --color-surface-3: var(--ant-color-fill-tertiary);
    --color-border: var(--ant-color-border);
    --color-border-soft: var(--ant-color-border-secondary);
    --color-fill-1: var(--ant-color-fill-quaternary);
    --color-fill-2: var(--ant-color-fill-tertiary);
    --color-fill-3: var(--ant-color-fill-secondary);
    --color-text: var(--ant-color-text);
    --color-text-soft: var(--ant-color-text-secondary);
    --color-text-muted: var(--ant-color-text-tertiary);
    --color-accent: var(--ant-color-primary);
    --color-accent-2: var(--ant-color-primary-hover);
    --color-primary: var(--ant-color-primary);
    --color-secondary: var(--ant-color-fill-tertiary);
    --color-muted: var(--ant-color-fill-quaternary);
    --color-card: var(--ant-color-bg-container);
    --color-popover: var(--ant-color-bg-elevated);
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
      {/*
        antd 的静态 message/Modal.confirm 拿不到 ThemeProvider 的 context,切暗色时
        通知条不跟着变(控制台还会刷 "Static function can not consume context")。
        包一层 App provider,组件里统一用 AntApp.useApp()。
        antd v6 默认开 cssVar,这时 component={false} 会另报一条警告,所以老老实实渲染
        一个 div —— 它夹在 #root 和 App 的 shell 之间,height:100% 才能把高度链接上。
      */}
      <AntApp component="div" style={{ height: '100%' }}>
        <App appearance={appearance} onToggleTheme={toggleAppearance} />
      </AntApp>
    </ThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
