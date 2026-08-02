import { describe, expect, it } from 'vitest'
import {
  buildGatewayProviderConfigs,
  listEnabledLlmRoutes,
  type LlmProviderProfile,
} from './llm-gateway'

const profiles: LlmProviderProfile[] = [
  {
    id: 'three-a-gpt',
    display_name: '3A GPT',
    base_url: 'https://api.3a-api.com/v1',
    api_type: 'openai-completions',
    models: ['gpt-5.5'],
    enabled: true,
    sort_order: 0,
    has_key: true,
  },
  {
    id: 'three-a-grok',
    display_name: '3A Grok',
    base_url: 'https://api.3a-api.com/v1',
    api_type: 'openai-completions',
    models: ['grok-4'],
    enabled: true,
    sort_order: 1,
    has_key: true,
  },
]

describe('LLM gateway model registration', () => {
  it('registers every profile as an independently switchable pi provider', () => {
    const providers = buildGatewayProviderConfigs('https://trail-api.glanger.xyz/', profiles)

    expect(providers['three-a-gpt']).toMatchObject({
      baseUrl: 'https://trail-api.glanger.xyz/llm/v1/three-a-gpt',
      api: 'openai-completions',
      apiKey: '$PI_STUDIO_LLM_KEY',
      models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
    })
    expect(providers['three-a-grok']).toMatchObject({
      baseUrl: 'https://trail-api.glanger.xyz/llm/v1/three-a-grok',
      models: [{ id: 'grok-4', name: 'grok-4' }],
    })
    // 推理类模型(grok-4/gpt-5)补上 reasoning 元数据,否则 UI 调不了推理深度
    expect(providers['three-a-grok'].models[0]).toMatchObject({
      reasoning: true,
      compat: { supportsReasoningEffort: true },
    })
  })

  it('never writes an upstream or desktop key into the model config', () => {
    const json = JSON.stringify(buildGatewayProviderConfigs('https://relay.example', profiles))

    expect(json).not.toContain('api.3a-api.com')
    expect(json).not.toContain('upstream-secret')
    expect(json).toContain('$PI_STUDIO_LLM_KEY')
  })

  it('formats only enabled cloud catalog models as provider routes', () => {
    const routes = listEnabledLlmRoutes({
      providers: [
        ...profiles,
        {
          ...profiles[0],
          id: 'disabled-provider',
          models: ['hidden-model'],
          enabled: false,
        },
      ],
    })

    expect(routes).toEqual(['three-a-gpt::gpt-5.5', 'three-a-grok::grok-4'])
  })

  it('projects DeepSeek V4 with its official thinking and tool-call compatibility', () => {
    const providers = buildGatewayProviderConfigs('https://relay.example', [
      {
        id: 'deepseek',
        display_name: 'DeepSeek 官方',
        base_url: 'https://api.deepseek.com',
        api_type: 'openai-completions',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        enabled: true,
        sort_order: 0,
        has_key: true,
      },
    ])

    expect(providers.deepseek.models).toEqual([
      expect.objectContaining({
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        thinkingLevelMap: {
          minimal: 'low',
          low: 'low',
          medium: 'high',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        compat: {
          supportsReasoningEffort: true,
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: 'deepseek',
        },
      }),
      expect.objectContaining({ id: 'deepseek-v4-pro', reasoning: true }),
    ])
  })
})
