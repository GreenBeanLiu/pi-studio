import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  EvalDriver,
  EVAL_WORKSPACE_TOKEN,
  parseEvalCase,
  readEvalRecording,
  writeEvalRecording,
  type EvalEventFrame,
  type EvalRecording,
} from './eval-driver'
import { PiReplayEvalEngine } from './pi-replay-eval-engine'

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function assistant(content: unknown[], stopReason: 'stop' | 'toolUse') {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'pi-studio-replay',
    model: 'pi-studio-eval-replay',
    usage,
    stopReason,
    timestamp: 1_786_924_800_000,
  }
}

function frame(atMs: number, assistantMessageEvent: unknown): EvalEventFrame {
  return {
    atMs,
    observedAt: new Date(1_786_924_800_000 + atMs).toISOString(),
    raw: { type: 'message_update', assistantMessageEvent },
  }
}

function toolReplayRecording(path = `${EVAL_WORKSPACE_TOKEN}/result.txt`): EvalRecording {
  const emptyTool = assistant([{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }], 'toolUse')
  const toolCall = { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path, content: 'done' } }
  const completeTool = assistant([toolCall], 'toolUse')
  const emptyText = assistant([], 'stop')
  const startedText = assistant([{ type: 'text', text: '' }], 'stop')
  const completeText = assistant([{ type: 'text', text: 'finished' }], 'stop')
  return {
    version: 1,
    caseId: 'tool-replay',
    engineResult: {
      finalResponse: 'finished',
      finishReason: 'settled',
      exitCode: 0,
      sessionId: 'recorded-session',
    },
    events: [
      frame(0, { type: 'start', partial: assistant([], 'toolUse') }),
      frame(1, { type: 'toolcall_start', contentIndex: 0, partial: emptyTool }),
      frame(2, { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: emptyTool }),
      frame(3, { type: 'toolcall_end', contentIndex: 0, toolCall, partial: completeTool }),
      frame(4, { type: 'done', reason: 'toolUse', message: completeTool }),
      {
        atMs: 5,
        observedAt: new Date(1_786_924_800_005).toISOString(),
        raw: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: toolCall.arguments },
      },
      frame(6, { type: 'start', partial: emptyText }),
      frame(7, { type: 'text_start', contentIndex: 0, partial: startedText }),
      frame(8, { type: 'text_delta', contentIndex: 0, delta: 'finished', partial: completeText }),
      frame(9, { type: 'text_end', contentIndex: 0, content: 'finished', partial: completeText }),
      frame(10, { type: 'done', reason: 'stop', message: completeText }),
    ],
  }
}

describe('PiReplayEvalEngine', () => {
  it('replays provider chunks through the real agent loop and built-in write tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-replay-test-'))
    const fixture = join(root, 'fixture')
    mkdirSync(fixture)
    writeFileSync(join(fixture, 'input.txt'), 'before', 'utf8')
    const evalCase = parseEvalCase({
      version: 1,
      id: 'tool-replay',
      fixture,
      prompt: 'create result.txt',
      timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [
        { type: 'exit-code', expected: 0 },
        { type: 'file', path: 'result.txt', equals: 'done' },
        { type: 'diff', allow: ['result.txt'], maxChangedFiles: 1 },
      ],
    })

    const report = await new EvalDriver().run(evalCase, new PiReplayEvalEngine(toolReplayRecording()))

    expect(report).toMatchObject({ passed: true, finalResponse: 'finished', finishReason: 'settled' })
    expect(report.sessionId).toMatch(/^eval:tool-replay:/)
    expect(report.sessionId).not.toBe('recorded-session')
    expect(report.workspaceDiff).toEqual([expect.objectContaining({ path: 'result.txt', status: 'added' })])
    expect(report.toolCalls).toEqual([expect.objectContaining({ callId: 'call-1', toolName: 'write' })])
    expect(JSON.stringify(report.events)).toContain(EVAL_WORKSPACE_TOKEN)
    expect(report.durationMs).toBeGreaterThanOrEqual(6)

    const replayFixture = join(root, 'replay-fixture')
    mkdirSync(replayFixture)
    writeFileSync(join(replayFixture, 'input.txt'), 'before', 'utf8')
    const replayCase = parseEvalCase({
      version: 1,
      id: 'tool-replay',
      fixture: replayFixture,
      prompt: 'create result.txt',
      timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [
        { type: 'file', path: 'result.txt', equals: 'done' },
        { type: 'diff', allow: ['result.txt'], maxChangedFiles: 1 },
      ],
    })
    const recordingPath = join(root, 'rerecorded.json')
    await writeEvalRecording(recordingPath, report)
    const rerecording = await readEvalRecording(recordingPath)

    const replayed = await new EvalDriver().run(replayCase, new PiReplayEvalEngine(rerecording))

    expect(replayed).toMatchObject({ passed: true, finalResponse: 'finished', finishReason: 'settled' })
    expect(replayed.sessionId).not.toBe(report.sessionId)
  })

  it('rejects residual absolute tool paths outside the new replay workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-replay-path-'))
    const fixture = join(root, 'fixture')
    mkdirSync(fixture)
    const evalCase = parseEvalCase({
      version: 1, id: 'tool-replay', fixture, prompt: 'write outside', timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'exit-code', expected: 1 }],
    })

    const report = await new EvalDriver().run(
      evalCase,
      new PiReplayEvalEngine(toolReplayRecording('C:/outside/result.txt')),
    )

    expect(report).toMatchObject({ passed: true, finishReason: 'error' })
    expect(report.error).toContain('absolute path outside the replay workspace')
  })

  it('replays a pre-chunk provider failure from an explicit sidecar', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-replay-throw-'))
    const fixture = join(root, 'fixture')
    mkdirSync(fixture)
    const evalCase = parseEvalCase({
      version: 1, id: 'throw-replay', fixture, prompt: 'fail', timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'exit-code', expected: 1 }],
    })
    const recording: EvalRecording = {
      version: 1,
      caseId: 'throw-replay',
      engineResult: { finalResponse: '', finishReason: 'error', exitCode: 1, sessionId: 'recorded', error: 'recorded provider failure' },
      events: [],
      replay: { providerSteps: [{ kind: 'throw', message: 'recorded provider failure' }] },
    }

    const report = await new EvalDriver().run(evalCase, new PiReplayEvalEngine(recording))

    expect(report).toMatchObject({ passed: true, finishReason: 'error', error: 'recorded provider failure' })
  })

  it('replays a provider hang and remains cancellable at the eval deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-replay-hang-'))
    const fixture = join(root, 'fixture')
    mkdirSync(fixture)
    const evalCase = parseEvalCase({
      version: 1, id: 'hang-replay', fixture, prompt: 'hang', timeoutMs: 20,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'exit-code', expected: 1 }],
    })
    const recording: EvalRecording = {
      version: 1,
      caseId: 'hang-replay',
      engineResult: { finalResponse: '', finishReason: 'timeout', exitCode: 1, sessionId: 'recorded' },
      events: [],
      replay: { providerSteps: [{ kind: 'hang' }] },
    }

    const report = await new EvalDriver().run(evalCase, new PiReplayEvalEngine(recording))

    expect(report).toMatchObject({ passed: true, finishReason: 'timeout' })
  })

  it('replays an explicit provider cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-replay-cancel-'))
    const fixture = join(root, 'fixture')
    mkdirSync(fixture)
    const evalCase = parseEvalCase({
      version: 1, id: 'cancel-replay', fixture, prompt: 'cancel', timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'exit-code', expected: 1 }],
    })
    const recording: EvalRecording = {
      version: 1,
      caseId: 'cancel-replay',
      engineResult: { finalResponse: '', finishReason: 'cancelled', exitCode: 1, sessionId: 'recorded', error: 'recorded cancellation' },
      events: [],
      replay: { providerSteps: [{ kind: 'cancel', message: 'recorded cancellation' }] },
    }

    const report = await new EvalDriver().run(evalCase, new PiReplayEvalEngine(recording))

    expect(report).toMatchObject({ passed: true, finishReason: 'cancelled', error: 'recorded cancellation' })
  })
})
