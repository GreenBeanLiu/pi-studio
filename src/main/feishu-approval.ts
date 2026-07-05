import { backendEnvPath } from './app-env'

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis'
const FEISHU_APP_ID_ENV = 'FEISHU_APP_ID'
const FEISHU_APP_SECRET_ENV = 'FEISHU_APP_SECRET'

type FeishuTenantTokenResponse = {
  code: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}

type FeishuApiResponse<T> = {
  code: number
  msg?: string
  data?: T
}

export type FeishuApprovalDemoInput = {
  approvalCode: string
  userId: string
  formJson: string
  nodeApproversJson?: string
  dryRun?: boolean
}

export type FeishuConfigStatus = {
  appIdConfigured: boolean
  appSecretConfigured: boolean
  envFilePath: string
}

export type FeishuApprovalDemoPayload = {
  approval_code: string
  user_id: string
  form: string
  uuid: string
  node_approver_user_id_list?: unknown
}

export type FeishuApprovalDemoResult = {
  ok: true
  dryRun: boolean
  payload: FeishuApprovalDemoPayload
  response?: unknown
}

function required(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} 不能为空`)
  return trimmed
}

function parseJsonField(value: string, label: string): unknown {
  try {
    return JSON.parse(required(value, label))
  } catch (err) {
    throw new Error(`${label} 不是合法 JSON: ${(err as Error).message}`)
  }
}

export function buildFeishuApprovalDemoPayload(
  input: FeishuApprovalDemoInput,
): FeishuApprovalDemoPayload {
  const form = parseJsonField(input.formJson, '审批表单 JSON')
  if (!Array.isArray(form)) throw new Error('审批表单 JSON 必须是数组')

  const payload: FeishuApprovalDemoPayload = {
    approval_code: required(input.approvalCode, 'Approval Code'),
    user_id: required(input.userId, '申请人 user_id'),
    form: JSON.stringify(form),
    uuid: `pi-studio-${Date.now()}`,
  }

  if (input.nodeApproversJson?.trim()) {
    payload.node_approver_user_id_list = parseJsonField(
      input.nodeApproversJson,
      '节点审批人 JSON',
    )
  }

  return payload
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) return {} as T

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`飞书返回了非 JSON 响应: HTTP ${response.status} ${text.slice(0, 300)}`)
  }
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const response = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: required(appId, 'App ID'),
      app_secret: required(appSecret, 'App Secret'),
    }),
  })
  const data = await readJsonResponse<FeishuTenantTokenResponse>(response)

  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(data.msg || `获取 tenant_access_token 失败: HTTP ${response.status}`)
  }

  return data.tenant_access_token
}

function getFeishuAppConfig(): { appId: string; appSecret: string } {
  const appId = process.env[FEISHU_APP_ID_ENV]?.trim() ?? ''
  const appSecret = process.env[FEISHU_APP_SECRET_ENV]?.trim() ?? ''

  if (!appId || !appSecret) {
    throw new Error(
      `飞书 App 配置缺失，请在后台 env 配置 ${FEISHU_APP_ID_ENV} 和 ${FEISHU_APP_SECRET_ENV}。本机 env 文件：${backendEnvPath()}`,
    )
  }

  return { appId, appSecret }
}

export function getFeishuConfigStatus(): FeishuConfigStatus {
  return {
    appIdConfigured: !!process.env[FEISHU_APP_ID_ENV]?.trim(),
    appSecretConfigured: !!process.env[FEISHU_APP_SECRET_ENV]?.trim(),
    envFilePath: backendEnvPath(),
  }
}

export async function submitFeishuApprovalDemo(
  input: FeishuApprovalDemoInput,
): Promise<FeishuApprovalDemoResult> {
  const payload = buildFeishuApprovalDemoPayload(input)

  if (input.dryRun) {
    return { ok: true, dryRun: true, payload }
  }

  const { appId, appSecret } = getFeishuAppConfig()
  const token = await getTenantAccessToken(appId, appSecret)
  const response = await fetch(`${FEISHU_API_BASE}/approval/v4/instances?user_id_type=user_id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  })
  const data = await readJsonResponse<FeishuApiResponse<unknown>>(response)

  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `创建审批实例失败: HTTP ${response.status}`)
  }

  return { ok: true, dryRun: false, payload, response: data.data ?? data }
}
