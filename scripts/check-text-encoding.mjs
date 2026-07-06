import { readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const root = process.cwd()
const scanRoots = ['src', 'docs', 'scripts', 'package.json']
const ignoredDirs = new Set(['.git', 'dist', 'node_modules', 'out'])
const scannedExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
])

const mojibakeMarkers = [
  '\\u9239',
  '\\u9225',
  '\\u7487',
  '\\u93b5',
  '\\u95b0',
  '\\u7035',
  '\\u8930',
  '\\u9365',
  '\\u7459',
  '\\u5a11',
  '\\u6d7c',
  '\\u9422',
  '\\u9354',
  '\\u6769',
  '\\u6fb6',
  '\\u5bee',
  '\\u5ae8',
  '\\u6e6a',
  '\\u68ff',
  '\\u5f47',
  '\\u5553',
  '\\u567a',
  '\\u7edb',
].map((marker) => JSON.parse(`"${marker}"`))

function listFiles(target) {
  const path = join(root, target)
  const stats = statSync(path)
  if (stats.isFile()) return [path]
  if (!stats.isDirectory()) return []

  const files = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) files.push(...listFiles(join(target, entry.name)))
      continue
    }
    files.push(join(path, entry.name))
  }
  return files
}

function shouldScan(file) {
  return scannedExtensions.has(extname(file).toLowerCase())
}

const findings = []

for (const file of scanRoots.flatMap(listFiles).filter(shouldScan)) {
  const content = readFileSync(file, 'utf-8')
  const lines = content.split(/\r?\n/)

  lines.forEach((line, index) => {
    if (line.includes('\uFFFD')) {
      findings.push({ file, line: index + 1, reason: 'replacement character', text: line })
    }

    for (const marker of mojibakeMarkers) {
      if (line.includes(marker)) {
        findings.push({ file, line: index + 1, reason: `mojibake marker ${marker}`, text: line })
        break
      }
    }
  })
}

if (findings.length > 0) {
  console.error('Potential text encoding corruption found:')
  for (const finding of findings.slice(0, 50)) {
    console.error(
      `${relative(root, finding.file)}:${finding.line} ${finding.reason}\n  ${finding.text.trim()}`,
    )
  }
  if (findings.length > 50) {
    console.error(`...and ${findings.length - 50} more findings`)
  }
  process.exit(1)
}

console.log('Text encoding check passed.')
