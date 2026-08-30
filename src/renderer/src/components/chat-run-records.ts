import type { RunRecord, RunStatus, RunTimelineItem, RunToolRecord } from './chat-types'

/** 运行记录只留最近 N 条 —— 时间线面板是给"刚才发生了什么"用的,不是审计日志。 */
export const MAX_RUN_RECORDS = 20

/**
 * 一轮运行的最终状态。
 *
 * 顺序有讲究:用户主动停的算 aborted(不是失败),否则任何一个工具报错整轮就算 error。
 * agent_end 里原来把这段三元表达式抄了三遍(算给记忆建议的、写进 run.status 的、
 * 写进收尾时间线的),改一处漏两处只是时间问题。
 */
export function resolveRunStatus(run: RunRecord): RunStatus {
  if (run.status === 'aborted') return 'aborted'
  return run.tools.some((tool) => tool.status === 'error') ? 'error' : 'done'
}

function patch(runs: RunRecord[], runId: string | null, fn: (run: RunRecord) => RunRecord): RunRecord[] {
  if (!runId) return runs
  return runs.map((run) => (run.id === runId ? fn(run) : run))
}

/** 往指定运行记录里补一条时间线事件;没有目标 run 时原样返回。 */
export function appendTimelineEvent(
  runs: RunRecord[],
  runId: string | null,
  item: RunTimelineItem,
): RunRecord[] {
  return patch(runs, runId, (run) => ({ ...run, timeline: [...run.timeline, item] }))
}

export function startRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  return [run, ...runs].slice(0, MAX_RUN_RECORDS)
}

/** 正常收尾:结算状态、记结束时间、补一条收尾时间线。 */
export function completeRun(
  runs: RunRecord[],
  runId: string | null,
  timestamp: string,
): RunRecord[] {
  return patch(runs, runId, (run) => {
    const status = resolveRunStatus(run)
    return {
      ...run,
      endedAt: timestamp,
      status,
      timeline: [
        ...run.timeline,
        { id: `${run.id}:end`, type: 'event', label: 'Agent 结束', timestamp, status },
      ],
    }
  })
}

/**
 * 异常收尾。已经是 aborted 的不覆盖 —— 用户主动停的那一下比事后冒出来的错误更准确;
 * endedAt 也保留既有值,失败可能在收尾之后才报上来。
 */
export function failRun(runs: RunRecord[], runId: string | null, timestamp: string): RunRecord[] {
  return patch(runs, runId, (run) =>
    run.status === 'aborted' ? run : { ...run, status: 'error', endedAt: run.endedAt ?? timestamp },
  )
}

export function startTool(
  runs: RunRecord[],
  runId: string | null,
  tool: { toolCallId: string; toolName: string; args?: unknown },
  timestamp: string,
): RunRecord[] {
  return patch(runs, runId, (run) => ({
    ...run,
    // 同一个 callId 重复上报时替换而不是并存(重试会重发 start)。
    tools: [
      ...run.tools.filter((existing) => existing.id !== tool.toolCallId),
      {
        id: tool.toolCallId,
        toolName: tool.toolName,
        args: tool.args,
        status: 'running',
        startedAt: timestamp,
      } satisfies RunToolRecord,
    ],
  }))
}

export function updateToolResult(
  runs: RunRecord[],
  runId: string | null,
  toolCallId: string,
  partialResult: unknown,
): RunRecord[] {
  return patch(runs, runId, (run) => ({
    ...run,
    tools: run.tools.map((tool) =>
      tool.id === toolCallId ? { ...tool, result: partialResult } : tool,
    ),
  }))
}

export function endTool(
  runs: RunRecord[],
  runId: string | null,
  tool: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean },
  timestamp: string,
): RunRecord[] {
  return patch(runs, runId, (run) => ({
    ...run,
    tools: run.tools.map((existing) =>
      existing.id === tool.toolCallId
        ? {
            ...existing,
            toolName: tool.toolName,
            status: tool.isError ? 'error' : 'done',
            result: tool.result,
            endedAt: timestamp,
          }
        : existing,
    ),
  }))
}
