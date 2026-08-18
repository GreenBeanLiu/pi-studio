/**
 * 更新检查的失败分两种,不能一视同仁地弹给用户。
 *
 * 一种是「这个平台压根没有发布通道」:release 里只传了 Windows 产物,mac 版启动后
 * 去要 latest-mac.yml 就是 404。用户对此无能为力 —— 报错只是每次启动吓一跳。
 * (mac 版一直是本地出包手动装的;要真做 mac 自动更新得先有 Developer ID 证书,
 * 开发证书签出来的包 Squirrel.Mac 装不上。)
 *
 * 另一种是真故障(网络、权限、清单损坏),那个该报。
 */
export function isMissingUpdateChannel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // electron-updater 找不到平台清单时的原话:
  // "Cannot find latest-mac.yml in the latest release artifacts (...): HttpError: 404"
  return /Cannot find [\w.-]+\.yml in the latest release/i.test(message)
}
