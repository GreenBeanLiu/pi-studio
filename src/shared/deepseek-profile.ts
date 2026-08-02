import type { LlmProfileWrite } from './contracts'

export const DEEPSEEK_PROFILE_ID = 'deepseek'
export const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_OFFICIAL_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
] as const

export function createDeepSeekProfileWrite(
  apiKey: string,
  sortOrder: number,
): LlmProfileWrite {
  return {
    id: DEEPSEEK_PROFILE_ID,
    display_name: 'DeepSeek 官方',
    base_url: DEEPSEEK_OFFICIAL_BASE_URL,
    api_type: 'openai-completions',
    api_key: apiKey,
    models: [...DEEPSEEK_OFFICIAL_MODELS],
    enabled: true,
    sort_order: sortOrder,
  }
}
