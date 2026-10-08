/**
 * Models a public worker may select. Checked 2026-10-08.
 *
 * DeepSeek: official API only (https://api-docs.deepseek.com/). OpenAI-format base URL, key from DeepSeek's console.
 * deepseek-chat and deepseek-reasoner were retired 2026-07-24 and are not offered.
 *
 * Codex: slugs with visibility "list" from `codex debug models` on codex-cli 0.146.0. Hidden slugs are not offered.
 * Claude Code: first-party aliases and Anthropic API ids from https://code.claude.com/docs/en/model-config
 * and https://platform.claude.com/docs/en/models/overview. No Bedrock, Foundry, Vertex, or gateway ids.
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'
export const DEEPSEEK_RETIRED = ['deepseek-chat', 'deepseek-reasoner'] as const

export const CODEX_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
] as const

export const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet (latest on your Claude subscription)' },
  { id: 'opus', label: 'Opus (latest on your Claude subscription)' },
  { id: 'haiku', label: 'Haiku (latest on your Claude subscription)' },
  { id: 'fable', label: 'Fable' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
] as const

export function modelList(rows: readonly { id: string; label: string }[]): string {
  return rows.map((m) => `${m.id.padEnd(22)} ${m.label}`).join('\n')
}

/** Public DeepSeek config: official host, OpenAI format, one of the two current models. */
export function assertPublicDeepseek(cfg: {
  provider?: string
  runtime: string
  baseUrl?: string
  baseUrlEnv?: string
  model: string
  family: string
  cheapModel?: string
}): void {
  if (cfg.provider !== 'deepseek') {
    throw new Error('Public workers can configure only the official DeepSeek API (pit model --provider deepseek). Other providers are for official Pit seats.')
  }
  if (cfg.runtime !== 'openai-compat') {
    throw new Error('The public DeepSeek path uses https://api.deepseek.com (OpenAI format).')
  }
  const base = (cfg.baseUrl ?? '').replace(/\/+$/, '')
  if (cfg.baseUrlEnv || base !== DEEPSEEK_BASE_URL) {
    throw new Error('Public DeepSeek uses https://api.deepseek.com only. A custom base URL is not a user option.')
  }
  const retired = (id?: string) => id !== undefined && (DEEPSEEK_RETIRED as readonly string[]).includes(id)
  if (retired(cfg.model) || retired(cfg.cheapModel)) {
    throw new Error('deepseek-chat and deepseek-reasoner were retired on 2026-07-24. Use --model deepseek-flash or --model deepseek-v4-pro.')
  }
  if (!(DEEPSEEK_MODELS as readonly string[]).includes(cfg.model)) {
    throw new Error(`--model must be ${DEEPSEEK_MODELS.join(' or ')}`)
  }
  if (cfg.cheapModel !== undefined && !(DEEPSEEK_MODELS as readonly string[]).includes(cfg.cheapModel)) {
    throw new Error(`--cheap-model must be ${DEEPSEEK_MODELS.join(' or ')}`)
  }
  if (cfg.family !== 'deepseek') throw new Error('family must be deepseek')
}

export function assertCodexModel(id: string): void {
  if (!CODEX_MODELS.some((m) => m.id === id)) {
    throw new Error(`--codex-model must be one of ${CODEX_MODELS.map((m) => m.id).join(', ')} (pit runtime --models)`)
  }
}

export function assertClaudeModel(id: string): void {
  if (!CLAUDE_MODELS.some((m) => m.id === id)) {
    throw new Error(`--claude-model must be one of ${CLAUDE_MODELS.map((m) => m.id).join(', ')} (pit runtime --models). Third-party model ids are not a user option.`)
  }
}
