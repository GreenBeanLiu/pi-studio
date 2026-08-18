// 这个模型必须是 DEFAULT_MODEL_ROUTE.provider 那个 profile 真的供得出的。原来写的
// gpt-5.6-luna 网关侧从来没有过,于是 selectRuntimeModelRoute 的「云端默认」分支一直
// 不命中,悄悄掉到最后一档(第一个 profile 的第一个模型 = codex-auto-review,一个代码
// 审查专用模型当聊天默认)。之前是靠直连那条腿接住才没暴露。
export const DEFAULT_MODEL_ROUTE = {
  provider: 'three-a-main',
  model: 'gpt-5.6-sol',
} as const

export const DEFAULT_THINKING_LEVEL = 'high' as const
