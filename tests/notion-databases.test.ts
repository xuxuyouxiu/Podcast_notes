import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mapNotionDatabases, listNotionDatabases } from '../src/main/notion-databases'
import { fakeCred } from './fake-cred'

const { mockLoadConfig } = vi.hoisted(() => ({ mockLoadConfig: vi.fn() }))
vi.mock('../src/main/config', () => ({ loadConfig: mockLoadConfig }))

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  mockLoadConfig.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mapNotionDatabases', () => {
  it('只映射 object=database 的条目，标题取 plain_text 拼接', () => {
    const json = {
      results: [
        { object: 'database', id: 'db-1', title: [{ plain_text: '播客知识库' }] },
        { object: 'database', id: 'db-2', title: [{ plain_text: '我的' }, { plain_text: '任务' }] },
        { object: 'page', id: 'pg-1', title: [{ plain_text: '普通页面' }] },
        { object: 'database', id: '', title: [] },
      ],
    }
    expect(mapNotionDatabases(json)).toEqual([
      { id: 'db-1', title: '播客知识库' },
      { id: 'db-2', title: '我的任务' },
    ])
  })

  it('标题为空时用 id 前 8 位兜底', () => {
    expect(
      mapNotionDatabases({ results: [{ object: 'database', id: 'abcdef123456', title: [] }] }),
    ).toEqual([{ id: 'abcdef123456', title: 'abcdef12' }])
  })

  it('异常响应返回空数组', () => {
    expect(mapNotionDatabases(null)).toEqual([])
    expect(mapNotionDatabases({})).toEqual([])
    expect(mapNotionDatabases({ results: 'nope' })).toEqual([])
  })
})

describe('listNotionDatabases', () => {
  it('未配置 token → 可读错误，不发请求', async () => {
    mockLoadConfig.mockReturnValue({ export: { notion: { token: fakeCred(''), database_id: '' } } })
    const result = await listNotionDatabases()
    expect(result.success).toBe(false)
    expect(result.error).toContain('未配置')
  })

  it('200 → 返回数据库列表', async () => {
    mockLoadConfig.mockReturnValue({
      export: { notion: { token: fakeCred('ntn_test'), database_id: '' } },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          results: [
            { object: 'database', id: 'd9824bdc-8445-4327-be8b-5b47500af6ce', title: [{ plain_text: '播客知识库' }] },
          ],
        }),
      ),
    )
    const result = await listNotionDatabases()
    expect(result.success).toBe(true)
    expect(result.databases).toEqual([
      { id: 'd9824bdc-8445-4327-be8b-5b47500af6ce', title: '播客知识库' },
    ])
  })

  it('401/403 → Token 无效', async () => {
    mockLoadConfig.mockReturnValue({
      export: { notion: { token: fakeCred('ntn_bad'), database_id: '' } },
    })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { message: 'unauthorized' })))
    const result = await listNotionDatabases()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Token 无效')
  })

  it('网络错误 → 可读提示', async () => {
    mockLoadConfig.mockReturnValue({
      export: { notion: { token: fakeCred('ntn_test'), database_id: '' } },
    })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const result = await listNotionDatabases()
    expect(result.success).toBe(false)
    expect(result.error).toContain('网络')
  })
})
