import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8')

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
  })

  it('keeps the scroll-to-bottom button clear of the input toolbar', () => {
    const style = chatPane.slice(chatPane.indexOf('scrollBottomBtn: css`'))
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
    expect(chatPane).toContain('.chat-msg-row:hover &')
  })
})
