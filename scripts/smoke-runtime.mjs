import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function runRuntimeSmoke(env = process.env, run = spawnSync) {
  const deviceId = env.PI_STUDIO_SMOKE_DEVICE_ID?.trim()
  const workspace = env.PI_STUDIO_SMOKE_WORKSPACE?.trim()
  if (!deviceId || !workspace) {
    throw new Error('Set PI_STUDIO_SMOKE_DEVICE_ID and PI_STUDIO_SMOKE_WORKSPACE before running the runtime smoke')
  }

  // 控制面仓库 2026-09-16 改名 pi-studio-control-plane;还没改名的 checkout(比如 Windows 上的 D:/Works)回落到旧目录名
  const runtimePath = env.PI_STUDIO_RUNTIME_PATH
    ? resolve(root, env.PI_STUDIO_RUNTIME_PATH)
    : [resolve(root, '../pi-studio-control-plane'), resolve(root, '../personal-agent-runtime')].find((dir) => existsSync(dir))
      ?? resolve(root, '../pi-studio-control-plane')
  const python = env.PI_STUDIO_RUNTIME_PYTHON || join(
    runtimePath, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
  if (!existsSync(join(runtimePath, 'src/personal_harness/remote_smoke.py'))) {
    throw new Error(`Runtime smoke module not found in ${runtimePath}; set PI_STUDIO_RUNTIME_PATH`)
  }

  const result = run(python, [
    '-m', 'personal_harness.cli', 'smoke-pi-studio',
    '--device-id', deviceId,
    '--workspace', workspace,
    '--command', 'pwd',
    ...(env.PI_STUDIO_SMOKE_FILES === '1' ? ['--file-roundtrip'] : []),
  ], {
    cwd: runtimePath,
    env: {
      ...env,
      PYTHONPATH: [join(runtimePath, 'src'), env.PYTHONPATH].filter(Boolean).join(delimiter),
    },
    stdio: 'inherit',
    shell: false,
    timeout: 180_000,
  })
  if (result.error) throw new Error(`Runtime smoke could not finish: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`Runtime smoke failed (exit=${result.status}, signal=${result.signal ?? 'none'})`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runRuntimeSmoke()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
