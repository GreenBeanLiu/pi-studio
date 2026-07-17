import { describe, expect, it } from 'vitest'
import {
  BLENDER_MCP_ADDON_SHA256,
  addonSha256,
  blenderAddonPath,
  buildBlenderBootstrapScript,
  parseBlenderVersion,
  verifyPinnedAddon,
} from './blender-setup-core'

describe('blender setup core', () => {
  it('parses Blender major.minor from version output and install paths', () => {
    expect(parseBlenderVersion('Blender 5.1.0\n')).toBe('5.1')
    expect(parseBlenderVersion('D:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe')).toBe('4.3')
    expect(parseBlenderVersion('not blender')).toBeNull()
  })

  it('targets Blender legacy user addon directory with a stable module name', () => {
    expect(blenderAddonPath('C:\\Users\\me\\AppData\\Roaming', '5.1')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Blender Foundation\\Blender\\5.1\\scripts\\addons\\blender_mcp.py',
    )
  })

  it('rejects bytes that do not match the pinned addon digest', () => {
    const bytes = Buffer.from('not the addon')
    expect(addonSha256(bytes)).not.toBe(BLENDER_MCP_ADDON_SHA256)
    expect(verifyPinnedAddon(bytes)).toBe(false)
  })

  it('enables the addon persistently, disables telemetry and starts port 9876', () => {
    const script = buildBlenderBootstrapScript()
    expect(script).toContain('addon_utils.enable(MODULE, default_set=True, persistent=True)')
    expect(script).toContain('telemetry_consent = False')
    expect(script).toContain('scene.blendermcp_port = 9876')
    expect(script).toContain('bpy.ops.blendermcp.start_server()')
    expect(script).toContain('bpy.ops.wm.save_userpref()')
  })
})
