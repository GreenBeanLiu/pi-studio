import { createHash } from 'crypto'
import { join } from 'path'

export const BLENDER_MCP_COMMIT = '6641189231caf3752302ae20591bc87fda85fc4e'
export const BLENDER_MCP_ADDON_URL =
  `https://raw.githubusercontent.com/ahujasid/blender-mcp/${BLENDER_MCP_COMMIT}/addon.py`
export const BLENDER_MCP_ADDON_SHA256 =
  'bba60831f5f89a74deda0294b131668a086cf46eb35a6a01abbd0d21d9e92630'
export const BLENDER_MCP_MODULE = 'blender_mcp'

export function addonSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function verifyPinnedAddon(bytes: Uint8Array): boolean {
  return addonSha256(bytes) === BLENDER_MCP_ADDON_SHA256
}

/** Blender --version 输出和标准安装目录都可解析。只保留用户配置目录使用的 major.minor。 */
export function parseBlenderVersion(value: string): string | null {
  const match = value.match(/Blender(?:\s+|[^\d]+)(\d+)\.(\d+)/i)
  return match ? `${match[1]}.${match[2]}` : null
}

export function blenderAddonPath(appDataPath: string, version: string): string {
  return join(
    appDataPath,
    'Blender Foundation',
    'Blender',
    version,
    'scripts',
    'addons',
    `${BLENDER_MCP_MODULE}.py`,
  )
}

export function buildBlenderBootstrapScript(): string {
  return `import bpy
import addon_utils
import traceback

MODULE = ${JSON.stringify(BLENDER_MCP_MODULE)}

try:
    addon_utils.modules_refresh()
    addon_utils.enable(MODULE, default_set=True, persistent=True)
    addon = bpy.context.preferences.addons.get(MODULE)
    if addon and hasattr(addon.preferences, "telemetry_consent"):
        addon.preferences.telemetry_consent = False
    scene = bpy.context.scene
    if hasattr(scene, "blendermcp_port"):
        scene.blendermcp_port = 9876
    if not getattr(scene, "blendermcp_server_running", False):
        bpy.ops.blendermcp.start_server()
    bpy.ops.wm.save_userpref()
    print("PI_STUDIO_BLENDER_READY")
except Exception:
    print("PI_STUDIO_BLENDER_SETUP_ERROR")
    traceback.print_exc()
`
}
