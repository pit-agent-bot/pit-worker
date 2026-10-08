import { describe, expect, it } from 'vitest'
import { chatComplete, messagesComplete, normalizeModelConfig } from '../src/model.ts'
import { presetEndpoint, presetFamily, providerPreset, PROVIDERS, providerTable } from '../src/providers.ts'

describe('provider presets', () => {
  it('cover the mainstream vendors with https endpoints and a key env name', () => {
    for (const id of ['openai', 'anthropic', 'deepseek', 'kimi', 'kimi-cn', 'glm', 'glm-cn', 'qwen', 'qwen-cn', 'openrouter']) {
      const p = PROVIDERS[id]!
      expect(p, id).toBeTruthy()
      expect(p.keyEnv).toMatch(/^[A-Z_]+$/)
      for (const ep of [p.openai, p.anthropic]) if (ep) expect(ep.baseUrl).toMatch(/^https:\/\//)
    }
    expect(providerPreset('moonshot').id).toBe('kimi')
    expect(providerPreset('zhipu').id).toBe('glm-cn')
    expect(() => providerPreset('nope')).toThrow(/unknown provider/)
    expect(providerTable()).toContain('deepseek')
  })

  it('routers derive the family from the model vendor', () => {
    expect(presetFamily(PROVIDERS.openrouter!, 'anthropic/claude-x')).toBe('claude')
    expect(presetFamily(PROVIDERS.openrouter!, 'z-ai/glm-5.3')).toBe('glm')
    expect(() => presetFamily(PROVIDERS.openrouter!, 'unknown/x')).toThrow(/family/)
    expect(presetEndpoint(PROVIDERS.deepseek!, 'anthropic-compat').baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(() => presetEndpoint(PROVIDERS.openai!, 'anthropic-compat')).toThrow(/no anthropic-compat/)
  })

  it('model config: --provider fills the blanks, explicit fields win', () => {
    const c = normalizeModelConfig({ provider: 'glm' })
    expect(c).toMatchObject({ runtime: 'openai-compat', family: 'glm', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', keyEnv: 'ZAI_API_KEY' })
    const a = normalizeModelConfig({ provider: 'kimi', runtime: 'anthropic-compat', model: 'kimi-k2.6', keyEnv: 'MY_KIMI' })
    expect(a).toMatchObject({ runtime: 'anthropic-compat', family: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k2.6', keyEnv: 'MY_KIMI' })
    expect(normalizeModelConfig({ provider: 'anthropic' }).runtime).toBe('anthropic-compat')
    expect(() => normalizeModelConfig({ provider: 'openrouter' })).toThrow(/family|model/)
    expect(normalizeModelConfig({ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' }).family).toBe('deepseek')
    expect(() => normalizeModelConfig({ runtime: 'grpc', family: 'gpt', keyEnv: 'K', model: 'm', baseUrl: 'https://x' })).toThrow(/runtime must be/)
  })
})

describe('anthropic-compat messages', () => {
  const cfg = (over: Record<string, unknown> = {}) => normalizeModelConfig({ provider: 'deepseek', runtime: 'anthropic-compat', keyEnv: 'K', retries: 1, ...over })
  const env = { K: 'ds-key-0123456789abcdef' }

  it('POST /v1/messages with system split out, key headers, usage + stop reason mapped', async () => {
    let url = ''
    let init: RequestInit = {}
    const f = (async (u: string, i: RequestInit) => {
      url = u
      init = i
      return new Response(JSON.stringify({ id: 'msg_1', model: 'deepseek-flash', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'Hello' }], stop_reason: 'max_tokens', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 3 } }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await chatComplete(cfg(), [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], { fetch: f, env })
    expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    const h = init.headers as Record<string, string>
    expect(h['x-api-key']).toBe(env.K)
    expect(h.authorization).toBe(`Bearer ${env.K}`)
    expect(h['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ model: 'deepseek-flash', system: 'SYS', messages: [{ role: 'user', content: 'hi' }] })
    expect(r).toMatchObject({ text: 'Hello', finishReason: 'length', usage: { promptTokens: 15, completionTokens: 3, totalTokens: 18, cachedTokens: 100 } })
    expect(r.providerMsgIdHash).toMatch(/^0x/)
  })

  it('official Anthropic endpoint gets x-api-key only', async () => {
    let h: Record<string, string> = {}
    const f = (async (_u: string, i: RequestInit) => {
      h = i.headers as Record<string, string>
      return new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: 'ok' }], usage: {} }), { status: 200 })
    }) as unknown as typeof fetch
    await messagesComplete(normalizeModelConfig({ provider: 'anthropic', keyEnv: 'K' }), [{ role: 'user', content: 'x' }], { fetch: f, env })
    expect(h.authorization).toBeUndefined()
  })

  it('retries 529 / 429, fails fast on 401 with the key scrubbed', async () => {
    let n = 0
    const f = (async () => {
      n++
      return n === 1 ? new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 }) : new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await chatComplete(cfg(), [{ role: 'user', content: 'x' }], { fetch: f, env, sleep: async () => {} })
    expect(r.attempts).toBe(2)
    const bad = (async () => new Response(JSON.stringify({ type: 'error', error: { message: `invalid x-api-key ${env.K}` } }), { status: 401 })) as unknown as typeof fetch
    const e = await chatComplete(cfg(), [{ role: 'user', content: 'x' }], { fetch: bad, env, sleep: async () => {} }).catch((x) => x)
    expect(e.status).toBe(401)
    expect(e.retryable).toBe(false)
    expect(e.message).not.toContain(env.K)
  })
})
