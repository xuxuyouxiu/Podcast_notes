import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Notion 集成测试（无真实凭据环境）：
 * - vi.mock('electron')：notion-converter → exporter → config → electron 的导入链，
 *   electron 在 node 测试环境不可用，与 config.test.ts 同样处理
 * - vi.stubGlobal('fetch')：断言请求构造（URL / 方法 / 头 / body），不产生真实网络请求
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:/Users/test/AppData/Roaming/PodMuse') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))

import { fakeCred } from './fake-cred'
import {
  testNotionConnection,
  exportToNotion,
  markdownToNotionBlocks,
} from '../src/main/notion-converter'

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastCallInit() {
  const calls = fetchMock.mock.calls
  return calls[calls.length - 1][1] as RequestInit & { headers?: Record<string, string> }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ===== testNotionConnection：参数校验 =====

describe('testNotionConnection 参数校验', () => {
  it('token 为空时返回可读错误且不发请求', async () => {
    const result = await testNotionConnection({ token: fakeCred(''), databaseId: 'db-1' })
    expect(result).toEqual({ success: false, error: 'Token 和 Database ID 不能为空' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('databaseId 为空时返回可读错误且不发请求', async () => {
    const result = await testNotionConnection({ token: fakeCred('secret_xxx'), databaseId: '' })
    expect(result).toEqual({ success: false, error: 'Token 和 Database ID 不能为空' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('token 为纯空白时同样拒绝', async () => {
    const result = await testNotionConnection({ token: fakeCred('   '), databaseId: 'db-1' })
    expect(result).toEqual({ success: false, error: 'Token 和 Database ID 不能为空' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ===== testNotionConnection：请求构造 =====

describe('testNotionConnection 请求构造', () => {
  it('构造正确的 URL / Authorization / Notion-Version 头并返回 database 标题', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { title: [{ plain_text: '播客笔记库' }] }),
    )
    const result = await testNotionConnection({ token: fakeCred('  secret_xxx  '), databaseId: '  db-123  ' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(url).toBe('https://api.notion.com/v1/databases/db-123')
    expect(init?.method).toBe('GET')
    expect(headers.Authorization).toBe('Bearer secret_xxx')
    expect(headers['Notion-Version']).toBe('2022-06-28')
    // 30s 超时用 AbortController 实现，signal 必须传入
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({ success: true, databaseTitle: '播客笔记库' })
  })

  it('200 但无 title 时 databaseTitle 回退为「未命名」', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { title: [] }))
    const result = await testNotionConnection({ token: fakeCred('t'), databaseId: 'd' })
    expect(result).toEqual({ success: true, databaseTitle: '未命名' })
  })

  it('401 时返回 Integration Token 无效或已过期', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'unauthorized' }))
    const result = await testNotionConnection({ token: fakeCred('t'), databaseId: 'd' })
    expect(result).toEqual({ success: false, error: 'Integration Token 无效或已过期' })
  })

  it('404 时返回 Database 不存在或集成未共享该 database', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }))
    const result = await testNotionConnection({ token: fakeCred('t'), databaseId: 'd' })
    expect(result).toEqual({ success: false, error: 'Database 不存在或集成未共享该 database' })
  })

  it('其它非 2xx 时透传 API 错误信息', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: 'Internal server error' }))
    const result = await testNotionConnection({ token: fakeCred('t'), databaseId: 'd' })
    expect(result).toEqual({ success: false, error: 'Notion API 错误: Internal server error' })
  })

  it('网络异常时返回网络错误而非抛异常', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    const result = await testNotionConnection({ token: fakeCred('t'), databaseId: 'd' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^网络错误: fetch failed/)
  })

  it('请求中止（超时）时返回请求超时提示', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError')
    fetchMock.mockRejectedValueOnce(abortErr)
    const result = await testNotionConnection({ token: fakeCred('t'), databaseId: 'd' })
    expect(result).toEqual({ success: false, error: '网络错误: 请求超时（30s）' })
  })
})

// ===== exportToNotion：参数校验 =====

describe('exportToNotion 参数校验', () => {
  it('token 缺失时返回可读错误且不发请求', async () => {
    const result = await exportToNotion({
      token: fakeCred(''),
      databaseId: 'db-1',
      markdown: '# 笔记',
      relativePath: 'note.md',
    })
    expect(result).toEqual({ success: false, error: 'Token 和 Database ID 不能为空' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('databaseId 缺失时返回可读错误且不发请求', async () => {
    const result = await exportToNotion({
      token: fakeCred('secret_xxx'),
      databaseId: '   ',
      markdown: '# 笔记',
      relativePath: 'note.md',
    })
    expect(result).toEqual({ success: false, error: 'Token 和 Database ID 不能为空' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ===== exportToNotion：成功链路（mock fetch 依次返回 schema / query / pages） =====

const SCHEMA_200 = {
  properties: {
    Name: { type: 'title' },
    show: { type: 'rich_text' },
    tags: { type: 'multi_select' },
  },
}

describe('exportToNotion 成功链路', () => {
  it('按序调用 schema → 重复检测 query → 创建 pages，body 构造正确', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SCHEMA_200)) // GET /databases/{id}
      .mockResolvedValueOnce(jsonResponse(200, { results: [] })) // POST .../query（无重复）
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'page-1', url: 'https://notion.so/page-1', object: 'page' }),
      ) // POST /pages

    const markdown = [
      '---',
      'title: 测试集',
      'show: Podcast A',
      'tags: [AI, NLP]',
      '---',
      '# 标题',
      '',
      '- 要点一',
      '- [x] 完成项',
    ].join('\n')

    const result = await exportToNotion({
      token: fakeCred('ntn_test'),
      databaseId: 'db-1',
      markdown,
      relativePath: 'notes/测试集.md',
    })

    expect(result).toEqual({ success: true, pageId: 'page-1', pageUrl: 'https://notion.so/page-1' })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // 1) GET /databases/db-1
    const [schemaUrl, schemaInit] = fetchMock.mock.calls[0]
    expect(schemaUrl).toBe('https://api.notion.com/v1/databases/db-1')
    expect(schemaInit?.method).toBe('GET')
    expect((schemaInit?.headers as Record<string, string>).Authorization).toBe('Bearer ntn_test')
    expect((schemaInit?.headers as Record<string, string>)['Notion-Version']).toBe('2022-06-28')

    // 2) POST /databases/db-1/query：按 title property 精确查重
    const [queryUrl, queryInit] = fetchMock.mock.calls[1]
    expect(queryUrl).toBe('https://api.notion.com/v1/databases/db-1/query')
    expect(queryInit?.method).toBe('POST')
    expect(JSON.parse(String(queryInit?.body))).toEqual({
      filter: { property: 'Name', title: { equals: '测试集' } },
    })

    // 3) POST /pages：parent.database_id、properties 映射、children 与转换函数一致
    const [pagesUrl, pagesInit] = fetchMock.mock.calls[2]
    expect(pagesUrl).toBe('https://api.notion.com/v1/pages')
    expect(pagesInit?.method).toBe('POST')
    expect((pagesInit?.headers as Record<string, string>).Authorization).toBe('Bearer ntn_test')
    const pagesBody = JSON.parse(String(pagesInit?.body))
    expect(pagesBody.parent).toEqual({ database_id: 'db-1' })
    expect(pagesBody.properties.Name).toEqual({
      type: 'title',
      title: [{ type: 'text', text: { content: '测试集' } }],
    })
    expect(pagesBody.properties.show).toEqual({
      type: 'rich_text',
      rich_text: [{ type: 'text', text: { content: 'Podcast A' } }],
    })
    expect(pagesBody.properties.tags).toEqual({
      type: 'multi_select',
      multi_select: [{ name: 'AI' }, { name: 'NLP' }],
    })
    // frontmatter 剥离后 body 的转换结果
    expect(pagesBody.children).toEqual(markdownToNotionBlocks('# 标题\n\n- 要点一\n- [x] 完成项'))
    expect(pagesBody.children.map((b: { type: string }) => b.type)).toEqual([
      'heading_1',
      'bulleted_list_item',
      'to_do',
    ])
  })

  it('children 超过 100 块时截断到 100', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SCHEMA_200))
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'p', url: 'u', object: 'page' }))

    const body = Array.from({ length: 120 }, (_, i) => `- item ${i + 1}`).join('\n')
    const result = await exportToNotion({
      token: fakeCred('t'),
      databaseId: 'db-1',
      markdown: '---\ntitle: 大笔记\n---\n' + body,
      relativePath: 'big.md',
    })

    expect(result.success).toBe(true)
    const pagesBody = JSON.parse(String(lastCallInit().body))
    expect(pagesBody.children).toHaveLength(100)
    expect(pagesBody.children[99].bulleted_list_item.rich_text[0].text.content).toBe('item 100')
  })
})

// ===== exportToNotion：重复检测 =====

describe('exportToNotion 重复检测', () => {
  it('已存在同名页面时不创建新页面，返回已有 pageUrl', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SCHEMA_200))
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ url: 'https://notion.so/dup-page' }] }),
      )

    const result = await exportToNotion({
      token: fakeCred('t'),
      databaseId: 'db-1',
      markdown: '---\ntitle: 测试集\n---\n正文',
      relativePath: 'note.md',
    })

    expect(result).toEqual({
      success: false,
      error: 'Notion database 中已存在同名页面，请先手动处理或修改笔记标题',
      pageUrl: 'https://notion.so/dup-page',
    })
    // 只发了 schema + query 两个请求，没有 POST /pages
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.notion.com/v1/databases/db-1/query')
  })

  it('query 失败时视为无重复，继续创建页面', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SCHEMA_200))
      .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'p', url: 'u', object: 'page' }))

    const result = await exportToNotion({
      token: fakeCred('t'),
      databaseId: 'db-1',
      markdown: '---\ntitle: 新笔记\n---\n正文',
      relativePath: 'note.md',
    })
    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

// ===== exportToNotion：标题 fallback =====

describe('exportToNotion 标题 fallback', () => {
  it('无 frontmatter 时用文件名（去 .md）作为 title property', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SCHEMA_200))
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'p', url: 'u', object: 'page' }))

    await exportToNotion({
      token: fakeCred('t'),
      databaseId: 'db-1',
      markdown: '# 只有正文没有 frontmatter',
      relativePath: 'notes/vol42-科技早知道.md',
    })

    // 无 titleValue → 不触发重复检测 query，只发 schema + pages 两个请求
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const pagesBody = JSON.parse(String(lastCallInit().body))
    expect(pagesBody.properties.Name).toEqual({
      type: 'title',
      title: [{ type: 'text', text: { content: 'notes/vol42-科技早知道' } }],
    })
  })
})

// ===== exportToNotion：API 错误传播（由上层 exportNote 捕获并映射） =====

describe('exportToNotion API 错误传播', () => {
  it('schema 401 → 抛出「Notion Integration Token 无效或已过期」并带 status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'unauthorized' }))
    try {
      await exportToNotion({ token: fakeCred('bad'), databaseId: 'db-1', markdown: 'x', relativePath: 'a.md' })
      expect.unreachable('应当抛出 401 错误')
    } catch (e) {
      expect(e).toMatchObject({ status: 401 })
      expect((e as Error).message).toBe('Notion Integration Token 无效或已过期')
    }
  })

  it('schema 404 → 抛出「Notion Database 不存在或集成未共享该 database」', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }))
    await expect(
      exportToNotion({ token: fakeCred('t'), databaseId: 'db-x', markdown: 'x', relativePath: 'a.md' }),
    ).rejects.toThrow('Notion Database 不存在或集成未共享该 database')
  })

  it('创建页面 400 → 抛出「参数错误: ...」', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SCHEMA_200))
      .mockResolvedValueOnce(jsonResponse(400, { message: 'body failed validation' }))
    await expect(
      exportToNotion({ token: fakeCred('t'), databaseId: 'db-1', markdown: '# x', relativePath: 'a.md' }),
    ).rejects.toThrow('参数错误: body failed validation')
  })

  it('创建页面 429 → 抛出速率限制提示', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SCHEMA_200))
      .mockResolvedValueOnce(jsonResponse(429, { message: 'rate limited' }))
    await expect(
      exportToNotion({ token: fakeCred('t'), databaseId: 'db-1', markdown: '# x', relativePath: 'a.md' }),
    ).rejects.toThrow('Notion API 速率限制，请稍后再试')
  })
})

// ===== 转换缺口补充（不重复 notion-converter.test.ts 已有 46 例） =====

describe('markdown → blocks 转换缺口补充', () => {
  it('行内 markdown 链接取显示文本', () => {
    const blocks = markdownToNotionBlocks('See [doc](notes/one.md) here')
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as any).paragraph.rich_text[0].text.content).toBe('See doc here')
  })

  it('四级及以上标题按段落处理（仅支持 #~###）', () => {
    const blocks = markdownToNotionBlocks('#### Level 4')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('paragraph')
  })

  it('引号语法必须带空格（>text 按段落处理）', () => {
    const blocks = markdownToNotionBlocks('>no space')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('paragraph')
  })

  it('正文 \r\n 行结束符正常分段', () => {
    const blocks = markdownToNotionBlocks('Line 1\r\n\r\nLine 2')
    expect(blocks).toHaveLength(2)
    expect(blocks.every(b => b.type === 'paragraph')).toBe(true)
  })
})
