import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8')

// 2026-08-23: 提一个问题,画面刷一下,刚打的字就没了。用户消息和流式回复是本地
// 靠 message_start/update 拼出来的,而运行途中每个工具事件都会广播一份 projection
// —— 那份 snapshot.messages 还停在上一次落库的内容。原来这里无条件覆盖。
describe('projection must not clobber the live conversation', () => {
  it('only replaces messages when the projection really changed them', () => {
    expect(chatPane).toContain(
      'if (projection.messagesRevision !== appliedMessagesRevisionRef.current) {',
    )
  })

  it('keeps the streaming index unless the message list was replaced', () => {
    // streamingIndex 被清空后,下一个 message_update 会当成新消息 append,
    // 于是同一条回复在界面上出现两次
    const guard = chatPane.slice(
      chatPane.indexOf('if (projection.messagesRevision !== appliedMessagesRevisionRef.current) {'),
    )
    const guardBody = guard.slice(0, guard.indexOf('setToolExecutions'))
    expect(guardBody).toContain('streamingIndexRef.current = null')
    expect(guardBody).toContain('setMessages(projection.messages)')
  })

  it('still applies tools and approvals on every projection', () => {
    // 这两个本来就是实时的,不能一起被挡在门外
    const handler = chatPane.slice(chatPane.indexOf('api.pi.onSessionProjection((projection)'))
    const handlerBody = handler.slice(0, handler.indexOf('}, [workspace?.path])'))
    const guardEnd = handlerBody.indexOf('setToolExecutions')
    const closeBrace = handlerBody.lastIndexOf('}', guardEnd)
    expect(closeBrace).toBeLessThan(guardEnd)
    expect(handlerBody).toContain('setApprovalRequests(projection.approvals.map(approvalFromProjection))')
  })

  it('records the revision it applied on the cold load too', () => {
    expect(chatPane).toContain(
      'appliedMessagesRevisionRef.current = projection.messagesRevision',
    )
  })

  it('forgets the applied revision when the workspace goes away', () => {
    expect(chatPane).toContain('appliedMessagesRevisionRef.current = null')
  })
})
