const { app, nativeImage } = require('electron')
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { tmpdir } = require('os')
const { join, resolve } = require('path')

async function main() {
  const bundleModule = process.argv[2]
  if (!bundleModule) throw new Error('Pass the compiled app-icon-bundle module path')
  const { generateAppIconBundle } = require(resolve(bundleModule))
  const fixture = nativeImage.createFromPath(
    resolve(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'app-icon.png'),
  )
  if (fixture.isEmpty()) throw new Error('Could not load the app icon smoke fixture')

  const workspace = mkdtempSync(join(tmpdir(), 'pi-studio-icon-smoke-'))
  try {
    const master = fixture.resize({ width: 1024, height: 1024, quality: 'best' })
    writeFileSync(join(workspace, 'master.png'), master.toPNG())
    const result = await generateAppIconBundle({
      source: 'master.png',
      workspacePath: workspace,
      outputPath: 'bundle',
      appName: 'Smoke Test',
      backgroundColor: '#2563EB',
      platforms: ['android', 'ios', 'macos', 'windows'],
    })
    for (const path of [
      result.archivePath,
      join(result.outputPath, 'android', 'play-store-icon.png'),
      join(result.outputPath, 'ios', 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'),
      join(result.outputPath, 'macos', 'AppIcon.iconset', 'icon_512x512@2x.png'),
      join(result.outputPath, 'windows', 'app.ico'),
    ]) {
      if (!existsSync(path)) throw new Error(`Missing smoke output: ${path}`)
    }
    if (readFileSync(result.archivePath).readUInt32LE(0) !== 0x04034b50) {
      throw new Error('Smoke ZIP signature is invalid')
    }
    process.stdout.write(`App icon Electron smoke passed (${result.fileCount} files)\n`)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    app.exit(1)
  })
