// 预打包 three + GLTFExporter 成单文件,供「代码建模」引擎的 build-model.mjs 导入。
// three 是 devDependency(渲染层 vite 打包),不进 electron-builder 的 dependencies;
// 代码建模在独立 node 子进程里需要它,所以在这里 bundle 一份放进 resources。
// three 升级后重跑: node scripts/build-model-bundle.mjs
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// esbuild 在 pnpm 下不是顶层可解析,从其嵌套安装位置取
const esbuild = require(
  join(root, 'node_modules/.pnpm/esbuild@0.21.5/node_modules/esbuild/lib/main.js'),
)

await esbuild.build({
  stdin: {
    contents:
      "export * as THREE from 'three'\n" +
      "export { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'\n",
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: join(root, 'resources/model-export/three-gltf-bundle.mjs'),
})
console.log('model-export bundle rebuilt')
