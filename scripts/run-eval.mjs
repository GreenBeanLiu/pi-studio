import { mkdtemp, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { build } from 'vite'

// Keep the transient bundle below the repo so externalized runtime packages and
// resolvePiCliPath() can find this installation's node_modules during live evals.
const output = await mkdtemp(join(resolve('.'), '.pi-studio-eval-cli-'))
try {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: resolve('src/main/eval-cli.ts'),
      outDir: output,
      emptyOutDir: true,
      target: 'node20',
      rollupOptions: { output: { entryFileNames: 'eval-cli.mjs' } },
    },
  })
  await import(pathToFileURL(join(output, 'eval-cli.mjs')).href)
} finally {
  await rm(output, { recursive: true, force: true })
}
