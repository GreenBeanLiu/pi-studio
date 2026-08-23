import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8')
const rpcPatch = readFileSync(
  new URL('../../../../patches/@earendil-works__pi-coding-agent@0.82.1.patch', import.meta.url),
  'utf8',
)

// 2026-08-03: 两个会话同时"停住"——模型调用失败后 pi 静默重试、重试耗尽,
// 而 ChatPane 一个相关事件都没处理,界面上既没有重试提示也没有错误。
describe('failed run visibility', () => {
  it('keeps the run alive instead of reporting success when pi will retry', () => {
    expect(chatPane).toContain('if (event.willRetry)')
    expect(chatPane).toContain('本轮出错，等待自动重试')
  })

  it('shows retry progress and the error that triggered it', () => {
    expect(chatPane).toContain("case 'auto_retry_start':")
    expect(chatPane).toContain('setRetryNotice({')
    expect(chatPane).toContain('正在自动重试')
  })

  it('surfaces the final error when retries are exhausted', () => {
    expect(chatPane).toContain("case 'auto_retry_end':")
    expect(chatPane).toContain('次后放弃')
  })

  it('reports the exception that pi rpc mode used to swallow', () => {
    expect(rpcPatch).toContain('output({ type: "run_failed", scope: "prompt", message });')
    expect(chatPane).toContain("case 'run_failed':")
    expect(chatPane).toContain('本轮运行异常结束')
  })

  it('falls back to agent_settled when no end event ever arrives', () => {
    expect(chatPane).toContain("case 'agent_settled':")
    expect(chatPane).toContain('本轮运行意外结束')
  })
})
