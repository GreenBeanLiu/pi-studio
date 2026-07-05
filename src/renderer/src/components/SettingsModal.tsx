import { useEffect, useState } from 'react'
import { createStyles, cx } from 'antd-style'
import { Input, Segmented, Button, Modal } from 'antd'
import { Eye, EyeOff, Bot, Globe, Info } from 'lucide-react'
import { api, type PiProvider } from '../lib/api'

type Settings = {
  provider: PiProvider
  apiKey: string
  model: string
  baseUrl: string
  favoriteModels: string
  tavilyApiKey: string
  heliconeApiKey: string
  feishuApprovalCode: string
  feishuUserId: string
  feishuFormJson: string
  feishuNodeApproversJson: string
}

type Category = 'model' | 'tools' | 'about'

const CATEGORIES: { key: Category; label: string; icon: typeof Bot }[] = [
  { key: 'model', label: '模型服务', icon: Bot },
  { key: 'tools', label: '扩展工具', icon: Globe },
  { key: 'about', label: '关于', icon: Info },
]

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

export default function SettingsModal({ onClose }: { onClose: () => void }) {
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
    feishuApprovalCode: '',
    feishuUserId: '',
    feishuFormJson: '',
    feishuNodeApproversJson: '',
  })
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    api.settings.load().then(setSettings)
    api.app.version().then(setVersion).catch(() => {})
  }, [])

  async function handleSave() {
    setSaving(true)
    await api.settings.save(settings)
    setSaving(false)
    onClose()
  }

  function patch(update: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...update }))
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
                  onChange={(v) => patch({ provider: v as PiProvider, model: '' })}
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
                <Input.TextArea
                  value={settings.favoriteModels}
                  onChange={(e) => patch({ favoriteModels: e.target.value })}
                  placeholder="gpt-5.4, gpt-5.2, o4-mini"
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
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
            </div>
          )}

          {category === 'about' && (
            <div>
              <div className={styles.aboutRow}>
                <span>版本</span>
                <span>v{version || '…'}</span>
              </div>
              <div className={styles.aboutRow}>
                <span>自动更新</span>
                <span>启动时及每 4 小时检查，后台静默安装</span>
              </div>
              <div className={styles.aboutRow}>
                <span>项目</span>
                <span>GreenBeanLiu/pi-studio</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
