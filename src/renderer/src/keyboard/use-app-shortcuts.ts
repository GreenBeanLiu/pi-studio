import { useEffect, useRef } from 'react'
import type { ShortcutActionId, ShortcutContext } from './actions'
import { DEFAULT_BINDINGS } from './bindings'
import { focusScopeOf, resolveShortcut } from './resolve'

/**
 * 应用级快捷键:App 顶层只注册**一个** capture 阶段监听器(见 优化.md
 * 「路由与焦点规则」)。匹配逻辑全在纯函数 resolveShortcut 里,这里只负责
 * 读取上下文、分发 action 和阻止默认行为。
 *
 * action 一律路由到页面已有的 command,不复制业务逻辑 —— 按钮禁用时
 * 对应快捷键也应通过 `when` 条件失效,而不是各自判断一遍。
 */
export function useAppShortcuts(
  context: Omit<ShortcutContext, 'focus'>,
  handlers: Partial<Record<ShortcutActionId, () => void>>,
): void {
  // 用 ref 持有最新值,避免每次状态变化都重新绑定监听器
  const ctxRef = useRef(context)
  const handlersRef = useRef(handlers)
  ctxRef.current = context
  handlersRef.current = handlers

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const hit = resolveShortcut(
        {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
        },
        { ...ctxRef.current, focus: focusScopeOf(event.target) },
        DEFAULT_BINDINGS,
      )
      if (!hit) return

      const run = handlersRef.current[hit.binding.action]
      // 没接线的 action 不拦截按键,让原生行为继续
      if (!run) return

      event.preventDefault()
      event.stopPropagation()
      run()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])
}
