# Feishu Approval Workflow

This note preserves the Feishu approval capability after removing the embedded
demo from pi-studio. The recommended direction is a separate approval app that
owns Feishu login, OAuth tokens, approval creation, and approval task handling.

## Boundary

- pi-studio stays focused on local coding-agent sessions.
- A future approval app, for example `pi-approval`, owns Feishu integration.
- pi-studio may later hand off a request by deep link, such as
  `pi-approval://create?source=pi-studio`, or by a local HTTP endpoint such as
  `http://127.0.0.1:<port>/approvals/create`.
- Do not store Feishu App Secret or user tokens in pi-studio.

## Existing Approval

- Approval name: `Pi Studio 任务审批`
- Approval Code: `47F2CA39-8FDF-4ED3-92A0-CBFCAA6F3B70`
- Test instance and applicant `open_id` should be re-fetched with the CLI or API
  during development instead of committed to source control.

`open_id` is app-specific. Treat it as a Feishu identity for the current app,
not as a stable global user id.

## Form Fields

| Label | Type | Field ID | Required | Notes |
| --- | --- | --- | --- | --- |
| 申请事项 | input | `widget17832574107980001` | yes | Short title |
| 申请原因 | textarea | `widget17832574526070001` | yes | Why this needs approval |
| 操作类型 | radioV2 | `widget17832575453130001` | yes | See option values below |
| 影响范围 | radioV2 | `widget17832584197660001` | yes | See option values below |
| 关联项目 | input | `widget17832575967210001` | no | Repo/project/service name |
| 预计风险 | textarea | `widget17832576136450001` | no | Rollback/risk notes |
| 相关附件 | attachmentV2 | `widget17832576604320001` | no | Optional files |

操作类型 option values:

| Label | Value |
| --- | --- |
| 发版 | `mr7ti069-ll9mbho9k0n-0` |
| 配置变更 | `mr7ti069-ie7ybc0uyd-0` |
| 权限申请 | `mr7ti069-zg8ohad5j1l-0` |
| 外部集成 | `mr7ti06h-eygqd9c5oy-1` |
| 其它 | `mr7ti06h-h9f9ftyn69s-3` |

影响范围 option values:

| Label | Value |
| --- | --- |
| 仅本人 | `mr7u0qwn-97oeniipjr-0` |
| 当前项目 | `mr7u0qwn-t9yann31mn-0` |
| 团队 | `mr7u0qwn-vx120zusx5m-0` |
| 生产环境 | `mr7u0iuh-gc4ihhb7lb-1` |

## Demo Create Payload

The Feishu API expects `form` to be a JSON string, not a nested JSON array.

```json
{
  "approval_code": "47F2CA39-8FDF-4ED3-92A0-CBFCAA6F3B70",
  "form": "[{\"id\":\"widget17832574107980001\",\"type\":\"input\",\"value\":\"发布 pi-studio v0.3.22\"},{\"id\":\"widget17832574526070001\",\"type\":\"textarea\",\"value\":\"移除内置飞书 demo，保留未来独立审批应用能力\"},{\"id\":\"widget17832575453130001\",\"type\":\"radioV2\",\"value\":\"mr7ti069-ll9mbho9k0n-0\"},{\"id\":\"widget17832584197660001\",\"type\":\"radioV2\",\"value\":\"mr7u0qwn-t9yann31mn-0\"}]"
}
```

## Lark CLI Debug Flow

Install or refresh the CLI:

```powershell
npm install -g @larksuite/cli@latest
```

On PowerShell, prefer `lark-cli.cmd` because the `.ps1` shim may be blocked by
execution policy.

Initialize an app profile:

```powershell
lark-cli.cmd config init --app-id <app_id> --app-secret-stdin --brand feishu --name <profile>
```

Start user auth for approval scopes:

```powershell
lark-cli.cmd --profile <profile> auth login --domain approval --no-wait --json
lark-cli.cmd --profile <profile> auth login --device-code <device_code>
```

Search approvals:

```powershell
lark-cli.cmd --profile <profile> approval approvals search --data "@approval-search.json" --as user --json
```

Get approval details:

```powershell
lark-cli.cmd --profile <profile> approval approvals get --params "@approval-get.json" --as user --json
```

Create an instance:

```powershell
lark-cli.cmd --profile <profile> approval instances create --data "@approval-create.json" --yes --as user --json
```

Using `--data "@file.json"` avoids PowerShell and `.cmd` JSON quoting problems.

## Future App Architecture

1. Electron or web app handles Feishu login and stores user token in OS-protected
   storage.
2. Backend/main process owns Feishu SDK/API calls and keeps App Secret out of
   renderer code.
3. Approval templates are local typed configs: field ids, option ids, validation,
   and default values.
4. pi-studio sends only business intent: title, reason, operation type, impact,
   project, risk, and attachment references.
5. Approval app creates the Feishu instance and returns an instance code or URL
   to pi-studio.

## Security Notes

- Never commit App ID/App Secret or OAuth tokens.
- Keep Feishu credentials in the future approval app only.
- Store user tokens using secure OS storage or an encrypted app-private store.
- Use `lark-cli` as a development/debug tool unless there is a clear runtime
  reason to ship it.
