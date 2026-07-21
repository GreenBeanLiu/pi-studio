// 兼容层:类型的唯一定义在 shared/ipc/contract.ts,这里只做再导出,
// 让既有组件的 `from '../lib/api'` 保持可用。
export type * from '../../../shared/ipc/contract'

import type { DesktopApi } from '../../../shared/ipc/contract'

declare global {
  interface Window {
    api: DesktopApi
  }
}

export const api = window.api
