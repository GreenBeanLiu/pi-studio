# pi-studio eval driver

The eval driver runs a case in an isolated checkout/copy, records Pi runtime events, and verifies the resulting filesystem instead of trusting the model's final response.

## Case format

```json
{
  "version": 1,
  "id": "add-feature",
  "fixture": "./fixtures/add-feature",
  "prompt": "Implement the requested feature and run tests.",
  "engine": {
    "type": "pi",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "security": "host-full-access",
    "env": {
      "ANTHROPIC_API_KEY": { "fromEnv": "ANTHROPIC_API_KEY" }
    }
  },
  "timeoutMs": 600000,
  "artifacts": ["dist/**"],
  "graders": [
    { "type": "exit-code", "expected": 0 },
    { "type": "command", "executable": "pnpm", "args": ["test"] },
    { "type": "file", "path": "src/feature.ts", "contains": "export" },
    { "type": "diff", "allow": ["src/**", "tests/**"], "maxChangedFiles": 12 }
  ]
}
```

Credentials are referenced by environment-variable name and are never stored in the case or recording. `host-full-access` is explicit because the eval process is unattended; additional security profiles should fail closed until their launch adapter is implemented.

Command graders receive only the executable-search and temporary-directory variables required by the host. Additional variables must be declared with the same `{ "fromEnv": "NAME" }` binding used by engine credentials. Each command runs in its own copy of the settled workspace, so it cannot manufacture evidence for later file/diff assertions. Spawn failures, timeouts, output-limit failures, and process-tree cleanup failures are infrastructure failures; they never satisfy an expected numeric exit code. Windows commands run in a kill-on-close Job Object; Unix commands run in an owned process group, including successful exits that leave descendants behind.

## Live run and recording

```powershell
pnpm eval -- --case .\evals\add-feature.case.json --record .\evals\recordings\add-feature.json --events .\evals\runs\add-feature.jsonl
```

Every run gets a temporary workspace and a unique session ID. Git fixtures are cloned with `--no-hardlinks`; plain directories are recursively copied. Links and junctions are rejected, and file graders verify real-path containment before reading. The report contains the final response, finish reason, event frames, projected tool calls, provider token totals (including cache tokens), latency, workspace diff, artifact paths, and grader results.

The driver does not snapshot, grade, or remove a workspace until the engine confirms cleanup. Normal completion, ordinary failure, and deadline abort all terminate and confirm the owned Pi process tree. If cleanup cannot be verified, the command fails as infrastructure and retains the workspace path for diagnosis. The settled workspace is snapshotted again after grading to detect any late mutation.

## Offline replay

```powershell
pnpm eval -- --case .\tests\fixtures\eval\basic.case.json --replay .\tests\fixtures\eval\basic.recording.json
```

Replay requires no API key. Recorded provider chunks are fed into the real Pi agent loop with their recorded within-stream delays, so built-in tools execute again inside a fresh isolated workspace. Absolute references to the live checkout are stored as `${PI_STUDIO_EVAL_WORKSPACE}` and rebound to the new checkout; residual absolute tool paths outside that root fail closed. The resulting live events are folded through the production `SessionProjectionTracker`, and file/command graders verify the replayed workspace rather than trusting saved output. Every replay receives a new session ID.

Provider failures that cannot be reconstructed from chunks use an explicit sidecar:

```json
{
  "replay": {
    "providerSteps": [
      { "kind": "recorded-stream" },
      { "kind": "throw", "message": "recorded provider failure" },
      { "kind": "hang" },
      { "kind": "cancel", "message": "recorded cancellation" }
    ]
  }
}
```

`throw` models a pre-chunk provider failure. `hang` remains pending until the eval deadline and exercises cancellation/cleanup. `cancel` ends the provider stream with an aborted message. A successful recording needs no sidecar; its provider steps are inferred from assistant message start/update/end events.

Use `--keep-workspace` only for debugging. The default removes the temporary checkout after grading.
