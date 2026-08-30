import { createStyles } from 'antd-style'

import { type RunStatus } from './chat-types'

export const useStyles = createStyles(({ token, css }) => ({
  pane: css`
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    /* min-height:0 is essential: without it a flex item won't shrink below
       its content height, so a long conversation makes this pane grow past
       the overflow:hidden shell — clipping the input box off the bottom and
       leaving nothing for the messages area to scroll. */
    min-height: 0;
    background: ${token.colorBgBase};
  `,

  errorBanner: css`
    flex-shrink: 0;
    margin: 12px 16px 0;
    padding: 8px 14px;
    border-radius: ${token.borderRadius}px;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: ${token.colorErrorBg};
    border: 1px solid ${token.colorErrorBorder};
    color: ${token.colorError};
    animation: slide-in-down 0.18s ease-out both;
  `,

  retryBanner: css`
    flex-shrink: 0;
    margin: 12px 16px 0;
    padding: 8px 14px;
    border-radius: ${token.borderRadius}px;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: ${token.colorWarningBg};
    border: 1px solid ${token.colorWarningBorder};
    color: ${token.colorWarningText};
    animation: slide-in-down 0.18s ease-out both;
  `,

  errorDismiss: css`
    background: none;
    border: none;
    color: ${token.colorError};
    cursor: pointer;
    opacity: 0.6;
    flex-shrink: 0;
    font-size: 14px;
    padding: 0;
    transition: opacity ${token.motionDurationFast};
    &:hover { opacity: 1; }
  `,

  approvalStack: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
  `,

  approvalCard: css`
    border: 1px solid ${token.colorWarningBorder};
    background: ${token.colorWarningBg};
    border-radius: ${token.borderRadius}px;
    padding: 10px 12px;
    box-shadow: ${token.boxShadowSecondary};
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: ${token.colorText};
  `,

  approvalHeader: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  `,

  approvalTitle: css`
    font-size: 13px;
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  approvalMeta: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    flex-shrink: 0;
  `,

  approvalCommand: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusSM}px;
    padding: 7px 8px;
    max-height: 110px;
    overflow-y: auto;
  `,

  approvalReason: css`
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,

  approvalActions: css`
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  `,

  messages: css`
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  `,

  messagesInner: css`
    width: 100%;
    max-width: 920px;
    margin: 0 auto;
    padding: 16px 28px 88px;
    display: flex;
    flex-direction: column;
    flex: 1;
  `,

  emptyState: css`
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    text-align: center;
    padding: 0 24px;
    color: ${token.colorTextSecondary};
  `,

  emptyTitle: css`
    font-size: 15px;
    font-weight: 500;
    color: ${token.colorText};
    margin: 0;
  `,

  emptyHint: css`
    font-size: 13px;
    color: ${token.colorTextTertiary};
    margin: 0;
    max-width: 360px;
    line-height: 1.6;
  `,

  msgRow: css`
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 8px 0 6px;
    animation: msg-in 0.2s ease-out both;
  `,

  msgRowUser: css`
    flex-direction: row-reverse;
  `,

  msgContent: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 100%;
    flex: 1;
    min-width: 0;
  `,

  msgContentUser: css`
    align-items: flex-end;
    max-width: 70%;
  `,

  /* 复制按钮常驻会让每条消息都挂个图标,太吵;hover 出现即可。
     focus-within 单独留着,键盘 Tab 过来时不能是隐形的。 */
  msgActions: css`
    display: flex;
    gap: 4px;
    height: 20px;
    opacity: 0;
    transition: opacity ${token.motionDurationFast};

    .chat-msg-row:hover &,
    &:focus-within {
      opacity: 1;
    }
  `,

  msgActionBtn: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    padding: 0 6px;
    height: 20px;
    border-radius: ${token.borderRadiusSM}px;
    border: none;
    background: transparent;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    outline: none;
    font-family: ${token.fontFamily};

    &:hover {
      background: ${token.colorFillTertiary};
      color: ${token.colorText};
    }
  `,

  avatarBox: css`
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 600;
  `,

  userAvatar: css`
    background: ${token.colorFill};
    border: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};
  `,

  agentAvatar: css`
    background: ${token.colorPrimaryBg};
    border: 1px solid ${token.colorPrimaryBorder};
    color: ${token.colorPrimary};
  `,

  msgBubble: css`
    padding: 9px 13px;
    font-size: 15px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-words;
    border-radius: ${token.borderRadiusLG}px;
    font-family: ${token.fontFamily};
  `,

  msgBubbleUser: css`
    background: ${token.colorFillSecondary};
    color: ${token.colorText};
  `,

  msgBubbleAssistant: css`
    background: transparent;
    border: none;
    color: ${token.colorText};
    padding: 0;
    white-space: normal;
  `,

  thinkingToggle: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    padding: 2px 0;
    cursor: pointer;
    user-select: none;
    width: fit-content;

    &:hover {
      color: ${token.colorTextSecondary};
    }
  `,

  thinkingChevron: css`
    transition: transform ${token.motionDurationFast};
  `,

  thinkingChevronOpen: css`
    transform: rotate(90deg);
  `,

  thinkingBlock: css`
    font-size: 12px;
    font-style: italic;
    color: ${token.colorTextTertiary};
    padding: 4px 0 4px 15px;
    white-space: pre-wrap;
  `,

  toolGroup: css`
    margin: 2px 0;
  `,

  toolGroupHead: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    padding: 3px 0;
    cursor: pointer;
    user-select: none;
    width: fit-content;

    &:hover {
      color: ${token.colorTextSecondary};
    }
  `,

  toolGroupLabel: css`
    font-variant-numeric: tabular-nums;
  `,

  toolGroupError: css`
    color: ${token.colorError};
    font-size: 11px;
  `,

  toolGroupBody: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-left: 15px;
    margin-top: 2px;
  `,

  errorText: css`
    font-size: 13px;
    color: ${token.colorError};
    background: ${token.colorErrorBg};
    border: 1px solid ${token.colorErrorBorder};
    border-radius: ${token.borderRadius}px;
    padding: 8px 12px;
    white-space: pre-wrap;
    margin-top: 4px;
  `,

  runStatus: css`
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    padding: 0 4px 8px;
    user-select: none;
  `,

  runStatusDot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    background: ${token.colorPrimary};
    animation: typing-dot 1.4s ease-in-out infinite;
  `,

  agentStatusPanel: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 7px 8px;
    margin: 0 0 8px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    font-size: 11px;
    color: ${token.colorTextSecondary};
    font-variant-numeric: tabular-nums;
  `,

  agentStatusItem: css`
    white-space: nowrap;
  `,

  agentStatusClickable: css`
    cursor: pointer;
    text-decoration: underline dotted;
    text-underline-offset: 3px;

    &:hover {
      color: ${token.colorText};
    }
  `,

  agentStatusDetail: css`
    max-width: 420px;
    max-height: 320px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.7;
  `,

  agentStatusTodoRow: css`
    display: flex;
    gap: 8px;
    align-items: baseline;
    color: ${token.colorText};
  `,

  agentStatusTodoDone: css`
    color: ${token.colorTextTertiary};
    text-decoration: line-through;
  `,

  agentStatusTodoMark: css`
    flex-shrink: 0;
    width: 12px;
    color: ${token.colorTextTertiary};
  `,

  agentStatusToolRow: css`
    display: flex;
    gap: 16px;
    justify-content: space-between;
    font-family: ${token.fontFamilyCode};
    color: ${token.colorText};
  `,

  agentStatusToolCount: css`
    color: ${token.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,

  agentStatusTask: css`
    flex: 1 1 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${token.colorText};
  `,

  agentStatusAlert: css`
    color: ${token.colorError};
    font-weight: 600;
  `,

  /* 用主内容背景色,不再做模糊浮层 */
  inputArea: css`
    flex-shrink: 0;
    padding: 16px 28px 20px;
    background: ${token.colorBgBase};
  `,

  inputAreaInner: css`
    width: 100%;
    max-width: 920px;
    margin: 0 auto;
  `,

  /* 输入框是高频工具,保持稳定清楚即可,不做浮动卡片 */
  inputBox: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-radius: 8px;
    padding: 12px 14px 8px;
    background: ${token.colorBgElevated};
    border: 1px solid ${token.colorBorder};
    transition: border-color ${token.motionDurationFast}, box-shadow ${token.motionDurationFast};
  `,

  inputControls: css`
    display: flex;
    align-items: center;
    gap: 8px;
  `,

  inputBoxFocused: css`
    border-color: ${token.colorPrimaryBorder};
    box-shadow: 0 0 0 2px ${token.colorPrimary}14;
  `,

  inputTextarea: css`
    flex: 1;
    resize: none;
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    color: ${token.colorText};
    font-family: ${token.fontFamily};
    line-height: 1.6;
    min-height: 46px;
    max-height: 200px;
    overflow-y: auto;
    padding: 0;

    &::placeholder {
      color: ${token.colorTextTertiary};
    }

    &:disabled {
      cursor: not-allowed;
    }
  `,

  sendBtn: css`
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background ${token.motionDurationFast}, color ${token.motionDurationFast}, opacity ${token.motionDurationFast};
    outline: none;

    &:disabled {
      cursor: not-allowed;
      opacity: 0.35;
    }
  `,

  modelChip: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    padding: 3px 8px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid transparent;
    background: transparent;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    outline: none;
    font-family: ${token.fontFamily};
    transition: all ${token.motionDurationFast};

    &:hover {
      border-color: ${token.colorBorderSecondary};
      background: ${token.colorFillTertiary};
      color: ${token.colorTextSecondary};
    }
  `,

  diffMeta: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 12px;
  `,

  reviewHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  `,

  reviewTitle: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,

  reviewName: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
  `,

  reviewHint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,

  reviewBody: css`
    display: grid;
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
    gap: 12px;
    min-height: 420px;
  `,

  reviewSidebar: css`
    min-width: 0;
    border-right: 1px solid ${token.colorBorderSecondary};
    padding-right: 12px;
  `,

  fileList: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 58vh;
    overflow-y: auto;
  `,

  fileRow: css`
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) 26px;
    align-items: center;
    gap: 6px;
    padding: 5px 6px;
    border-radius: ${token.borderRadiusSM}px;
    color: ${token.colorTextSecondary};

    &:hover {
      background: ${token.colorFillTertiary};
      color: ${token.colorText};
    }
  `,

  fileStatus: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,

  filePath: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-family: ${token.fontFamilyCode};
  `,

  fileAction: css`
    width: 24px;
    height: 24px;
    border: none;
    border-radius: ${token.borderRadiusSM}px;
    background: transparent;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;

    &:hover {
      background: ${token.colorFillSecondary};
      color: ${token.colorText};
    }
  `,

  reviewDiffPane: css`
    min-width: 0;
  `,

  memoryPath: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 8px;
    font-family: ${token.fontFamilyCode};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  memoryTextarea: css`
    width: 100%;
    min-height: 440px;
    resize: vertical;
    border: 1px solid ${token.colorBorder};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    color: ${token.colorText};
    padding: 12px;
    outline: none;
    font-family: ${token.fontFamilyCode};
    font-size: 13px;
    line-height: 1.65;

    &:focus {
      border-color: ${token.colorPrimaryBorder};
      box-shadow: 0 0 0 2px ${token.colorPrimary}18;
    }
  `,

  memorySuggestionHint: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
    color: ${token.colorTextSecondary};
    font-size: 12px;
    line-height: 1.55;
    padding: 8px 10px;
    margin-bottom: 10px;
  `,

  diffMetaBlock: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
    padding: 8px 10px;
    min-width: 0;
  `,

  diffMetaTitle: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 4px;
  `,

  diffPre: css`
    margin: 0;
    max-height: 58vh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    color: ${token.colorText};
    padding: 12px;
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.55;
  `,

  runSummaryGrid: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  `,

  runMetric: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
    padding: 9px 10px;
    min-width: 0;
  `,

  runMetricLabel: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 3px;
  `,

  runMetricValue: css`
    font-size: 13px;
    font-weight: 600;
    color: ${token.colorText};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  runList: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 60vh;
    overflow-y: auto;
    padding-right: 4px;
  `,

  runItem: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorBgContainer};
    overflow: hidden;
  `,

  runItemHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillTertiary};
  `,

  runItemTitle: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,

  runItemName: css`
    font-size: 13px;
    font-weight: 600;
    color: ${token.colorText};
  `,

  runItemMeta: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  runStatusBadge: css`
    flex-shrink: 0;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 12px;
    border: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};
    background: ${token.colorBgElevated};
  `,

  runTimeline: css`
    display: flex;
    flex-direction: column;
    padding: 8px 12px 12px;
  `,

  runTimelineRow: css`
    display: grid;
    grid-template-columns: 72px 16px minmax(0, 1fr);
    gap: 8px;
    min-height: 30px;
    align-items: flex-start;
    color: ${token.colorTextSecondary};
    font-size: 12px;
  `,

  runTimelineTime: css`
    color: ${token.colorTextTertiary};
    font-family: ${token.fontFamilyCode};
    padding-top: 3px;
  `,

  runTimelineDot: css`
    width: 8px;
    height: 8px;
    margin-top: 7px;
    border-radius: 50%;
    background: ${token.colorBorder};
  `,

  runTimelineText: css`
    min-width: 0;
    padding: 2px 0 7px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,

  runTimelineLabel: css`
    color: ${token.colorText};
    font-weight: 500;
  `,

  runTimelineDetail: css`
    margin-top: 2px;
    color: ${token.colorTextTertiary};
    font-family: ${token.fontFamilyCode};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,

  paramsPanel: css`
    width: 320px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-family: ${token.fontFamily};

    .ant-segmented {
      width: 100%;
      font-family: ${token.fontFamily};
    }

    .ant-segmented-item-label {
      min-width: 0;
      padding-inline: 8px;
      overflow: visible;
      text-overflow: clip;
    }
  `,

  paramLabel: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 5px;
    line-height: 1.4;
    user-select: none;
  `,

  paramHint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    padding: 4px 0;
  `,

  modelList: css`
    max-height: 300px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  `,

  modelRow: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 7px 10px;
    border-radius: ${token.borderRadiusSM}px;
    border: none;
    background: transparent;
    color: ${token.colorText};
    font-size: 13px;
    font-family: ${token.fontFamily};
    font-weight: 400;
    cursor: pointer;
    outline: none;
    text-align: left;
    width: 100%;
    transition:
      background ${token.motionDurationFast},
      color ${token.motionDurationFast};

    &:hover {
      background: ${token.colorFillSecondary};
    }
  `,

  modelRowActive: css`
    background: ${token.colorPrimaryBg};
    color: ${token.colorPrimary};
    font-weight: 500;

    &:hover {
      background: ${token.colorPrimaryBgHover};
    }
  `,

  modelCheckSlot: css`
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  `,

  modelRowLabel: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  modelGroupLabel: css`
    padding: 6px 10px 3px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0;
    color: ${token.colorTextTertiary};
    user-select: none;
  `,

  modelRowTag: css`
    margin-left: auto;
    padding: 0 6px;
    border-radius: ${token.borderRadiusSM}px;
    font-size: 10px;
    line-height: 16px;
    background: ${token.colorFillSecondary};
    color: ${token.colorTextTertiary};
    flex-shrink: 0;
  `,

  modelInfoPopover: css`
    .ant-popover-inner {
      padding: 14px;
      border: 1px solid ${token.colorBorderSecondary};
      border-radius: ${token.borderRadiusLG}px;
      box-shadow: ${token.boxShadowSecondary};
    }
  `,

  modelChipName: css`
    font-weight: 500;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  modelChipSub: css`
    color: ${token.colorTextTertiary};
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  modelChipBadge: css`
    background: ${token.colorFillTertiary};
    color: ${token.colorTextSecondary};
    border-radius: 4px;
    padding: 0 5px;
    font-size: 10px;
    line-height: 15px;
  `,

  modelRowMeta: css`
    margin-left: auto;
    font-size: 11px;
    color: ${token.colorTextQuaternary};
    flex: none;
  `,

  modeList: css`
    display: flex;
    flex-direction: column;
    gap: 1px;
  `,

  modeRow: css`
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 6px;
    border: none;
    background: transparent;
    border-radius: 5px;
    cursor: pointer;
    text-align: left;
    font-size: 12px;
    color: ${token.colorText};
    font-family: ${token.fontFamily};

    &:hover {
      background: ${token.colorFillTertiary};
    }
  `,

  modeHint: css`
    color: ${token.colorTextTertiary};
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  modeRiskTag: css`
    margin-left: auto;
    flex: none;
    font-size: 10px;
    line-height: 15px;
    padding: 0 5px;
    border-radius: 4px;
    background: ${token.colorWarningBg};
    color: ${token.colorWarningText};
  `,

  paramsMoreToggle: css`
    display: flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    padding: 2px 0;
    cursor: pointer;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    font-family: ${token.fontFamily};

    &:hover {
      color: ${token.colorText};
    }
  `,

  paramGrid: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  `,

  slashPanel: css`
    margin-bottom: 8px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorder};
    background: ${token.colorBgElevated};
    box-shadow: ${token.boxShadowSecondary};
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
  `,

  slashItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: ${token.borderRadiusSM}px;
    cursor: pointer;
    font-size: 13px;
    color: ${token.colorText};
  `,

  slashItemActive: css`
    background: ${token.colorFillSecondary};
  `,

  slashName: css`
    font-weight: 500;
    flex-shrink: 0;
  `,

  slashDesc: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,

  imageStrip: css`
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  `,

  imageThumb: css`
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid ${token.colorBorder};
    overflow: hidden;
    flex-shrink: 0;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  `,

  imageRemove: css`
    position: absolute;
    top: 2px;
    right: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: none;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  `,

  /* bottom 要够高:贴着输入区放的话会和输入框上那排「模型 / 运行 / 记忆」挤在
     一起,想点回到底部反而先碰到那排按钮。 */
  scrollBottomBtn: css`
    position: absolute;
    bottom: 64px;
    left: 50%;
    transform: translateX(-50%);
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid ${token.colorBorder};
    background: ${token.colorBgElevated};
    color: ${token.colorTextSecondary};
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: ${token.boxShadow};
    outline: none;
    z-index: 100;
  `,
}))

export type StylesType = ReturnType<typeof useStyles>['styles']
export type CxType = ReturnType<typeof useStyles>['cx']
/** antd-style 主题 token —— 组件里解构成 `theme: token`。 */
export type ChatPaneToken = ReturnType<typeof useStyles>['theme']

/** 运行状态到主题色的映射:属于取色而非文案,所以留在样式层。 */
export function runStatusColor(status: RunStatus, token: ChatPaneToken): string {
  if (status === 'running') return token.colorPrimary
  if (status === 'done') return token.colorSuccess
  if (status === 'error') return token.colorError
  return token.colorTextTertiary
}
