import { describe, expect, it } from 'vitest'
import { isMissingUpdateChannel } from './update-error'

describe('isMissingUpdateChannel', () => {
  it('recognises the missing platform manifest electron-updater reports', () => {
    // 线上的原话(mac 版每次启动都撞一次):release 里只有 Windows 产物
    const error = new Error(
      'Cannot find latest-mac.yml in the latest release artifacts ' +
        '(https://github.com/GreenBeanLiu/pi-studio/releases/download/v0.11.3/latest-mac.yml): HttpError: 404',
    )
    expect(isMissingUpdateChannel(error)).toBe(true)
  })

  it('also covers the other platforms so this never becomes mac-only', () => {
    expect(isMissingUpdateChannel(new Error('Cannot find latest.yml in the latest release'))).toBe(true)
    expect(isMissingUpdateChannel(new Error('Cannot find latest-linux.yml in the latest release'))).toBe(true)
  })

  // 真故障还得报出来,否则这个改动就成了「把所有更新问题都藏起来」
  it('keeps real failures visible', () => {
    expect(isMissingUpdateChannel(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false)
    expect(isMissingUpdateChannel(new Error('HttpError: 403 Forbidden'))).toBe(false)
    expect(isMissingUpdateChannel(new Error('Cannot parse update info'))).toBe(false)
    expect(isMissingUpdateChannel(new Error('ZIP file not found'))).toBe(false)
  })

  it('does not choke on a non-Error rejection', () => {
    expect(isMissingUpdateChannel('boom')).toBe(false)
    expect(isMissingUpdateChannel(undefined)).toBe(false)
  })
})
