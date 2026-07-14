import { app, ipcMain } from 'electron'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { spawn } from 'child_process'
import { loadRpcClient, resolvePiCliPath, embeddedNodeEnv } from './pi-client'
import { loadSettings, apiKeyEnvVar, agentConfigDir, writeModelsOverride } from './settings'
import {
  modelsDir,
  loadHistory,
  saveHistory,
  localFileUrl,
  broadcast,
  type Model3DHistoryItem,
  type Model3DResult,
} from './model3d'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 第三种 3D 引擎「代码建模」:不走 Tripo,由内嵌的 pi agent 程序化手搓
 * three.js 几何,导出成 glb(与 Tripo 产物同格式,复用 viewer/历史/下载)。
 * agent 在一个预置了 build-model.mjs 骨架的工作目录里编辑 buildModel() 函数;
 * three + GLTFExporter 由 resources/model-export 的预打包 bundle 提供(避免把
 * three 塞进 dependencies)。最终导出由 pi-studio 用 embedded node 权威执行,
 * 不依赖目标机的系统 node。产物是"可动画/可拆解"的代码资产(Group 层级 + userData)。
 */

const AGENT_TIMEOUT_MS = 12 * 60_000

/** 预打包的 three + GLTFExporter bundle 的 file:// URL(骨架 import 它)。 */
function bundleUrl(): string {
  return pathToFileURL(
    join(app.getAppPath(), 'resources', 'model-export', 'three-gltf-bundle.mjs'),
  ).href
}

function workDir(id: string): string {
  const d = join(app.getPath('userData'), 'code-models', id)
  mkdirSync(d, { recursive: true })
  return d
}

/** build-model.mjs 骨架:agent 只改 buildModel 函数体,顶部 polyfill/import 与底部导出勿动。 */
function skeleton(): string {
  return `// 3D 代码建模骨架 —— 只编辑 buildModel() 函数体。
// 运行(自测): node build-model.mjs test.glb  → 应打印 "MODEL_OK ..."
// GLTFExporter 的 binary 模式在浏览器用 FileReader,node 无此 API,下面补一个最小 polyfill。
globalThis.FileReader = class {
  #done(result) {
    this.result = result
    this.onload && this.onload({ target: this })
    this.onloadend && this.onloadend({ target: this })
  }
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((ab) => this.#done(ab)) }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((ab) =>
      this.#done('data:' + (blob.type || '') + ';base64,' + Buffer.from(ab).toString('base64')),
    )
  }
}

import { THREE, GLTFExporter } from ${JSON.stringify(bundleUrl())}
import { writeFileSync } from 'node:fs'

/**
 * 手搓程序化 three.js 模型,返回一个 THREE.Object3D(通常是 Group)。
 * - 可动画/可拆解:每个独立部件放各自的 THREE.Group(作为 pivot 节点),mesh 作为其 child;
 *   在 group.userData 里标注 { pivot, axis, ... } 等语义,方便之后绑定动画/拆解。
 * - 不要用位图纹理 / CanvasTexture(node 导出没有 canvas 会失败);用纯色、顶点色,
 *   或 MeshStandardMaterial 的 color/metalness/roughness 参数表达材质。
 */
function buildModel(THREE) {
  const root = new THREE.Group()
  root.name = 'Model'
  // TODO: 在这里实现几何
  root.add(
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xcccccc })),
  )
  return root
}

// === 以下为导出逻辑,请勿修改 ===
const out = process.argv[2] || 'model.glb'
const root = buildModel(THREE)
new GLTFExporter().parse(
  root,
  (result) => {
    writeFileSync(out, Buffer.from(result))
    console.log('MODEL_OK ' + out)
  },
  (err) => {
    console.error('MODEL_FAIL ' + (err && err.message ? err.message : err))
    process.exit(1)
  },
  { binary: true },
)
`
}

function agentPrompt(prompt: string): string {
  return `你在一个已经准备好的工作目录里,里面有 build-model.mjs。请用纯代码(three.js)程序化地构建下面描述的 3D 模型:

"${prompt}"

要求:
- 只修改 build-model.mjs 里的 buildModel(THREE) 函数体;不要改动文件顶部的 polyfill/import 和底部的导出逻辑。
- 参考 object-to-threejs-procedural skill 的方法:先搭整体轮廓与比例,再加部件,再补细节,分步推进。
- 做成"可动画/可拆解":每个能独立运动的部件放各自的 THREE.Group(pivot 节点),mesh 作为其 child,并在 group.userData 里标注 pivot/axis 等语义。
- 不要用位图纹理或 CanvasTexture(node 导出没有 canvas 会失败);用纯色、顶点色或 MeshStandardMaterial 的参数表达材质。
- 每改一版就运行 \`node build-model.mjs test.glb\` 自测,确保打印 MODEL_OK 且无报错,反复修正直到稳定成功。
- 完成后清理掉 test.glb 等临时产物,只保留改好的 build-model.mjs。`
}

/** 用 embedded node(不依赖系统 node)权威执行骨架,产出最终 glb。 */
function runExport(scriptPath: string, glbOut: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, glbOut], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && existsSync(glbOut)) resolve()
      else reject(new Error(`导出失败(code ${code}): ${stderr.slice(0, 400) || '未生成模型文件'}`))
    })
  })
}

async function generateCodeModel(payload: { prompt: string }): Promise<Model3DResult> {
  const prompt = (payload.prompt ?? '').trim()
  if (!prompt) return { error: '请输入模型描述' }
  const settings = loadSettings()
  if (!settings.apiKey) return { error: '代码建模需要在「设置 → 模型」里配置 API Key' }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const dir = workDir(id)
  const scriptPath = join(dir, 'build-model.mjs')
  const glbOut = join(modelsDir(), `${id}.glb`)
  const pr = (status: string): void =>
    broadcast('model3d:progress', { id, status, progress: 0, prompt, mode: 'code' })

  try {
    writeFileSync(scriptPath, skeleton(), 'utf-8')
    pr('building')

    writeModelsOverride(
      settings.provider,
      settings.baseUrl,
      !!settings.heliconeApiKey,
      settings.customModelIds,
    )
    const RpcClient = await loadRpcClient()
    const env = embeddedNodeEnv({
      [apiKeyEnvVar(settings.provider)]: settings.apiKey,
      PI_CODING_AGENT_DIR: agentConfigDir(),
    })
    const client = new RpcClient({
      cwd: dir,
      env,
      provider: settings.provider,
      model: settings.model || undefined,
      cliPath: resolvePiCliPath(),
    })
    await client.start()
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          off()
          reject(new Error(`代码建模超时(${AGENT_TIMEOUT_MS / 60000} 分钟)`))
        }, AGENT_TIMEOUT_MS)
        const off = client.onEvent((e: { type?: string }) => {
          if (e?.type === 'agent_end') {
            clearTimeout(timer)
            off()
            resolve()
          }
        })
        client.prompt(agentPrompt(prompt)).catch((err: unknown) => {
          clearTimeout(timer)
          off()
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })
    } finally {
      await client.stop().catch(() => {})
    }

    pr('exporting')
    await runExport(scriptPath, glbOut)

    const item: Model3DHistoryItem = {
      id,
      prompt,
      mode: 'code',
      modelUrl: localFileUrl(glbOut),
      thumbnailUrl: null,
      createdAt: Date.now(),
    }
    saveHistory([item, ...loadHistory()])
    broadcast('model3d:progress', { id, status: 'done', progress: 100, prompt, mode: 'code' })
    return item
  } catch (err) {
    appendAppLog('error', 'codeModel.generate', '代码建模失败', normalizeError(err))
    broadcast('model3d:progress', { id, status: 'error', progress: 0, prompt, mode: 'code' })
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerCodeModel(): void {
  ipcMain.handle('model3d:generateCode', (_e, payload: { prompt: string }) =>
    generateCodeModel(payload),
  )
}
