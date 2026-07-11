import { app, ipcMain, safeStorage, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHmac, randomUUID } from 'crypto'
import { loadSettings } from './settings'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 通知渠道注册表:渠道是配置数据,不是代码分支。
 * 例行任务的 notify 节点和跑完后的兜底通知都通过 sendToChannel 出去,
 * 加渠道 = 加一个 adapter case,不碰执行器。
 */

export type Channel = { id: string; name: string } & (
  | { type: 'feishu-webhook'; url: string; secret?: string }
  | { type: 'feishu-app'; appId: string; appSecret: string; chatId?: string }
  | { type: 'webhook'; url: string }
  | { type: 'local' }
)

export type ChannelType = Channel['type']

export type NotifyPayload = {
  title: string
  status: 'ok' | 'error' | 'timeout' | 'info'
  /** 正文,飞书按 lark_md 渲染,通用 webhook 原样放进 JSON */
  markdown: string
  imageUrls?: string[]
}

const channelsPath = (): string => join(app.getPath('userData'), 'channels.json')

/** 整个数组当一个 blob 加密(渠道配置里混着密钥,逐字段加密太啰嗦) */
export function saveChannels(channels: Channel[]): Channel[] {
  const json = JSON.stringify(channels)
  const data = safeStorage.isEncryptionAvailable()
    ? { enc: safeStorage.encryptString(json).toString('base64') }
    : { channels }
  writeFileSync(channelsPath(), JSON.stringify(data, null, 2), 'utf8')
  return channels
}

export function loadChannels(): Channel[] {
  try {
    if (!existsSync(channelsPath())) return migrateFromSettings()
    const raw = JSON.parse(readFileSync(channelsPath(), 'utf8')) as {
      enc?: string
      channels?: Channel[]
    }
    if (raw.enc && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.enc, 'base64'))) as Channel[]
    }
    return raw.channels ?? []
  } catch (err) {
    appendAppLog('warn', 'channels.load', 'Failed to load channels', normalizeError(err))
    return []
  }
}

/** 首次运行:把老的 settings 里的飞书配置搬成渠道,外加一个本地通知渠道。 */
function migrateFromSettings(): Channel[] {
  const s = loadSettings()
  const channels: Channel[] = []
  if (s.feishuWebhookUrl.trim()) {
    channels.push({
      id: randomUUID(),
      name: '飞书群机器人',
      type: 'feishu-webhook',
      url: s.feishuWebhookUrl.trim(),
      ...(s.feishuSecret.trim() ? { secret: s.feishuSecret.trim() } : {}),
    })
  }
  if (s.feishuAppId.trim() && s.feishuAppSecret.trim()) {
    channels.push({
      id: randomUUID(),
      name: '飞书应用',
      type: 'feishu-app',
      appId: s.feishuAppId.trim(),
      appSecret: s.feishuAppSecret.trim(),
      ...(s.feishuChatId.trim() ? { chatId: s.feishuChatId.trim() } : {}),
    })
  }
  channels.push({ id: randomUUID(), name: '系统通知', type: 'local' })
  saveChannels(channels)
  return channels
}

// ── 发送 ─────────────────────────────────────────────────────────

export async function sendToChannel(channel: Channel, payload: NotifyPayload): Promise<void> {
  switch (channel.type) {
    case 'feishu-webhook':
      return postFeishuWebhook(channel.url, channel.secret ?? '', buildFeishuCard(payload))
    case 'feishu-app':
      return sendFeishuViaApp(channel, buildFeishuCard(payload))
    case 'webhook': {
      const res = await fetch(channel.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'pi-studio',
          title: payload.title,
          status: payload.status,
          markdown: payload.markdown,
          imageUrls: payload.imageUrls ?? [],
          ts: Date.now(),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`Webhook ${res.status}`)
      return
    }
    case 'local': {
      if (Notification.isSupported()) {
        new Notification({ title: payload.title, body: payload.markdown.slice(0, 150) }).show()
      }
      return
    }
  }
}

// ── 飞书卡片 ─────────────────────────────────────────────────────

type FeishuCard = Record<string, unknown>

const HEADER_TEMPLATE: Record<NotifyPayload['status'], string> = {
  ok: 'green',
  error: 'red',
  timeout: 'orange',
  info: 'blue',
}

function buildFeishuCard(payload: NotifyPayload): FeishuCard {
  const imageLines = (payload.imageUrls ?? []).map((u, i) => `[🖼 图片 ${i + 1}](${u})`).join('\n')
  return {
    header: {
      template: HEADER_TEMPLATE[payload.status],
      title: { tag: 'plain_text', content: payload.title },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: payload.markdown.slice(0, 3000) } },
      ...(imageLines ? [{ tag: 'div', text: { tag: 'lark_md', content: imageLines } }] : []),
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `pi-studio · ${new Date().toLocaleString()}` }],
      },
    ],
  }
}

/**
 * 群自定义机器人 webhook。加签是飞书的怪规矩:
 * HMAC-SHA256 的 *key* 是 `${timestamp}\n${secret}`,消息体为空串,结果 base64。
 */
async function postFeishuWebhook(url: string, secret: string, card: FeishuCard): Promise<void> {
  const body: Record<string, unknown> = { msg_type: 'interactive', card }
  if (secret.trim()) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    body.timestamp = timestamp
    body.sign = createHmac('sha256', `${timestamp}\n${secret.trim()}`).update('').digest('base64')
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json().catch(() => null)) as { code?: number; StatusCode?: number; msg?: string } | null
  const okCode = data ? (data.code ?? data.StatusCode) === 0 : res.ok
  if (!res.ok || !okCode) throw new Error(`Feishu webhook ${res.status}: ${data?.msg ?? '(no message)'}`)
}

// ── 飞书应用模式:tenant_access_token → im/v1/messages ────────────

let feishuTokenCache: { appId: string; token: string; expiresAt: number } | null = null

async function feishuJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown> & { code?: number; msg?: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { code?: number; msg?: string })
    | null
  if (!data) throw new Error(`Feishu API ${res.status}: empty response`)
  if (data.code !== 0) throw new Error(`Feishu API ${data.code}: ${data.msg ?? '(no message)'}`)
  return data
}

async function getFeishuTenantToken(appId: string, appSecret: string): Promise<string> {
  if (feishuTokenCache && feishuTokenCache.appId === appId && Date.now() < feishuTokenCache.expiresAt) {
    return feishuTokenCache.token
  }
  const data = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const token = data.tenant_access_token as string
  const expire = typeof data.expire === 'number' ? data.expire : 7200
  feishuTokenCache = { appId, token, expiresAt: Date.now() + (expire - 300) * 1000 }
  return token
}

async function resolveFeishuChatId(token: string, preferred?: string): Promise<string> {
  if (preferred?.trim()) return preferred.trim()
  const data = await feishuJson('https://open.feishu.cn/open-apis/im/v1/chats?page_size=20', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const items = (data.data as { items?: Array<{ chat_id?: string }> } | undefined)?.items ?? []
  const chatId = items[0]?.chat_id
  if (!chatId) throw new Error('机器人还没加进任何群:在飞书群里「设置→群机器人→添加机器人」选这个应用')
  return chatId
}

async function sendFeishuViaApp(
  channel: Extract<Channel, { type: 'feishu-app' }>,
  card: FeishuCard,
): Promise<void> {
  const token = await getFeishuTenantToken(channel.appId, channel.appSecret)
  const receiveId = await resolveFeishuChatId(token, channel.chatId)
  await feishuJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  })
}

// ── 注册 ─────────────────────────────────────────────────────────

export function registerChannels(): void {
  ipcMain.handle('channels:list', () => loadChannels())

  ipcMain.handle('channels:save', (_e, channels: Channel[]) => {
    const cleaned = (channels ?? []).filter((c) => c.name?.trim() && c.type)
    return saveChannels(cleaned.map((c) => ({ ...c, id: c.id || randomUUID() })))
  })

  // 用传入的(可能还没保存的)渠道配置发一条测试消息
  ipcMain.handle('channels:test', async (_e, channel: Channel) => {
    try {
      await sendToChannel(channel, {
        title: '🔔 pi-studio 测试消息',
        status: 'info',
        markdown: '通知渠道配置成功,例行任务的执行结果会推送到这里。',
      })
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
