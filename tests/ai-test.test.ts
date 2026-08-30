/**
 * AI 测试连接单元测试。
 * 覆盖：HTTP 200/401/403/404/429/5xx/400 → code 映射、超时/网络 → network、
 * 缺参 → unknown、请求构造（normalizeBaseUrl 版本化路径不追加 /v1）；
 * 并断言所有 detail 绝不包含 apiKey（含响应体故意夹带 key 的场景）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ai-client 依赖 config/electron 链路，测试里整体 mock（只保留 buildApiUrl 行为）
vi.mock('../src/main/ai-client', () => ({
  buildApiUrl: (baseUrl: string) => baseUrl + '/chat/completions',
}))

import { testAIConnection } from '../src/main/ai-test'
import { normalizeBaseUrl } from '../src/main/ai-providers'
import type { AITestParams } from '../src/shared/types'
import { fakeCred } from './fake-cred'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const TEST_KEY = 'sk-test-secret-key-1234567890'

function params(overrides: Partial<AITestParams> = {}): AITestParams {
  return {
    baseUrl: 'https://api.example.com',
    apiKey: TEST_KEY,
    model: 'test-model',
    providerId: 'custom',
    ...overrides,
  }
}

function mockResponse(status: number, body: string) {
  mockFetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response)
}

describe('testAIConnection HTTP 状态码映射', () => {
  it('200 → ok，detail 只含状态码', async () => {
    mockResponse(200, '')
    const r = await testAIConnection(params())
    expect(r.success).toBe(true)
    expect(r.code).toBe('ok')
    expect(r.detail).toContain('HTTP 200')
    expect(r.detail).not.toContain(TEST_KEY)
  })

  it('401 → invalid_key，detail 不含 apiKey（即使响应体夹带）', async () => {
    mockResponse(
      401,
      JSON.stringify({ error: { message: 'bad key ' + TEST_KEY, code: 'invalid' } }),
    )
    const r = await testAIConnection(params())
    expect(r.success).toBe(false)
    expect(r.code).toBe('invalid_key')
    expect(r.detail).toContain('401')
    expect(r.detail).not.toContain(TEST_KEY)
  })

  it('403 → no_permission_or_balance', async () => {
    mockResponse(403, '')
    const r = await testAIConnection(params())
    expect(r.code).toBe('no_permission_or_balance')
    expect(r.detail).not.toContain(TEST_KEY)
  })

  it('404 → bad_url，detail 提示检查 /v1', async () => {
    mockResponse(404, '')
    const r = await testAIConnection(params())
    expect(r.code).toBe('bad_url')
    expect(r.detail).toContain('/v1')
    expect(r.detail).not.toContain(TEST_KEY)
  })

  it('429 → rate_limited', async () => {
    mockResponse(429, '')
    const r = await testAIConnection(params())
    expect(r.code).toBe('rate_limited')
    expect(r.detail).not.toContain(TEST_KEY)
  })

  it('5xx → unknown，detail 只含状态码与脱敏摘要（超长响应体截断）', async () => {
    mockResponse(500, 'x'.repeat(5000) + TEST_KEY)
    const r = await testAIConnection(params())
    expect(r.code).toBe('unknown')
    expect(r.detail).toContain('HTTP 500')
    expect(r.detail).not.toContain(TEST_KEY)
    expect(r.detail.length).toBeLessThan(400)
  })

  it('400 → unknown，JSON error 摘要可读', async () => {
    mockResponse(
      400,
      JSON.stringify({ error: { message: 'model not found', code: 'model_error' } }),
    )
    const r = await testAIConnection(params())
    expect(r.code).toBe('unknown')
    expect(r.detail).toContain('model_error')
    expect(r.detail).toContain('model not found')
  })
})

describe('testAIConnection 网络与入参', () => {
  it('超时（AbortError）→ network', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))
    const r = await testAIConnection(params())
    expect(r.code).toBe('network')
    expect(r.detail).toContain('超时')
  })

  it('网络错误 → network，detail 不含 apiKey', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed ' + TEST_KEY))
    const r = await testAIConnection(params())
    expect(r.code).toBe('network')
    expect(r.detail).not.toContain(TEST_KEY)
  })

  it('缺 baseUrl / apiKey / model → unknown，不发请求', async () => {
    expect((await testAIConnection(params({ baseUrl: '' }))).code).toBe('unknown')
    expect((await testAIConnection(params({ apiKey: fakeCred('') }))).code).toBe('unknown')
    expect((await testAIConnection(params({ model: '' }))).code).toBe('unknown')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('testAIConnection 请求构造', () => {
  it('版本化路径（智谱 /api/paas/v4）不追加 /v1；普通地址补 /v1', async () => {
    mockResponse(200, '')
    const r = await testAIConnection(
      params({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', providerId: 'zhipu' }),
    )
    expect(r.code).toBe('ok')
    expect(mockFetch.mock.calls[0][0]).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')

    mockFetch.mockClear()
    await testAIConnection(params())
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions')
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1')
  })

  it('请求体为 max_tokens=1 的 ping 消息，Authorization 为 Bearer key', async () => {
    mockResponse(200, '')
    await testAIConnection(params())
    const [, init] = mockFetch.mock.calls[0]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ' + TEST_KEY)
    const body = JSON.parse(init.body as string)
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(body.model).toBe('test-model')
  })
})
