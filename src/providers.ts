/**
 * Provider presets for the in-process API-key runtime and for CLI harnesses pointed at a vendor endpoint. A preset
 * fills in the family, base URL, default model and the usual key variable name; every field stays overridable
 * (`pit model --set`, `pit runtime --set`). Default model ids are starting points only (vendors rename models often):
 * set --model to the id your account has.
 *
 * Some vendors map unknown model ids to a default model on their side (DeepSeek's Anthropic endpoint does); Pit cannot
 * see that, so use exact ids from the vendor's model list. Pit itself never substitutes a model.
 *
 * Wire APIs:
 * - openai-compat: POST <baseUrl>/chat/completions (OpenAI, DeepSeek, Kimi, GLM, most others)
 * - anthropic-compat: POST <baseUrl>/v1/messages (Anthropic, and the Anthropic-compatible endpoints DeepSeek, Kimi and
 *   GLM offer for Claude Code)
 */
export type WireApi = 'openai-compat' | 'anthropic-compat'

export interface ProviderPreset {
  id: string
  /** Model family declared to the scheduler and claimed in receipts ('' = derived from the model id, for routers). */
  family: string
  label: string
  /** Default name of the env var holding the key (only the NAME is ever stored). */
  keyEnv: string
  /** model '' = no default: the holder must pick one (routers). */
  openai?: { baseUrl: string; model: string }
  anthropic?: { baseUrl: string; model: string }
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  openai: { id: 'openai', family: 'gpt', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' } },
  anthropic: { id: 'anthropic', family: 'claude', label: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' } },
  deepseek: {
    id: 'deepseek',
    family: 'deepseek',
    label: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    openai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
    anthropic: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' },
  },
  kimi: {
    id: 'kimi',
    family: 'kimi',
    label: 'Kimi (Moonshot, international)',
    keyEnv: 'MOONSHOT_API_KEY',
    openai: { baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3' },
    anthropic: { baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k3' },
  },
  'kimi-cn': {
    id: 'kimi-cn',
    family: 'kimi',
    label: 'Kimi (Moonshot, mainland China)',
    keyEnv: 'MOONSHOT_API_KEY',
    openai: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
    anthropic: { baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k3' },
  },
  glm: {
    id: 'glm',
    family: 'glm',
    label: 'GLM (Z.ai, international)',
    keyEnv: 'ZAI_API_KEY',
    openai: { baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3' },
    anthropic: { baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3' },
  },
  'glm-cn': {
    id: 'glm-cn',
    family: 'glm',
    label: 'GLM (Zhipu BigModel, mainland China)',
    keyEnv: 'ZHIPU_API_KEY',
    openai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
    anthropic: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' },
  },
  qwen: {
    id: 'qwen',
    family: 'qwen',
    label: 'Qwen (Alibaba Model Studio, Singapore)',
    keyEnv: 'DASHSCOPE_API_KEY',
    openai: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.6-plus' },
    anthropic: { baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic', model: 'qwen3.6-plus' },
  },
  'qwen-cn': {
    id: 'qwen-cn',
    family: 'qwen',
    label: 'Qwen (Alibaba Model Studio, Beijing)',
    keyEnv: 'DASHSCOPE_API_KEY',
    openai: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.6-plus' },
    anthropic: { baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3.6-plus' },
  },
  openrouter: {
    id: 'openrouter',
    family: '',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    openai: { baseUrl: 'https://openrouter.ai/api/v1', model: '' },
    anthropic: { baseUrl: 'https://openrouter.ai/api', model: '' },
  },
}

/** Router model ids are "<vendor>/<model>": the vendor decides the family the seat declares. */
const VENDOR_FAMILY: Record<string, string> = { anthropic: 'claude', openai: 'gpt', google: 'gemini', deepseek: 'deepseek', moonshotai: 'kimi', 'z-ai': 'glm', zhipuai: 'glm', qwen: 'qwen' }

/** Family for a preset + model (routers derive it from the model's vendor prefix). */
export function presetFamily(p: ProviderPreset, model: string | undefined): string {
  if (p.family) return p.family
  const vendor = (model ?? '').split('/')[0]!.toLowerCase()
  const fam = VENDOR_FAMILY[vendor]
  if (!fam) throw new Error(`${p.label}: cannot tell the model family of "${model ?? ''}" (use a <vendor>/<model> id from ${Object.keys(VENDOR_FAMILY).join(', ')}, or pass --family)`)
  return fam
}

export const PROVIDER_ALIASES: Record<string, string> = { moonshot: 'kimi', 'moonshot-cn': 'kimi-cn', zai: 'glm', 'z.ai': 'glm', zhipu: 'glm-cn', bigmodel: 'glm-cn', dashscope: 'qwen', alibaba: 'qwen', gpt: 'openai', claude: 'anthropic' }

export function providerPreset(id: string): ProviderPreset {
  const p = PROVIDERS[PROVIDER_ALIASES[id.toLowerCase()] ?? id.toLowerCase()]
  if (!p) throw new Error(`unknown provider "${id}" (known: ${Object.keys(PROVIDERS).join(', ')}; or give --base-url, --model, --family yourself)`)
  return p
}

/** Endpoint + model of a preset for one wire API (the first one the preset has when `api` is not given). */
export function presetEndpoint(p: ProviderPreset, api?: WireApi): { api: WireApi; baseUrl: string; model: string } {
  const want = api ?? (p.openai ? 'openai-compat' : 'anthropic-compat')
  const ep = want === 'openai-compat' ? p.openai : p.anthropic
  if (!ep) throw new Error(`${p.label} has no ${want} endpoint preset`)
  return { api: want, ...ep }
}

export function providerTable(): string {
  return Object.values(PROVIDERS)
    .map((p) => `${p.id.padEnd(10)} family=${(p.family || '(by model)').padEnd(10)} key=${p.keyEnv.padEnd(17)} ${p.openai ? `openai ${p.openai.baseUrl} (${p.openai.model || 'pick a model'})` : ''}${p.openai && p.anthropic ? '; ' : ''}${p.anthropic ? `anthropic ${p.anthropic.baseUrl} (${p.anthropic.model || 'pick a model'})` : ''}`)
    .join('\n')
}
