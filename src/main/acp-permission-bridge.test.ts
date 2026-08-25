import { describe, expect, it, vi } from 'vitest'
import { UnattendedApprovalGate } from './approval-gateway'
import {
  AcpPermissionBridge,
  isAcpPermissionRequestId,
  toExtensionUiRequest,
  type AcpRequestPermissionParams,
} from './acp-permission-bridge'

/** Claude Agent v0.70.0 实际发过来的形状。 */
const CLAUDE_REQUEST: AcpRequestPermissionParams = {
  sessionId: 's1',
  toolCall: { title: 'Write hello.txt', kind: 'edit', toolCallId: 'toolu_01' },
  options: [
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
    { optionId: 'allow', name: 'Allow Once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
  ],
}

function bridge(overrides?: Partial<ConstructorParameters<typeof AcpPermissionBridge>[0]>) {
  const presented: ReturnType<typeof toExtensionUiRequest>[] = []
  const instance = new AcpPermissionBridge({
    present: (event) => presented.push(event),
    ...overrides,
  })
  return { instance, presented }
}

describe('projecting an ACP permission request onto pi的 UI 请求', () => {
  // 用 select 而不是 confirm:confirm 只有是非两档,会把「永久允许」丢掉。
  it('keeps every option the agent offered', () => {
    const event = toExtensionUiRequest('acp-perm:1', CLAUDE_REQUEST)
    expect(event.method).toBe('select')
    expect(event.title).toBe('Write hello.txt')
    expect(event.options).toEqual(['Deny', 'Allow Once', 'Always Allow'])
  })

  it('falls back to a readable title when the agent gives none', () => {
    const event = toExtensionUiRequest('acp-perm:1', { sessionId: 's', options: [] })
    expect(event.title).not.toBe('')
  })

  it('tags its request ids so responses can be routed back', () => {
    const { instance, presented } = bridge()
    void instance.request(CLAUDE_REQUEST)
    expect(isAcpPermissionRequestId(presented[0]!.id)).toBe(true)
    expect(isAcpPermissionRequestId('pi-native-42')).toBe(false)
  })
})

describe('AcpPermissionBridge settlement', () => {
  it('maps the chosen option text back to its optionId', async () => {
    const { instance, presented } = bridge()
    const pending = instance.request(CLAUDE_REQUEST)
    const settled = instance.settle({
      type: 'extension_ui_response',
      id: presented[0]!.id,
      value: 'Always Allow',
    })
    expect(settled).toBe(true)
    await expect(pending).resolves.toEqual({ outcome: 'selected', optionId: 'allow_always' })
  })

  it('treats an unrecognised选项文本 as a cancellation rather than an allow', async () => {
    const { instance, presented } = bridge()
    const pending = instance.request(CLAUDE_REQUEST)
    instance.settle({ type: 'extension_ui_response', id: presented[0]!.id, value: '???' })
    await expect(pending).resolves.toEqual({ outcome: 'cancelled' })
  })

  it('maps a confirm-shaped answer onto the matching kind', async () => {
    const yes = bridge()
    const yesPending = yes.instance.request(CLAUDE_REQUEST)
    yes.instance.settle({ type: 'extension_ui_response', id: yes.presented[0]!.id, confirmed: true })
    await expect(yesPending).resolves.toEqual({ outcome: 'selected', optionId: 'allow' })

    const no = bridge()
    const noPending = no.instance.request(CLAUDE_REQUEST)
    no.instance.settle({ type: 'extension_ui_response', id: no.presented[0]!.id, confirmed: false })
    await expect(noPending).resolves.toEqual({ outcome: 'selected', optionId: 'reject' })
  })

  it('ignores a response for an id it does not own', () => {
    const { instance } = bridge()
    expect(instance.settle({ type: 'extension_ui_response', id: 'someone-else', confirmed: true })).toBe(
      false,
    )
  })

  it('settles a request only once', async () => {
    const { instance, presented } = bridge()
    const pending = instance.request(CLAUDE_REQUEST)
    const id = presented[0]!.id
    expect(instance.settle({ type: 'extension_ui_response', id, value: 'Allow Once' })).toBe(true)
    expect(instance.settle({ type: 'extension_ui_response', id, value: 'Deny' })).toBe(false)
    await expect(pending).resolves.toEqual({ outcome: 'selected', optionId: 'allow' })
  })

  // agent 会一直等这个响应。推不出去就当场取消,否则那一轮永远停在这里。
  it('cancels immediately when the request cannot be presented', async () => {
    const instance = new AcpPermissionBridge({
      present: () => {
        throw new Error('no window')
      },
    })
    await expect(instance.request(CLAUDE_REQUEST)).resolves.toEqual({ outcome: 'cancelled' })
    expect(instance.pendingIds()).toEqual([])
  })

  it('cancels an option-less request instead of hanging the turn', async () => {
    const { instance, presented } = bridge()
    await expect(instance.request({ sessionId: 's', options: [] })).resolves.toEqual({
      outcome: 'cancelled',
    })
    expect(presented).toEqual([])
  })

  it('cancels every pending approval of a session when the turn is aborted', async () => {
    const { instance } = bridge()
    const a = instance.request(CLAUDE_REQUEST)
    const b = instance.request({ ...CLAUDE_REQUEST, sessionId: 's1' })
    const other = instance.request({ ...CLAUDE_REQUEST, sessionId: 's2' })
    expect(instance.cancelSession('s1')).toBe(2)
    await expect(a).resolves.toEqual({ outcome: 'cancelled' })
    await expect(b).resolves.toEqual({ outcome: 'cancelled' })
    expect(instance.pendingIds()).toHaveLength(1)
    instance.cancelSession('s2')
    await expect(other).resolves.toEqual({ outcome: 'cancelled' })
  })
})

describe('timeout behaviour', () => {
  // 默认不超时:pi 现有的交互式审批就是无限等,桥自己先超时会和界面上还挂着的
  // 对话框失步 —— 用户点「允许」时请求早就被拒了。
  it('waits indefinitely by default', async () => {
    vi.useFakeTimers()
    try {
      const { instance } = bridge()
      const settled = vi.fn()
      void instance.request(CLAUDE_REQUEST).then(settled)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(settled).not.toHaveBeenCalled()
      expect(instance.pendingIds()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels after timeoutMs when one is configured', async () => {
    vi.useFakeTimers()
    try {
      const { instance } = bridge({ timeoutMs: 1_000 })
      const pending = instance.request(CLAUDE_REQUEST)
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(pending).resolves.toEqual({ outcome: 'cancelled' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// 投影成 extension_ui_request 的好处:无人值守那条路不用另写一遍。
describe('unattended runs deny ACP approvals for free', () => {
  it('lets the existing gate answer an ACP permission request', async () => {
    const { instance, presented } = bridge()
    const pending = instance.request(CLAUDE_REQUEST)
    const gate = new UnattendedApprovalGate()

    const answered = gate.answer(presented[0])
    expect(answered).not.toBeNull()
    expect(instance.settle(answered!.response)).toBe(true)
    await expect(pending).resolves.toEqual({ outcome: 'cancelled' })
    expect(gate.denied()).toHaveLength(1)
    expect(gate.denied()[0]?.method).toBe('select')
  })
})
