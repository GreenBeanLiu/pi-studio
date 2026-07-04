import { useEffect, useState } from 'react'
import { createStyles, cx } from 'antd-style'
import { Input, Segmented, Button } from 'antd'
import { X, Eye, EyeOff, Bot, Globe, Info } from 'lucide-react'
import { api, type PiProvider } from '../lib/api'

type Settings = {
  provider: PiProvider
  apiKey: string
  model: string
  baseUrl: string
  favoriteModels: string
  tavilyApiKey: string
}

type Category = 'model' | 'tools' | 'about'

const CATEGORIES: { key: Category; label: string; icon: typeof Bot }[] = [
  { key: 'model', label: '模型服务', icon: Bot },
  { key: 'tools', label: '扩展工具', icon: Globe },
  { key: 'about', label: '关于', icon: Info },
]

const useStyles = createStyles(({ token, css }) => ({
  overlay: css`
    position: fixed;
    top: 0;
    left: 64px;
    right: 0;
    bottom: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    background: ${token.colorBgBase};
    border-left: 1px solid ${token.colorBorderSecondary};
    animation: slide-in-right 0.2s ease-out both;
  `,

  header: css`
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 24px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,

  headerTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
  `,

  closeBtn: css`
    width: 28px;
    height: 28px;
    border-radius: ${token.borderRadiusSM}px;
    border: none;
    background: transparent;
    color: ${token.colorTextTertiary};
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    outline: none;

    &:hover {
      background: ${token.colorFill};
      color: ${token.colorText};
    }
  `,

  main: css`
    flex: 1;
    min-height: 0;
    display: flex;
  `,

  nav: css`
    width: 168px;
    flex-shrink: 0;
    border-right: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorBgLayout};
    padding: 16px 10px;
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
    padding: 28px 32px;
  `,

  form: css`
    max-width: 480px;
    display: flex;
    flex-direction: column;
    gap: 20px;
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

  footer: css`
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 24px;
    border-top: 1px solid ${token.colorBorderSecondary};
  `,
}))

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { styles } = useStyles()

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const [category, setCategory] = useState<Category>('model')
  const [settings, setSettings] = useState<Settings>({ provider: 'anthropic', apiKey: '', model: '', baseUrl: '', favoriteModels: '', tavilyApiKey: '' })
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
    <div className={styles.overlay}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>设置</span>
        <button className={styles.closeBtn} onClick={onClose}>
          <X size={14} />
        </button>
      </div>

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
                  <span className={styles.labelHint}>逗号分隔，聊天页切换器只显示这些；留空则显示每家最新 8 个</span>
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
            </div>
          )}

          {category === 'about' && (
            <div className={styles.form}>
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
            </div>
          )}
        </div>
      </div>

      <div className={styles.footer}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" loading={saving} onClick={handleSave}>
          保存设置
        </Button>
      </div>
    </div>
  )
}
