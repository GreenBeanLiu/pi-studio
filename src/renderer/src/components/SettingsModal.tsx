import { useEffect, useState } from 'react'
import { createStyles, cx } from 'antd-style'
import { Alert, Input, Segmented, Button, Modal, Select, Switch, Tag, Popconfirm } from 'antd'
import { Eye, EyeOff, Bot, Globe, Info, ShieldCheck, Trash2, Plus, Image as ImageIcon } from 'lucide-react'
import {
  api,
  type Channel,
  type ChannelType,
  type PiProvider,
  type ProviderConnectionResult,
  type ProviderModelListResult,
  type SandboxDetect,
  type SandboxImageStatus,
  type SecurityPolicy,
} from '../lib/api'

type Settings = {
  provider: PiProvider
  apiKey: string
  model: string
  baseUrl: string
  favoriteModels: string
  tavilyApiKey: string
  heliconeApiKey: string
  securityGuardEnabled: boolean
  sandboxEnabled: boolean
  subagentsEnabled: boolean
  feishuWebhookUrl: string
  feishuSecret: string
  feishuAppId: string
  feishuAppSecret: string
  feishuChatId: string
  imageEngine: '' | 'comfy' | 'openai'
  comfyDir: string
  comfyPythonPath: string
  comfyLaunchArgs: string
  comfyCheckpoint: string
  cloudImageRelay: string
  cloudImageKey: string
}

type Category = 'model' | 'tools' | 'imagegen' | 'security' | 'about'

const CATEGORIES: { key: Category; label: string; icon: typeof Bot }[] = [
  { key: 'model', label: '模型服务', icon: Bot },
  { key: 'tools', label: '扩展工具', icon: Globe },
  { key: 'imagegen', label: '生图', icon: ImageIcon },
  { key: 'security', label: '安全策略', icon: ShieldCheck },
  { key: 'about', label: '关于', icon: Info },
]

const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  commandAllowlist: [],
  commandBlocklist: [],
  writeAllowlist: [],
  writeBlocklist: [],
  requireConfirmationForDangerousCommands: true,
  blockProtectedPaths: true,
  blockOutsideWorkspace: true,
}

const useStyles = createStyles(({ token, css }) => ({
  main: css`
    display: flex;
    height: 440px;
    margin: 0 -24px;
    border-top: 1px solid ${token.colorBorderSecondary};
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,

  nav: css`
    width: 148px;
    flex-shrink: 0;
    border-right: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorBgLayout};
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,

  navItem: css`
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 12px;
    border-radius: ${token.borderRadius}px;
    border: none;
    background: transparent;
    color: ${token.colorTextSecondary};
    font-size: 13px;
    font-family: ${token.fontFamily};
    cursor: pointer;
    outline: none;
    text-align: left;
    transition: all ${token.motionDurationFast};

    &:hover {
      background: ${token.colorFillTertiary};
      color: ${token.colorText};
    }
  `,

  navItemActive: css`
    background: ${token.colorFillSecondary} !important;
    color: ${token.colorText} !important;
    font-weight: 500;
  `,

  content: css`
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 20px 24px;
  `,

  form: css`
    display: flex;
    flex-direction: column;
    gap: 18px;
  `,

  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,

  label: css`
    font-size: 13px;
    font-weight: 500;
    color: ${token.colorText};
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  `,

  labelHint: css`
    font-size: 12px;
    font-weight: 400;
    color: ${token.colorTextTertiary};
  `,

  actionRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  `,

  switchItem: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,

  policyGrid: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  `,

  policyScope: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
    padding: 8px 10px;
    color: ${token.colorTextSecondary};
    font-size: 12px;
    line-height: 1.5;
  `,

  aboutRow: css`
    display: flex;
    justify-content: space-between;
    padding: 10px 0;
    font-size: 13px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};

    span:last-child {
      color: ${token.colorText};
    }
  `,

}))

export default function SettingsModal({
  onClose,
  onExportDiagnostics,
  diagnosticsDisabled,
}: {
  onClose: () => void
  onExportDiagnostics?: () => void
  diagnosticsDisabled?: boolean
}) {
  const { styles } = useStyles()

  const [category, setCategory] = useState<Category>('model')
  const [settings, setSettings] = useState<Settings>({
    provider: 'anthropic',
    apiKey: '',
    model: '',
    baseUrl: '',
    favoriteModels: '',
    tavilyApiKey: '',
    heliconeApiKey: '',
    securityGuardEnabled: true,
    sandboxEnabled: false,
    subagentsEnabled: true,
    feishuWebhookUrl: '',
    feishuSecret: '',
    feishuAppId: '',
    feishuAppSecret: '',
    feishuChatId: '',
    imageEngine: '',
    comfyDir: '',
    comfyPythonPath: '',
    comfyLaunchArgs: '',
    comfyCheckpoint: '',
    cloudImageRelay: '',
    cloudImageKey: '',
  })
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [version, setVersion] = useState('')
  const [piVersion, setPiVersion] = useState('')
  const [testingConnection, setTestingConnection] = useState(false)
  const [connectionResult, setConnectionResult] = useState<ProviderConnectionResult | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelFetchResult, setModelFetchResult] = useState<ProviderModelListResult | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelDraft, setChannelDraft] = useState<Channel | null>(null)
  const [channelTesting, setChannelTesting] = useState<string | null>(null)
  const [channelTestResult, setChannelTestResult] = useState<Record<string, string>>({})
  const [securityPolicy, setSecurityPolicy] = useState<SecurityPolicy>(DEFAULT_SECURITY_POLICY)
  const [policyScope, setPolicyScope] = useState<'default' | 'workspace'>('default')
  const [policyWorkspacePath, setPolicyWorkspacePath] = useState('')
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [sandboxDetect, setSandboxDetect] = useState<SandboxDetect | null>(null)
  const [sandboxDetecting, setSandboxDetecting] = useState(false)
  const [sandboxImage, setSandboxImage] = useState<SandboxImageStatus | null>(null)
  const [sandboxBuilding, setSandboxBuilding] = useState(false)
  const [sandboxBuildLog, setSandboxBuildLog] = useState('')

  async function detectSandbox() {
    setSandboxDetecting(true)
    try {
      const [d, img] = await Promise.all([api.sandbox.detect(), api.sandbox.imageStatus()])
      setSandboxDetect(d)
      setSandboxImage(img)
    } catch {
      setSandboxDetect(null)
    } finally {
      setSandboxDetecting(false)
    }
  }

  async function buildSandboxImage() {
    setSandboxBuilding(true)
    setSandboxBuildLog('开始构建镜像（首次约几分钟，拉取 node 基础镜像 + 安装 pi）…')
    const off = api.sandbox.onBuildProgress((line) => setSandboxBuildLog(line))
    try {
      const r = await api.sandbox.buildImage()
      if ('error' in r) {
        setSandboxBuildLog(`构建失败：${r.error}`)
      } else {
        setSandboxBuildLog('构建完成 ✓')
        await detectSandbox()
      }
    } finally {
      off()
      setSandboxBuilding(false)
    }
  }

  useEffect(() => {
    api.settings.load().then(setSettings)
    detectSandbox()
    api.channels.list().then(setChannels).catch(() => {})
    api.securityPolicy
      .load()
      .then((result) => {
        setSecurityPolicy(result.policy)
        setPolicyScope(result.scope)
        setPolicyWorkspacePath(result.workspacePath ?? '')
      })
      .catch((err) => setPolicyError((err as Error).message ?? '读取安全策略失败'))
    api.app.version().then(setVersion).catch(() => {})
    api.app.piVersion().then(setPiVersion).catch(() => {})
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      await api.settings.save(settings)
      const result = await api.securityPolicy.save(securityPolicy)
      if ('error' in result) {
        setPolicyError(result.error)
        return
      }
      setPolicyScope(result.scope)
      setPolicyWorkspacePath(result.workspacePath ?? '')
      onClose()
    } finally {
      setSaving(false)
    }
  }

  function patch(update: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...update }))
    setConnectionResult(null)
    setModelFetchResult(null)
  }

  function patchPolicy(update: Partial<SecurityPolicy>) {
    setSecurityPolicy((policy) => ({ ...policy, ...update }))
    setPolicyError(null)
  }

  function linesToRules(value: string): string[] {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  function rulesToLines(value: string[]): string {
    return value.join('\n')
  }

  const CHANNEL_TYPE_LABEL: Record<ChannelType, string> = {
    'feishu-webhook': '飞书群机器人',
    'feishu-app': '飞书应用',
    'wechat-official': '微信公众号',
    webhook: '通用 Webhook',
    local: '系统通知',
  }

  const emptyChannelDraft = (type: ChannelType): Channel => ({
    id: '',
    name: CHANNEL_TYPE_LABEL[type],
    type,
  })

  const channelDraftComplete = (c: Channel): boolean => {
    if (!c.name.trim()) return false
    if (c.type === 'feishu-webhook' || c.type === 'webhook') return !!c.url?.trim()
    if (c.type === 'feishu-app') return !!c.appId?.trim() && !!c.appSecret?.trim()
    if (c.type === 'wechat-official') return !!c.appId?.trim() && !!c.appSecret?.trim()
    return true
  }

  async function addChannel() {
    if (!channelDraft || !channelDraftComplete(channelDraft)) return
    setChannels(await api.channels.save([...channels, channelDraft]))
    setChannelDraft(null)
  }

  async function removeChannel(id: string) {
    setChannels(await api.channels.save(channels.filter((c) => c.id !== id)))
  }

  async function testChannel(channel: Channel) {
    const key = channel.id || 'draft'
    setChannelTesting(key)
    setChannelTestResult((prev) => ({ ...prev, [key]: '' }))
    try {
      const result = await api.channels.test(channel)
      setChannelTestResult((prev) => ({
        ...prev,
        [key]: 'ok' in result ? '✅ 已发送' : `❌ ${result.error}`,
      }))
    } catch (err) {
      setChannelTestResult((prev) => ({ ...prev, [key]: `❌ ${(err as Error).message ?? String(err)}` }))
    } finally {
      setChannelTesting(null)
    }
  }

  async function handleTestConnection() {
    setTestingConnection(true)
    setConnectionResult(null)
    try {
      const result = await api.settings.testConnection({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
      })
      setConnectionResult(result)
    } catch (err) {
      setConnectionResult({
        ok: false,
        message: '连接测试失败',
        details: (err as Error).message ?? String(err),
      })
    } finally {
      setTestingConnection(false)
    }
  }

  async function handleFetchModels() {
    setFetchingModels(true)
    setModelFetchResult(null)
    try {
      const result = await api.settings.listModels({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
      })
      setModelFetchResult(result)
      if (result.ok) {
        setSettings((s) => ({
          ...s,
          favoriteModels: result.models.join(','),
          model: s.model || result.models[0] || '',
        }))
      }
    } catch (err) {
      setModelFetchResult({
        ok: false,
        message: '模型读取失败',
        details: (err as Error).message ?? String(err),
      })
    } finally {
      setFetchingModels(false)
    }
  }

  return (
    <Modal
      open
      onCancel={onClose}
      title="设置"
      width={680}
      centered
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={handleSave}>
          保存设置
        </Button>,
      ]}
    >
      <div className={styles.main}>
        <div className={styles.nav}>
          {CATEGORIES.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={cx(styles.navItem, category === key && styles.navItemActive)}
              onClick={() => setCategory(key)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        <div className={styles.content}>
          {category === 'model' && (
            <div className={styles.form}>
              <div className={styles.section}>
                <span className={styles.label}>AI 提供商</span>
                <Segmented
                  value={settings.provider}
                  onChange={(v) => patch({ provider: v as PiProvider, model: '', baseUrl: '' })}
                  options={[
                    { label: 'Anthropic (Claude)', value: 'anthropic' },
                    { label: 'OpenAI', value: 'openai' },
                  ]}
                  block
                />
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  API Key
                  <span className={styles.labelHint}>本地加密存储，传给 pi CLI 子进程，不上传</span>
                </span>
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={settings.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  placeholder={settings.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                  suffix={
                    <button
                      onClick={() => setShowKey((v) => !v)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--ant-color-text-tertiary)', padding: 0 }}
                    >
                      {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  }
                />
                <div className={styles.actionRow}>
                  <Button size="small" onClick={handleTestConnection} loading={testingConnection}>
                    测试连接
                  </Button>
                  <span className={styles.labelHint}>使用当前表单内容测试，不需要先保存。</span>
                </div>
                {connectionResult && (
                  <Alert
                    type={connectionResult.ok ? 'success' : 'error'}
                    showIcon
                    message={connectionResult.message}
                    description={connectionResult.details}
                  />
                )}
              </div>

              {settings.provider === 'openai' && (
                <div className={styles.section}>
                  <span className={styles.label}>
                    API Base URL
                    <span className={styles.labelHint}>第三方兼容 OpenAI 接口时填，留空用官方</span>
                  </span>
                  <Input
                    value={settings.baseUrl}
                    onChange={(e) => patch({ baseUrl: e.target.value })}
                    placeholder="https://api.openai.com"
                  />
                </div>
              )}

              <div className={styles.section}>
                <span className={styles.label}>
                  默认模型
                  <span className={styles.labelHint}>不填则使用 pi 默认模型</span>
                </span>
                <Input
                  value={settings.model}
                  onChange={(e) => patch({ model: e.target.value })}
                  placeholder={settings.provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o'}
                />
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  模型切换列表
                  <span className={styles.labelHint}>逗号分隔，聊天页只显示这些；留空显示每家最新 8 个</span>
                </span>
                <div className={styles.actionRow}>
                  <Button size="small" onClick={handleFetchModels} loading={fetchingModels}>
                    从接口拉取模型
                  </Button>
                  <span className={styles.labelHint}>支持 OpenAI 兼容网关的 /v1/models。</span>
                </div>
                <Input.TextArea
                  value={settings.favoriteModels}
                  onChange={(e) => patch({ favoriteModels: e.target.value })}
                  placeholder="gpt-5.4, gpt-5.2, o4-mini"
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
                {modelFetchResult && (
                  <Alert
                    type={modelFetchResult.ok ? 'success' : 'error'}
                    showIcon
                    message={modelFetchResult.message}
                    description={modelFetchResult.ok ? undefined : modelFetchResult.details}
                  />
                )}
              </div>
            </div>
          )}

          {category === 'tools' && (
            <div className={styles.form}>
              <div className={styles.section}>
                <span className={styles.label}>
                  联网搜索（Tavily API Key）
                  <span className={styles.labelHint}>配置后 agent 获得 web_search 工具；留空关闭</span>
                </span>
                <Input.Password
                  value={settings.tavilyApiKey}
                  onChange={(e) => patch({ tavilyApiKey: e.target.value })}
                  placeholder="tvly-…"
                />
                <span className={styles.labelHint}>
                  修改后需重新打开工作区生效。agent 会在需要实时信息（新闻、版本号、文档）时自行调用搜索。
                </span>
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  对话日志（Helicone API Key）
                  <span className={styles.labelHint}>配置后所有对话经 Helicone 记录，可在其面板分析；留空关闭</span>
                </span>
                <Input.Password
                  value={settings.heliconeApiKey}
                  onChange={(e) => patch({ heliconeApiKey: e.target.value })}
                  placeholder="sk-helicone-…"
                />
                <span className={styles.labelHint}>
                  改后需重新打开工作区生效。经 gateway.helicone.ai 转发到你当前的 API 端点，密钥仅通过环境变量传给子进程。
                </span>
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  通知渠道
                  <span className={styles.labelHint}>工作流通知节点和兜底通知的推送目标；改动即时保存</span>
                </span>
                {channels.map((c) => {
                  const key = c.id || 'draft'
                  return (
                    <div key={c.id} className={styles.actionRow}>
                      <Tag>{CHANNEL_TYPE_LABEL[c.type]}</Tag>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name}
                      </span>
                      {channelTestResult[key] && <span className={styles.labelHint}>{channelTestResult[key]}</span>}
                      <Button size="small" loading={channelTesting === key} onClick={() => testChannel(c)}>
                        测试
                      </Button>
                      <Popconfirm title="删除这个渠道?" onConfirm={() => removeChannel(c.id)}>
                        <Button size="small" type="text" danger icon={<Trash2 size={13} />} />
                      </Popconfirm>
                    </div>
                  )
                })}
                {!channelDraft && (
                  <div className={styles.actionRow}>
                    <Button size="small" type="dashed" icon={<Plus size={13} />} onClick={() => setChannelDraft(emptyChannelDraft('feishu-webhook'))}>
                      添加渠道
                    </Button>
                  </div>
                )}
                {channelDraft && (
                  <>
                    <div className={styles.actionRow}>
                      <Select
                        value={channelDraft.type}
                        onChange={(type: ChannelType) => setChannelDraft({ ...emptyChannelDraft(type), name: channelDraft.name })}
                        style={{ width: 150 }}
                        options={(Object.keys(CHANNEL_TYPE_LABEL) as ChannelType[]).map((t) => ({
                          value: t,
                          label: CHANNEL_TYPE_LABEL[t],
                        }))}
                      />
                      <Input
                        value={channelDraft.name}
                        onChange={(e) => setChannelDraft({ ...channelDraft, name: e.target.value })}
                        placeholder="渠道名称"
                      />
                    </div>
                    {(channelDraft.type === 'feishu-webhook' || channelDraft.type === 'webhook') && (
                      <Input
                        value={channelDraft.url ?? ''}
                        onChange={(e) => setChannelDraft({ ...channelDraft, url: e.target.value })}
                        placeholder={
                          channelDraft.type === 'feishu-webhook'
                            ? 'https://open.feishu.cn/open-apis/bot/v2/hook/…'
                            : 'https://…(收到 {title,status,markdown,imageUrls} JSON)'
                        }
                      />
                    )}
                    {channelDraft.type === 'feishu-webhook' && (
                      <Input.Password
                        value={channelDraft.secret ?? ''}
                        onChange={(e) => setChannelDraft({ ...channelDraft, secret: e.target.value })}
                        placeholder="加签密钥（机器人开了「签名校验」才需要，否则留空）"
                      />
                    )}
                    {channelDraft.type === 'feishu-app' && (
                      <>
                        <Input
                          value={channelDraft.appId ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, appId: e.target.value })}
                          placeholder="App ID（cli_…，应用需开机器人能力+im:message 并拉进群）"
                        />
                        <Input.Password
                          value={channelDraft.appSecret ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, appSecret: e.target.value })}
                          placeholder="App Secret"
                        />
                        <Input
                          value={channelDraft.chatId ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, chatId: e.target.value })}
                          placeholder="群 chat_id（oc_…，留空自动用机器人所在的第一个群）"
                        />
                        <Input
                          value={channelDraft.folderToken ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, folderToken: e.target.value })}
                          placeholder="云文档文件夹 token（分享链接中 /folder/ 后的字符串）"
                        />
                      </>
                    )}
                    {channelDraft.type === 'wechat-official' && (
                      <>
                        <Input
                          value={channelDraft.appId ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, appId: e.target.value })}
                          placeholder="微信公众号 AppID（wx…）"
                        />
                        <Input.Password
                          value={channelDraft.appSecret ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, appSecret: e.target.value })}
                          placeholder="微信公众号 AppSecret"
                        />
                        <span className={styles.labelHint}>
                          先配置开发者权限和服务器 IP 白名单；此渠道只创建草稿，不会自动群发。
                        </span>
                      </>
                    )}
                    <div className={styles.actionRow}>
                      <Button size="small" type="primary" disabled={!channelDraftComplete(channelDraft)} onClick={addChannel}>
                        添加
                      </Button>
                      <Button
                        size="small"
                        loading={channelTesting === 'draft'}
                        disabled={!channelDraftComplete(channelDraft)}
                        onClick={() => testChannel(channelDraft)}
                      >
                        先测试
                      </Button>
                      {channelTestResult['draft'] && <span className={styles.labelHint}>{channelTestResult['draft']}</span>}
                      <Button size="small" onClick={() => setChannelDraft(null)}>
                        取消
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  子 agent 工作流
                  <span className={styles.labelHint}>启用 scout / planner / worker / reviewer 和斜杠命令</span>
                </span>
                <div className={styles.actionRow}>
                  <Switch
                    size="small"
                    checked={settings.subagentsEnabled}
                    onChange={(checked) => patch({ subagentsEnabled: checked })}
                  />
                  <span className={styles.labelHint}>{settings.subagentsEnabled ? '已开启' : '已关闭'}</span>
                </div>
                <span className={styles.labelHint}>
                  修改后需重新打开工作区生效。默认提供 /implement、/scout-and-plan、/implement-and-review，用独立
                  pi 子进程分担代码侦察、规划、实现和审查。
                </span>
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  Agent 安全边界
                  <span className={styles.labelHint}>拦截危险命令、越界写入和敏感文件改写</span>
                </span>
                <div className={styles.actionRow}>
                  <Switch
                    size="small"
                    checked={settings.securityGuardEnabled}
                    onChange={(checked) => patch({ securityGuardEnabled: checked })}
                  />
                  <span className={styles.labelHint}>{settings.securityGuardEnabled ? '已开启' : '已关闭'}</span>
                </div>
                <span className={styles.labelHint}>
                  修改后需重新打开工作区生效。默认阻止 rm -rf、递归强删、提权命令、注册表删除，以及 .env、.git、node_modules 和密钥文件写入。
                </span>
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  沙箱模式（WSL2 + bubblewrap）
                  <Tag color="orange" style={{ marginLeft: 8 }}>
                    实验性
                  </Tag>
                  <span className={styles.labelHint}>
                    agent 跑在隔离的 WSL 发行版里:文件只写工作区,出站经主机白名单代理
                  </span>
                </span>
                <div className={styles.actionRow}>
                  <Switch
                    size="small"
                    checked={settings.sandboxEnabled}
                    onChange={(checked) => patch({ sandboxEnabled: checked })}
                  />
                  <span className={styles.labelHint}>
                    {settings.sandboxEnabled ? '已开启' : '已关闭'}
                  </span>
                </div>
                <Alert
                  type="info"
                  showIcon
                  message="pi-studio-sandbox 发行版就绪即自动使用 WSL 沙箱;否则回退 Docker(旧方案)。重新打开工作区生效。"
                  description="bwrap 隔离:整盘只读、仅工作区与 agent 目录可写;网络收敛到主机侧域名白名单代理。注意沙箱内是 Linux 环境,跑不了 Windows 构建。发行版准备命令与方案详见 docs/sandbox-mode-plan.md。"
                />
                <div className={styles.actionRow}>
                  <span className={styles.label}>环境</span>
                  <Button size="small" loading={sandboxDetecting} onClick={detectSandbox}>
                    重新检测
                  </Button>
                </div>
                <div className={styles.actionRow}>
                  <Tag color={sandboxDetect?.wslSandboxReady ? 'green' : 'default'}>
                    {sandboxDetect
                      ? sandboxDetect.wslSandboxReady
                        ? 'WSL 沙箱发行版就绪(pi-studio-sandbox)'
                        : 'WSL 沙箱发行版未准备'
                      : 'WSL 检测中…'}
                  </Tag>
                  <Tag color={sandboxDetect?.docker.daemonRunning ? 'green' : 'default'}>
                    {sandboxDetect
                      ? sandboxDetect.docker.daemonRunning
                        ? `Docker 回退可用 v${sandboxDetect.docker.version}`
                        : sandboxDetect.docker.cliFound
                          ? 'Docker(回退)未运行'
                          : '无 Docker(回退)'
                      : 'Docker 检测中…'}
                  </Tag>
                  <Tag color={sandboxImage?.exists ? 'green' : 'default'}>
                    {sandboxImage
                      ? sandboxImage.exists
                        ? `回退镜像已就绪`
                        : '回退镜像未构建'
                      : '镜像检测中…'}
                  </Tag>
                </div>
                {sandboxDetect && !sandboxDetect.wslSandboxReady && (
                  <span className={styles.labelHint}>
                    准备发行版(一次性,约 1 分钟):详见 docs/sandbox-mode-plan.md 或
                    src/main/sandbox-wsl.ts 头注释里的三条命令。
                  </span>
                )}
                {sandboxDetect?.docker.daemonRunning && !sandboxImage?.exists && (
                  <div className={styles.actionRow}>
                    <Button size="small" type="primary" loading={sandboxBuilding} onClick={buildSandboxImage}>
                      构建镜像
                    </Button>
                    <span className={styles.labelHint}>首次约几分钟，之后复用</span>
                  </div>
                )}
                {sandboxBuildLog && (
                  <span className={styles.labelHint} style={{ wordBreak: 'break-all' }}>
                    {sandboxBuildLog}
                  </span>
                )}
              </div>
            </div>
          )}

          {category === 'imagegen' && (
            <div className={styles.form}>
              <div className={styles.section}>
                <span className={styles.label}>
                  默认引擎
                  <span className={styles.labelHint}>生图页打开时的默认引擎；自动=按当前可用情况选</span>
                </span>
                <Select
                  value={settings.imageEngine || 'auto'}
                  onChange={(v) => patch({ imageEngine: v === 'auto' ? '' : (v as 'comfy' | 'openai') })}
                  style={{ width: 220 }}
                  options={[
                    { value: 'auto', label: '自动' },
                    { value: 'openai', label: '云端 gpt-image-2' },
                    { value: 'comfy', label: '本地 ComfyUI' },
                  ]}
                />
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  ComfyUI 目录
                  <span className={styles.labelHint}>本地引擎的安装目录（含 .venv）；留空用默认 D:\Works\ComfyUI</span>
                </span>
                <Input
                  value={settings.comfyDir}
                  onChange={(e) => patch({ comfyDir: e.target.value })}
                  placeholder="D:\\Works\\ComfyUI"
                />
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  Python 路径（可选）
                  <span className={styles.labelHint}>留空自动使用 ComfyUI 目录下的 .venv</span>
                </span>
                <Input
                  value={settings.comfyPythonPath}
                  onChange={(e) => patch({ comfyPythonPath: e.target.value })}
                  placeholder="D:\\Works\\ComfyUI\\.venv\\Scripts\\python.exe"
                />
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  Checkpoint（可选）
                  <span className={styles.labelHint}>填写 models/checkpoints 下的文件名；留空自动选择兼容的 SD checkpoint，Flux/SD3 等需专用 workflow</span>
                </span>
                <Input
                  value={settings.comfyCheckpoint}
                  onChange={(e) => patch({ comfyCheckpoint: e.target.value })}
                  placeholder="例如：v1-5-pruned-emaonly.safetensors"
                />
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  启动参数（可选）
                  <span className={styles.labelHint}>留空使用 main.py --port {'{port}'}；支持用引号包裹参数</span>
                </span>
                <Input
                  value={settings.comfyLaunchArgs}
                  onChange={(e) => patch({ comfyLaunchArgs: e.target.value })}
                  placeholder="main.py --port {port} --listen 127.0.0.1"
                />
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  云端中继（高级）
                  <span className={styles.labelHint}>地址可留空使用默认中继；Key 不再内置，需在此填写或通过 PI_CLOUD_IMAGE_KEY 提供</span>
                </span>
                <Input
                  value={settings.cloudImageRelay}
                  onChange={(e) => patch({ cloudImageRelay: e.target.value })}
                  placeholder="https://trail-api.glanger.xyz（留空=默认中继）"
                />
                <Input.Password
                  value={settings.cloudImageKey}
                  onChange={(e) => patch({ cloudImageKey: e.target.value })}
                  placeholder="X-API-Key（留空=未配置）"
                />
                <span className={styles.labelHint}>
                  中继地址必须是 HTTPS（本机回环 http 仅开发用）。改后立即生效，不需重开工作区。
                  「3D 生成」也复用这套云端中继 + Key。
                </span>
              </div>
            </div>
          )}

          {category === 'security' && (
            <div className={styles.form}>
              <div className={styles.policyScope}>
                当前编辑：
                {policyScope === 'workspace'
                  ? `当前工作区策略${policyWorkspacePath ? ` · ${policyWorkspacePath}` : ''}`
                  : '默认策略（打开工作区前使用）'}
                <br />
                保存后下一次工具调用生效；不需要重启应用。命令规则按包含/前缀匹配，路径规则相对当前工作区解析。
              </div>

              {policyError && <Alert type="error" showIcon message={policyError} />}

              <div className={styles.section}>
                <span className={styles.label}>
                  默认保护
                  <span className={styles.labelHint}>建议全部开启，必要时用允许规则放行具体命令或路径</span>
                </span>
                <div className={styles.actionRow}>
                  <span className={styles.switchItem}>
                    <Switch
                      size="small"
                      checked={securityPolicy.blockOutsideWorkspace}
                      onChange={(checked) => patchPolicy({ blockOutsideWorkspace: checked })}
                    />
                    越界写入
                  </span>
                  <span className={styles.switchItem}>
                    <Switch
                      size="small"
                      checked={securityPolicy.blockProtectedPaths}
                      onChange={(checked) => patchPolicy({ blockProtectedPaths: checked })}
                    />
                    敏感路径
                  </span>
                  <span className={styles.switchItem}>
                    <Switch
                      size="small"
                      checked={securityPolicy.requireConfirmationForDangerousCommands}
                      onChange={(checked) =>
                        patchPolicy({ requireConfirmationForDangerousCommands: checked })
                      }
                    />
                    危险确认
                  </span>
                </div>
              </div>

              <div className={styles.policyGrid}>
                <div className={styles.section}>
                  <span className={styles.label}>
                    命令允许规则
                    <span className={styles.labelHint}>一行一个前缀；命中后不再弹危险确认</span>
                  </span>
                  <Input.TextArea
                    value={rulesToLines(securityPolicy.commandAllowlist)}
                    onChange={(e) => patchPolicy({ commandAllowlist: linesToRules(e.target.value) })}
                    placeholder={'git status\npnpm test\nnpm run build'}
                    autoSize={{ minRows: 5, maxRows: 8 }}
                  />
                </div>

                <div className={styles.section}>
                  <span className={styles.label}>
                    命令阻止规则
                    <span className={styles.labelHint}>一行一个关键字；命中后直接阻止</span>
                  </span>
                  <Input.TextArea
                    value={rulesToLines(securityPolicy.commandBlocklist)}
                    onChange={(e) => patchPolicy({ commandBlocklist: linesToRules(e.target.value) })}
                    placeholder={'git push --force\ncurl | powershell\nSet-ExecutionPolicy'}
                    autoSize={{ minRows: 5, maxRows: 8 }}
                  />
                </div>

                <div className={styles.section}>
                  <span className={styles.label}>
                    写入允许路径
                    <span className={styles.labelHint}>一行一个路径；可放行受保护目录内的具体文件</span>
                  </span>
                  <Input.TextArea
                    value={rulesToLines(securityPolicy.writeAllowlist)}
                    onChange={(e) => patchPolicy({ writeAllowlist: linesToRules(e.target.value) })}
                    placeholder={'.env.example\ndocs/\nsrc/generated/'}
                    autoSize={{ minRows: 5, maxRows: 8 }}
                  />
                </div>

                <div className={styles.section}>
                  <span className={styles.label}>
                    写入阻止路径
                    <span className={styles.labelHint}>一行一个路径；命中后直接阻止</span>
                  </span>
                  <Input.TextArea
                    value={rulesToLines(securityPolicy.writeBlocklist)}
                    onChange={(e) => patchPolicy({ writeBlocklist: linesToRules(e.target.value) })}
                    placeholder={'.github/workflows/\npackage-lock.json\nscripts/release-local.js'}
                    autoSize={{ minRows: 5, maxRows: 8 }}
                  />
                </div>
              </div>
            </div>
          )}

          {category === 'about' && (
            <div>
              <div className={styles.aboutRow}>
                <span>版本</span>
                <span>v{version || '…'}</span>
              </div>
              <div className={styles.aboutRow}>
                <span>pi 引擎</span>
                <span>{piVersion ? `v${piVersion}` : '…'}</span>
              </div>
              <div className={styles.aboutRow}>
                <span>自动更新</span>
                <span>启动时及每 4 小时检查，后台静默安装</span>
              </div>
              <div className={styles.aboutRow}>
                <span>项目</span>
                <span>GreenBeanLiu/pi-studio</span>
              </div>
              <div className={styles.aboutRow}>
                <span>诊断包</span>
                <Button
                  size="small"
                  disabled={diagnosticsDisabled || !onExportDiagnostics}
                  onClick={onExportDiagnostics}
                >
                  导出
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
