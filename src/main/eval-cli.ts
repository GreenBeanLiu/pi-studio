import { resolve } from 'path'
import { readEvalCase, readEvalRecording, EvalDriver, writeEvalEventsJsonl, writeEvalRecording } from './eval-driver'
import { PiEvalEngine } from './pi-eval-engine'
import { PiReplayEvalEngine } from './pi-replay-eval-engine'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const casePath = option('--case')
  if (!casePath) throw new Error('Usage: pnpm eval -- --case <case.json> [--replay <recording.json>] [--record <recording.json>] [--events <events.jsonl>] [--keep-workspace]')
  const evalCase = await readEvalCase(resolve(casePath))
  const replayPath = option('--replay')
  const engine = replayPath
    ? new PiReplayEvalEngine(await readEvalRecording(resolve(replayPath)))
    : new PiEvalEngine()
  const report = await new EvalDriver(process.argv.includes('--keep-workspace')).run(evalCase, engine)
  const eventsPath = option('--events')
  if (eventsPath) await writeEvalEventsJsonl(resolve(eventsPath), report.events)
  const recordPath = option('--record')
  if (recordPath) await writeEvalRecording(resolve(recordPath), report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.passed ? 0 : 1
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 2
})
