import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const distDir = join(root, 'dist')

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const skipBuild = args.has('--skip-build')
const installAfterPublish = args.has('--install')
const allowDirty = args.has('--allow-dirty')
const help = args.has('--help') || args.has('-h')

if (help) {
  console.log(`
Usage: node scripts/release-local.mjs [options]

Options:
  --dry-run       Print commands without running them
  --skip-build    Reuse current dist/ artifacts
  --install       Silently install the generated setup exe after publishing
  --allow-dirty   Allow releasing with uncommitted working-tree changes
  --help          Show this message
`)
  process.exit(0)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

const pkg = readJson(join(root, 'package.json'))
const version = pkg.version
const tag = `v${version}`
const productName = pkg.build?.productName ?? pkg.name
const publish = pkg.build?.publish
const owner = publish?.owner
const repo = publish?.repo

if (!version || !owner || !repo) {
  throw new Error('package.json must define version and build.publish owner/repo')
}

function logStep(message) {
  console.log(`\n==> ${message}`)
}

function run(command, commandArgs, options = {}) {
  const printable = [command, ...commandArgs].join(' ')
  if (dryRun) {
    console.log(`[dry-run] ${printable}`)
    return ''
  }

  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf-8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`${printable} failed${output ? `\n${output}` : ''}`)
  }

  return result.stdout?.trim() ?? ''
}

function output(command, commandArgs) {
  return run(command, commandArgs, { capture: true })
}

function commandExists(command, commandArgs = ['--version']) {
  if (dryRun) return true
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf-8',
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

function assertCleanTree() {
  if (allowDirty || dryRun) return
  const status = output('git', ['status', '--porcelain'])
  if (status) {
    throw new Error(`Working tree is dirty. Commit or stash changes before release:\n${status}`)
  }
}

function ensureTag() {
  const hasTag = dryRun ? false : spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
    cwd: root,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  }).status === 0

  if (!hasTag) run('git', ['tag', tag])
}

function pushHeadAndTag() {
  run('git', ['push', 'origin', 'HEAD'])
  run('git', ['push', 'origin', tag])
}

function parseLatestYml() {
  const latestPath = join(distDir, 'latest.yml')
  if (!existsSync(latestPath)) throw new Error('dist/latest.yml was not generated')

  const content = readFileSync(latestPath, 'utf-8')
  const latestVersion = content.match(/^version:\s*(.+)$/m)?.[1]?.trim()
  const artifactPath = content.match(/^path:\s*(.+)$/m)?.[1]?.trim()
  const size = Number(content.match(/^\s*size:\s*(\d+)$/m)?.[1])
  const sha512 = content.match(/^sha512:\s*(.+)$/m)?.[1]?.trim()

  if (!latestVersion || !artifactPath || !Number.isFinite(size) || !sha512) {
    throw new Error('dist/latest.yml is missing version/path/size/sha512')
  }
  if (latestVersion !== version) {
    throw new Error(`latest.yml version ${latestVersion} does not match package version ${version}`)
  }

  return { artifactPath, size, sha512 }
}

function sha512Base64(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

function findSetupExe(targetFileName) {
  const candidates = [
    join(distDir, targetFileName),
    join(distDir, `${productName} Setup ${version}.exe`),
    join(distDir, `${pkg.name} Setup ${version}.exe`),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(`Could not find setup exe. Checked:\n${candidates.join('\n')}`)
  }
  return found
}

function prepareArtifacts() {
  const latest = parseLatestYml()
  const targetExe = join(distDir, latest.artifactPath)
  const sourceExe = findSetupExe(latest.artifactPath)

  const actualSize = statSync(sourceExe).size
  const actualSha512 = sha512Base64(sourceExe)
  if (actualSize !== latest.size) {
    throw new Error(`latest.yml size ${latest.size} does not match ${sourceExe} size ${actualSize}`)
  }
  if (actualSha512 !== latest.sha512) {
    throw new Error(`latest.yml sha512 does not match ${sourceExe}`)
  }

  if (sourceExe !== targetExe) copyFileSync(sourceExe, targetExe)

  const targetBlockmap = `${targetExe}.blockmap`
  const sourceBlockmap = `${sourceExe}.blockmap`
  if (existsSync(sourceBlockmap) && sourceBlockmap !== targetBlockmap) {
    copyFileSync(sourceBlockmap, targetBlockmap)
  }
  if (!existsSync(targetBlockmap)) {
    throw new Error(`Missing blockmap: ${targetBlockmap}`)
  }

  return {
    latestYml: join(distDir, 'latest.yml'),
    exe: targetExe,
    blockmap: targetBlockmap,
    exeSize: actualSize,
  }
}

function releaseExists() {
  if (dryRun) return false
  const result = spawnSync('gh', ['release', 'view', tag], {
    cwd: root,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

function publishRelease(artifacts) {
  const notes = `pi-studio ${version} release.`
  const assetArgs = [artifacts.exe, artifacts.blockmap, artifacts.latestYml]

  if (releaseExists()) {
    run('gh', ['release', 'upload', tag, ...assetArgs, '--clobber'])
  } else {
    run('gh', [
      'release',
      'create',
      tag,
      ...assetArgs,
      '--title',
      `pi-studio ${tag}`,
      '--notes',
      notes,
      '--latest',
    ])
  }
}

function verifyRelease(artifacts) {
  const json = output('gh', ['release', 'view', tag, '--json', 'assets,isDraft,isPrerelease,url'])
  if (dryRun) return
  const release = JSON.parse(json)
  if (release.isDraft || release.isPrerelease) {
    throw new Error(`${tag} is draft or prerelease`)
  }

  const names = new Map(release.assets.map((asset) => [asset.name, asset]))
  for (const expected of [artifacts.exe, artifacts.blockmap, artifacts.latestYml].map((p) => p.split(/[\\/]/).pop())) {
    if (!names.has(expected)) throw new Error(`Release ${tag} is missing asset ${expected}`)
  }

  const exeName = artifacts.exe.split(/[\\/]/).pop()
  const uploadedExe = names.get(exeName)
  if (uploadedExe.size !== artifacts.exeSize) {
    throw new Error(`Uploaded exe size ${uploadedExe.size} does not match local size ${artifacts.exeSize}`)
  }

  console.log(`Release verified: ${release.url}`)
}

function installSilently(artifacts) {
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Start-Process -FilePath '${artifacts.exe.replace(/'/g, "''")}' -ArgumentList '/S' -Wait -WindowStyle Hidden`,
  ])
}

logStep(`Preparing pi-studio ${tag}`)
if (!commandExists('git')) throw new Error('git is not available')
if (!commandExists('gh')) throw new Error('gh is not available or not logged in')
if (!skipBuild && !commandExists('pnpm')) throw new Error('pnpm is not available')
assertCleanTree()

if (!skipBuild) {
  logStep('Cleaning dist and building Windows installer')
  if (!dryRun) {
    rmSync(distDir, { recursive: true, force: true })
    mkdirSync(distDir, { recursive: true })
  }
  run('pnpm', ['run', 'check:text'])
  run('pnpm', ['run', 'build'])
  run('pnpm', ['exec', 'electron-builder', '--win', '--publish', 'never'])
}

logStep('Verifying and normalizing release artifacts')
const artifacts = dryRun
  ? {
      latestYml: join(distDir, 'latest.yml'),
      exe: join(distDir, `${productName}-Setup-${version}.exe`),
      blockmap: join(distDir, `${productName}-Setup-${version}.exe.blockmap`),
      exeSize: 0,
    }
  : prepareArtifacts()

logStep('Tagging and pushing current HEAD')
ensureTag()
pushHeadAndTag()

logStep(`Publishing ${tag} to ${owner}/${repo}`)
publishRelease(artifacts)

logStep('Verifying uploaded release')
verifyRelease(artifacts)

if (installAfterPublish) {
  logStep('Installing generated setup silently')
  installSilently(artifacts)
}

console.log(`\nDone: ${tag}`)
