/**
 * 外部 ACP agent 的权限模式。
 *
 * 各家的档位不一样也不一样多:codex 三档(read-only / agent / agent-full-access),
 * claude 六档(default / acceptEdits / plan / auto / dontAsk / bypassPermissions)。
 * 所以不做「统一成三档」的硬映射 —— 那会把 claude 的一半档位吃掉,
 * 而且以后来个新 agent 就得再改一次表。
 *
 * 做法是:原样展示 agent 自己报的模式(它给了 id / name / description),
 * 只对认识的 id 补一句中文注解,认不出的就用 agent 给的名字。
 */

export type AcpSessionMode = {
  id: string
  name: string
  description?: string
}

export type AcpModeOption = AcpSessionMode & {
  /** 认识的 id 才有的中文注解;认不出就没有,界面退回用 name。 */
  hint?: string
  /** 会跳过审批的档位。界面要把它标出来 —— 选中它等于关掉唯一的控制点。 */
  risky?: boolean
}

const KNOWN: Record<string, { hint: string; risky?: boolean }> = {
  // codex
  'read-only': { hint: '只读,改文件和跑命令都要批准' },
  agent: { hint: '读写文件、跑命令' },
  'agent-full-access': { hint: '可越出工作区,且联网', risky: true },
  // claude
  default: { hint: '危险操作会问你' },
  acceptEdits: { hint: '文件编辑自动放行' },
  plan: { hint: '只做计划,不动手' },
  auto: { hint: '由模型判断是否放行', risky: true },
  dontAsk: { hint: '不询问,未预先批准的一律拒绝' },
  bypassPermissions: { hint: '跳过全部权限检查', risky: true },
}

/** 补注解。顺序保持 agent 给的那个 —— 它自己知道该怎么排。 */
export function describeAcpModes(modes: readonly AcpSessionMode[] | undefined): AcpModeOption[] {
  if (!modes?.length) return []
  return modes.map((mode) => ({ ...mode, ...KNOWN[mode.id] }))
}

/** 界面上这一档显示成什么。agent 的 name 是权威,中文注解只作副标题。 */
export function acpModeLabel(mode: AcpModeOption): string {
  return mode.name || mode.id
}
