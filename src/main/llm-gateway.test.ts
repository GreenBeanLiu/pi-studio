import { describe, expect, it } from 'vitest'
import { buildGatewayProviderConfigs, type LlmProviderProfile } from './llm-gateway'

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
  })

  it('never writes an upstream or desktop key into the model config', () => {
    const json = JSON.stringify(buildGatewayProviderConfigs('https://relay.example', profiles))

    expect(json).not.toContain('api.3a-api.com')
    expect(json).not.toContain('upstream-secret')
    expect(json).toContain('$PI_STUDIO_LLM_KEY')
  })
})
