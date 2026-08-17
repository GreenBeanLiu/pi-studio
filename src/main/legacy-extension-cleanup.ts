import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { agentConfigDir } from './settings'

/** Remove the generated soft-guard extension retired from the launch contract. */
export function removeLegacySecurityGuardExtension(): void {
  const file = join(agentConfigDir(), 'extensions', 'pi-studio-guard.ts')
  if (existsSync(file)) rmSync(file)
}
