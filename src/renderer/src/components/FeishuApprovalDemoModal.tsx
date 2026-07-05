import { useEffect, useState } from 'react'
import { Alert, Button, Input, Modal } from 'antd'
import { createStyles } from 'antd-style'
import { api, type FeishuConfigStatus, type PiProvider } from '../lib/api'

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

const EMPTY_SETTINGS: Settings = {
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
}

const DEFAULT_STATUS: FeishuConfigStatus = {
  appIdConfigured: false,
  appSecretConfigured: false,
  envFilePath: '',
}

const useStyles = createStyles(({ token, css }) => ({
  form: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
  `,

  row: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  `,

  label: css`
    font-size: 13px;
    font-weight: 500;
    color: ${token.colorText};
    margin-bottom: 6px;
  `,

  hint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.5;
  `,

  buttonRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  `,

  resultBox: css`
    margin: 0;
    padding: 10px 12px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillTertiary};
    color: ${token.colorTextSecondary};
    font-size: 12px;
    line-height: 1.55;
    overflow: auto;
    max-height: 190px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ${token.fontFamilyCode};
  `,
}))

export default function FeishuApprovalDemoModal({ onClose }: { onClose: () => void }) {
  const { styles } = useStyles()
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS)
  const [status, setStatus] = useState<FeishuConfigStatus>(DEFAULT_STATUS)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')

  const appConfigReady = status.appIdConfigured && status.appSecretConfigured

  useEffect(() => {
    api.settings.load().then(setSettings)
    api.feishu.getConfigStatus().then(setStatus).catch(() => {})
  }, [])

  function patch(update: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...update }))
  }

  async function saveOnly() {
    setSaving(true)
    try {
      await api.settings.save(settings)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function run(dryRun: boolean) {
    setLoading(true)
    setResult('')
    try {
      await api.settings.save(settings)
      const response = await api.feishu.submitApprovalDemo({
        approvalCode: settings.feishuApprovalCode,
        userId: settings.feishuUserId,
        formJson: settings.feishuFormJson,
        nodeApproversJson: settings.feishuNodeApproversJson,
        dryRun,
      })
      setResult(JSON.stringify(response, null, 2))
    } catch (err) {
      setResult(`ERROR: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open
      onCancel={onClose}
      title="飞书审批 Demo"
      width={720}
      centered
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={saveOnly}>
          保存参数
        </Button>,
      ]}
    >
      <div className={styles.form}>
        <Alert
          type={appConfigReady ? 'success' : 'warning'}
          showIcon
          message={appConfigReady ? '飞书 App 配置已从后台 env 加载' : '飞书 App 配置未完整加载'}
          description={
            appConfigReady
              ? `App ID / App Secret 只在主进程读取，前端不会显示。env 文件：${status.envFilePath}`
              : `请在后台 env 中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。env 文件：${status.envFilePath}`
          }
        />

        <div className={styles.row}>
          <div>
            <div className={styles.label}>Approval Code</div>
            <Input
              value={settings.feishuApprovalCode}
              onChange={(e) => patch({ feishuApprovalCode: e.target.value })}
              placeholder="飞书审批定义的 Approval Code"
            />
          </div>
          <div>
            <div className={styles.label}>申请人 user_id</div>
            <Input
              value={settings.feishuUserId}
              onChange={(e) => patch({ feishuUserId: e.target.value })}
              placeholder="发起审批的飞书 user_id"
            />
          </div>
        </div>

        <div>
          <div className={styles.label}>表单 JSON</div>
          <Input.TextArea
            value={settings.feishuFormJson}
            onChange={(e) => patch({ feishuFormJson: e.target.value })}
            placeholder='[{"id":"reason","type":"input","value":"pi-studio 飞书审批 Demo"}]'
            autoSize={{ minRows: 5, maxRows: 9 }}
          />
          <div className={styles.hint}>控件 id 必须和飞书审批定义里的字段 id 一致。</div>
        </div>

        <div>
          <div className={styles.label}>节点审批人 JSON</div>
          <Input.TextArea
            value={settings.feishuNodeApproversJson}
            onChange={(e) => patch({ feishuNodeApproversJson: e.target.value })}
            placeholder='可选，例如 [{"key":"node-id","value":["user-id"]}]'
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
        </div>

        <div className={styles.buttonRow}>
          <Button loading={loading} onClick={() => run(true)}>
            生成请求
          </Button>
          <Button type="primary" loading={loading} disabled={!appConfigReady} onClick={() => run(false)}>
            提交审批 Demo
          </Button>
          <span className={styles.hint}>生成请求不会调用飞书；提交审批会创建真实审批实例。</span>
        </div>

        {result && <pre className={styles.resultBox}>{result}</pre>}
      </div>
    </Modal>
  )
}
