/**
 * 按键组合标准化。
 *
 * 内部一律用 `Mod` 表示主修饰键(Windows 上是 Ctrl),为将来平台适配留余地;
 * 展示层再翻回 `Ctrl`。数字键用 `event.code` 的 `Digit1`,不用 `event.key` ——
 * 后者在某些布局/输入法下不是 '1'。
 */

const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const

/** 把一条 binding 的 combo 文本标准化成可比较的形式。 */
export function normalizeCombo(combo: string): string {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const mods = new Set<string>()
  let key = ''
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'mod') mods.add('Mod')
    else if (lower === 'ctrl' || lower === 'control') mods.add('Ctrl')
    else if (lower === 'alt') mods.add('Alt')
    else if (lower === 'shift') mods.add('Shift')
    else key = part
  }
  const ordered = MOD_ORDER.filter((m) => mods.has(m))
  return [...ordered, normalizeKey(key)].join('+')
}

/** 单个主键的标准化:字母统一大写,其余保留原样。 */
export function normalizeKey(key: string): string {
  if (!key) return ''
  if (/^Digit[0-9]$/.test(key)) return key
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase()
  return key
}

export type KeyEventLike = {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * 把一个键盘事件转成标准化 combo。
 *
 * 数字键优先用 code(Digit1..Digit9);带 Shift 时 event.key 会变成符号
 * (Shift+1 => '!'),用 code 才稳定。
 */
export function comboFromEvent(event: KeyEventLike): string {
  const mods: string[] = []
  // Windows 上 Mod = Ctrl;metaKey 一并接受,便于将来 macOS 复用同一份 binding
  if (event.ctrlKey || event.metaKey) mods.push('Mod')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')

  let key: string
  if (/^Digit[0-9]$/.test(event.code)) key = event.code
  else if (event.key === ' ') key = 'Space'
  else key = normalizeKey(event.key)

  const ordered = MOD_ORDER.filter((m) => mods.includes(m))
  return [...ordered, key].join('+')
}

/** 展示用:Mod -> Ctrl,Digit1 -> 1。 */
export function displayCombo(combo: string): string {
  return combo
    .split('+')
    .map((part) => {
      if (part === 'Mod') return 'Ctrl'
      const digit = /^Digit([0-9])$/.exec(part)
      return digit ? digit[1] : part
    })
    .join('+')
}
