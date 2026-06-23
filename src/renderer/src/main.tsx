import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from 'antd-style'
import { piDarkTheme, piLightTheme } from './theme'
import App from './App'
import './index.css'

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
      <App appearance={appearance} onToggleTheme={toggleAppearance} />
    </ThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
