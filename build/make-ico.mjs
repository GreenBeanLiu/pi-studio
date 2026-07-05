// 用源 PNG 生成多尺寸 icon.ico（内嵌 PNG，Vista+）+ icon.png(512)。
// 运行：node build/make-ico.mjs build/icon-source.png
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
let sharp
try {
  sharp = require('sharp')
} catch {
  sharp = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.pnpm', 'sharp@0.34.5', 'node_modules', 'sharp'))
}

const here = dirname(fileURLToPath(import.meta.url))
const src = process.argv[2] || join(here, 'icon-source.png')
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

function buildIco(pngs) {
  const count = pngs.length
  const headerSize = 6
  const dirSize = 16 * count
  let offset = headerSize + dirSize
  const dir = Buffer.alloc(dirSize)
  pngs.forEach((p, i) => {
    const o = i * 16
    dir[o] = p.size >= 256 ? 0 : p.size
    dir[o + 1] = p.size >= 256 ? 0 : p.size
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(p.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += p.data.length
  })
  const head = Buffer.alloc(headerSize)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(count, 4)
  return Buffer.concat([head, dir, ...pngs.map((p) => p.data)])
}

const pngs = []
for (const size of ICO_SIZES) {
  const data = await sharp(src).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  pngs.push({ size, data })
}
writeFileSync(join(here, 'icon.ico'), buildIco(pngs))
writeFileSync(join(here, 'icon.png'), await sharp(src).resize(512, 512).png().toBuffer())
console.log('wrote build/icon.ico (', ICO_SIZES.join(','), ') and build/icon.png')
