import type { ShortcutBinding, ShortcutContext } from './actions'
import { comboFromEvent, normalizeCombo, type KeyEventLike } from './normalize'

export type ResolveInput = KeyEventLike & {
  /** 长按自动重复 */
  repeat?: boolean
  /** 输入法组字中 */
  isComposing?: boolean
}

export type ResolveResult = {
  binding: ShortcutBinding
  /** 匹配成功时调用方应 preventDefault + stopPropagation */
  preventDefault: true
} | null

/**
 * 让位规则:光标在可编辑控件里时,只放行带修饰键的全局快捷键。
 * 单键(F2、Delete、方向键)必须留给输入框本身。
 */
function isEditableScope(focus: ShortcutContext['focus']): boolean {
  return focus === 'composer' || focus === 'editable'
}

function comboHasModifier(combo: string): boolean {
  return combo.includes('Mod+') || combo.includes('Alt+')
}

function matchesConditions(binding: ShortcutBinding, ctx: ShortcutContext): boolean {
  const when = binding.when
  if (!when) return true
  if (when.view && when.view !== ctx.view) return false
  if (when.focus && when.focus !== ctx.focus) return false
  if (when.workspace !== undefined && when.workspace !== ctx.workspace) return false
  if (when.agentRunning !== undefined && when.agentRunning !== ctx.agentRunning) return false
  return true
}

/**
 * 纯函数解析:给定事件 + 上下文,返回该执行哪条 binding。
 *
 * 顺序对应文档的层级:输入法 > Modal/浮层 > 焦点组件 > 应用全局。
 * 没有匹配时返回 null —— 必须保留浏览器和原生输入行为。
 */
export function resolveShortcut(
  event: ResolveInput,
  ctx: ShortcutContext,
  bindings: ShortcutBinding[],
): ResolveResult {
  // 输入法组字期间一律不接管:此时的 Enter 是确认候选词、方向键是翻候选
  if (event.isComposing) return null

  // Modal / 命令中心打开时,全局快捷键不穿透(它们自己处理 Escape、Enter)
  if (ctx.modalOpen || ctx.focus === 'modal' || ctx.focus === 'command-center') return null

  const combo = comboFromEvent(event)
  if (!combo || combo === 'Mod' || combo === 'Alt' || combo === 'Shift') return null

  for (const binding of bindings) {
    if (normalizeCombo(binding.combo) !== combo) continue
    // 状态改变类动作忽略长按重复,避免连续新建会话/切主题
    if (event.repeat && !binding.repeat) continue
    if (isEditableScope(ctx.focus) && !comboHasModifier(binding.combo)) continue
    if (!matchesConditions(binding, ctx)) continue
    return { binding, preventDefault: true }
  }
  return null
}

/** 从 DOM 目标推断焦点作用域。 */
export function focusScopeOf(target: EventTarget | null): ShortcutContext['focus'] {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return 'other'
  if (el.closest('[data-shortcut-scope="command-center"]')) return 'command-center'
  if (el.closest('.ant-modal, [role="dialog"]')) return 'modal'
  if (el.closest('[data-shortcut-scope="composer"]')) return 'composer'
  if (el.closest('[data-shortcut-scope="session-list"]')) return 'session-list'
  const tag = el.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return 'editable'
  return 'other'
}
