import { useEffect, useState } from 'react'
import { createStyles } from 'antd-style'
import { Input, Segmented, Button } from 'antd'
import { X, Eye, EyeOff } from 'lucide-react'
import { api, type PiProvider } from '../lib/api'

type Settings = {
  provider: PiProvider
  apiKey: string
  model: string
  baseUrl: string
}

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

  body: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 28px 0;
    display: flex;
    flex-direction: column;
    align-items: center;
  `,

  form: css`
    width: 100%;
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

  footer: css`
    flex-shrink: 0;
    display: flex;
    align-items: center;
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

  const [settings, setSettings] = useState<Settings>({ provider: 'anthropic', apiKey: '', model: '', baseUrl: '' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
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
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
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

      <div className={styles.body}>
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
              模型
              <span className={styles.labelHint}>不填则使用 pi 默认模型</span>
            </span>
            <Input
              value={settings.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder={settings.provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o'}
            />
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        {version && (
          <span style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)', marginRight: 'auto' }}>
            v{version}
          </span>
        )}
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" loading={saving} onClick={handleSave}>
          {saved ? '已保存 ✓' : '保存设置'}
        </Button>
      </div>
    </div>
  )
}
