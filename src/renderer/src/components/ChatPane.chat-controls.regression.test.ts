import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8')
// 样式在 2026-08-30 拆到了 ChatPane.styles.ts;CSS 数值只能这样断言(渲染不出来)。
const chatPaneStyles = readFileSync(new URL('./ChatPane.styles.ts', import.meta.url), 'utf8')

// 2026-08-08: 聊天区三处手感问题——选完模型弹层赖着不走、回到底部的箭头和输入框
// 上那排按钮挤在一起、断了一轮之后想把刚发的原文捞回来只能手选。
describe('chat pane controls', () => {
  it('closes the model popover as soon as a model is picked', () => {
    expect(chatPane).toContain('const [paramsOpen, setParamsOpen] = useState(false)')
    expect(chatPane).toContain('open={paramsOpen}')
    expect(chatPane).toContain('onOpenChange={setParamsOpen}')
    // 切换成功之后才收起,失败要留在原地让用户重选。
    // 2026-08-25:原来这里是 setCurrentModel(setModel 的返回值),但选外部 agent
    // 会换掉整个后端而组件不重挂载 —— 只更新 currentModel 的话,能力和模型名都还是
    // 上一个后端的。现在统一走 refreshBackendState()。
    const pickModel = chatPane.slice(chatPane.indexOf('async function pickModel'))
    const refreshAt = pickModel.indexOf('await refreshBackendState()')
    const closeAt = pickModel.indexOf('setParamsOpen(false)')
    expect(refreshAt).toBeGreaterThan(-1)
    expect(closeAt).toBeGreaterThan(refreshAt)
    // 收起必须在 try 里 —— 失败要留在原地
    expect(pickModel.indexOf('catch')).toBeGreaterThan(closeAt)
    // 选外部 agent 会真的起一个进程:连点几下不能攒出好几个。
    // 日志里见过一次点击起三个 agent 的。
    expect(pickModel).toContain('if (switchingModelRef.current) return')
    expect(pickModel.indexOf('switchingModelRef.current = false')).toBeGreaterThan(
      pickModel.indexOf('finally'),
    )
  })

  it('keeps the scroll-to-bottom button clear of the input toolbar', () => {
    const style = chatPaneStyles.slice(chatPaneStyles.indexOf('scrollBottomBtn: css`'))
    const bottom = style.match(/bottom:\s*(\d+)px/)
    expect(bottom).not.toBeNull()
    expect(Number(bottom![1])).toBeGreaterThanOrEqual(56)
    const zIndex = style.match(/z-index:\s*(\d+)/)
    expect(Number(zIndex![1])).toBeGreaterThanOrEqual(100)
  })

  it('offers a copy button on message bubbles', () => {
    expect(chatPane).toContain('function copyableTextOf')
    expect(chatPane).toContain('function CopyMessageButton')
    expect(chatPane).toContain('navigator.clipboard.writeText(text)')
    // hover 才显形,但要挂在行上,不能每条消息常驻一个图标
    expect(chatPane).toContain("cx('chat-msg-row', styles.msgRow")
    expect(chatPaneStyles).toContain('.chat-msg-row:hover &')
  })
})

// 2026-08-26:改推理深度原来要「点 chip → 在模型列表里找到当前那一行 → 悬停 →
// 右侧二级浮层」。面板本身已经是一层浮层,再套一层 hover 浮层,鼠标走偏就全关;
// 而且这些设置跟「选哪个模型」根本是两回事。
describe('会话参数不能再埋在模型行的悬停浮层里', () => {
  it('没有挂在模型行上的二级 Popover 了', () => {
    expect(chatPane).not.toContain('modelHoverPanel')
    expect(chatPaneStyles).not.toContain('modelHoverPanel')
    const panel = chatPane.slice(chatPane.indexOf('const paramsPanel = ('))
    const list = panel.slice(0, panel.indexOf('推理深度'))
    // 模型行是直接的 button,不再被 Popover 包着
    expect(list).not.toContain('<Popover')
  })

  it('推理深度和权限模式平铺在面板里', () => {
    const panel = chatPane.slice(
      chatPane.indexOf('const paramsPanel = ('),
      chatPane.indexOf('const sessionExportPanel'),
    )
    expect(panel).toContain('推理深度')
    expect(panel).toContain('权限模式')
    expect(panel).toContain('handlePermissionMode')
  })

  it('模型列表有搜索', () => {
    const panel = chatPane.slice(chatPane.indexOf('const paramsPanel = ('))
    expect(panel.slice(0, 600)).toContain('搜索模型或 agent')
    expect(chatPane).toContain('query: modelQuery')
  })

  // 会跳过审批的档位要标出来:外部 agent 不走宿主的 fs/terminal 通道,
  // 权限请求是唯一能拦住它的地方,关掉它等于全放行。
  it('危险档位有标记', () => {
    const panel = chatPane.slice(chatPane.indexOf('const paramsPanel = ('))
    expect(panel).toContain('mode.risky')
  })
})
