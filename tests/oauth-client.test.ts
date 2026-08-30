import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as http from 'http'
import type { PodcastConfig } from '@shared/types'
import { fakeCred } from './fake-cred'

/**
 * OAuth 客户端骨架单元测试（全部 mock，不发真实请求）：
 *   - callback-server 起停 / 收 code / state 校验 / 超时（真实 node http + 127.0.0.1 随机端口）
 *   - notion-oauth / feishu-oauth 的 exchange / 列表 / 选择 / 断开 / 刷新全分支
 *     （vi.stubGlobal fetch mock，含 oauth_not_configured、401、刷新）
 *   - config 脱敏：loadSafeConfig 清 token 字段；restoreProtectedFields 还原 oauth 字段
 * 凭据只出现在 mock 数据与断言里，测试全程不输出任何真实 token。
 */

// ============================================================
// Mock setup — hoisted so factories can reference these
// ============================================================

const {
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockMkdirSync,
  mockGetPath,
  mockOpenExternal,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockGetPath: vi.fn(),
  mockOpenExternal: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: mockGetPath },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: mockOpenExternal, showItemInFolder: vi.fn() },
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs')
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  }
})

vi.mock('../src/main/ai-providers', () => ({
  getAllDefaultProviderConfigs: vi.fn(() => ({})),
}))

vi.mock('../src/main/security', () => ({
  decryptField: vi.fn(),
  isSafeUrl: vi.fn(() => true),
  isSafeFilePath: vi.fn(() => true),
  isSafeExecutablePath: vi.fn(() => true),
  isSafeDirectoryPath: vi.fn(() => true),
  isPathWithinBase: vi.fn(() => true),
}))

vi.mock('../src/main/platforms/yt-dlp', () => ({
  detectYtDlp: vi.fn(),
}))

vi.mock('../src/main/backlinks', () => ({
  buildBacklinkIndex: vi.fn(),
  buildTagIndex: vi.fn(),
}))

import { loadConfig, loadSafeConfig, clearConfigCache } from '../src/main/config'
import {
  restoreProtectedFields,
  syncFeishuOAuthCredentials,
  syncNotionOAuthCredentials,
} from '../src/main/ipc/config-ipc'
import {
  startCallbackServer,
  FEISHU_CALLBACK_PATH,
  NOTION_CALLBACK_PATH,
} from '../src/main/oauth/callback-server'
import {
  FEISHU_OAUTH_REDIRECT_URI,
  NOTION_OAUTH_PORT,
  NOTION_OAUTH_REDIRECT_URI,
} from '../src/shared/constants'
import * as notion from '../src/main/oauth/notion-oauth'
import * as feishu from '../src/main/oauth/feishu-oauth'

// ============================================================
// Helpers（fs mock 组成「内存磁盘」：saveConfig 后 loadConfig 读到最新值）
// ============================================================

const USER_DATA_DIR = 'C:\Users\test\AppData\Roaming\podcast-notes'
const USER_CONFIG_PATH = path.join(USER_DATA_DIR, 'podcast_config.json')

let currentConfigJson: string | null = null

function setUserConfig(json: Record<string, unknown>): void {
  currentConfigJson = JSON.stringify(json)
  clearConfigCache()
  mockExistsSync.mockImplementation((p: string) => p === USER_CONFIG_PATH || p === USER_DATA_DIR)
}

function lastSaved(): Record<string, unknown> {
  const calls = mockWriteFileSync.mock.calls.filter(c => c[0] === USER_CONFIG_PATH)
  expect(calls.length).toBeGreaterThan(0)
  return JSON.parse(calls[calls.length - 1][1] as string) as Record<string, unknown>
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 用 node http 直连 127.0.0.1 回调端口（不经过被 stub 的全局 fetch） */
function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, res => {
        let body = ''
        res.on('data', d => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on('error', reject)
  })
}

async function waitFor(fn: () => void, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      fn()
      return
    } catch {
      if (Date.now() - start > timeoutMs) {
        fn()
        return
      }
      await new Promise(r => setTimeout(r, 25))
    }
  }
}

beforeEach(() => {
  currentConfigJson = null
  mockExistsSync.mockReset()
  mockReadFileSync.mockReset()
  mockReadFileSync.mockImplementation((p: string) =>
    p === USER_CONFIG_PATH && currentConfigJson ? currentConfigJson : '',
  )
  mockWriteFileSync.mockReset()
  mockWriteFileSync.mockImplementation((p: string, data: string) => {
    if (p === USER_CONFIG_PATH) currentConfigJson = data
  })
  mockMkdirSync.mockReset()
  mockGetPath.mockReset()
  mockGetPath.mockReturnValue(USER_DATA_DIR)
  mockOpenExternal.mockReset()
  mockOpenExternal.mockResolvedValue(undefined)
  clearConfigCache()
  feishu.closePendingFeishuAuth()
})

afterEach(async () => {
  feishu.closePendingFeishuAuth()
  const pending = feishu.getPendingFeishuAuthFlow()
  if (pending) await pending.catch(() => {})
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ============================================================
// callback-server（纯 node 模块）
// ============================================================

describe('callback-server', () => {
  it('起 127.0.0.1 随机端口，收 /feishu/callback code 后关闭并 resolve', async () => {
    const server = await startCallbackServer()
    expect(server.port).toBeGreaterThan(0)

    const wait = server.waitForCode(5000)
    const resp = await httpGet(
      `http://127.0.0.1:${server.port}${FEISHU_CALLBACK_PATH}?code=code-feishu&state=s1`,
    )
    expect(resp.status).toBe(200)
    expect(resp.body).toContain('授权成功')
    await expect(wait).resolves.toBe('code-feishu')

    // 拿到即关闭：后续 waitForCode 立即 null
    await expect(server.waitForCode(100)).resolves.toBeNull()
  })

  it('收 /notion/callback code 同样生效', async () => {
    const server = await startCallbackServer()
    const wait = server.waitForCode(5000)
    const resp = await httpGet(
      `http://127.0.0.1:${server.port}${NOTION_CALLBACK_PATH}?code=code-notion&state=s2`,
    )
    expect(resp.status).toBe(200)
    await expect(wait).resolves.toBe('code-notion')
  })

  it('指定固定端口：监听该端口（供平台后台预登记 redirect_uri）', async () => {
    const server = await startCallbackServer({ port: 47999 })
    expect(server.port).toBe(47999)
    server.close()
    await expect(server.waitForCode(100)).resolves.toBeNull()
  })

  it('expectedState 不匹配 → 400 并继续等待，匹配后才关闭', async () => {
    const server = await startCallbackServer({ expectedState: 'expected-s' })
    const wait = server.waitForCode(5000)
    const bad = await httpGet(
      `http://127.0.0.1:${server.port}${FEISHU_CALLBACK_PATH}?code=c1&state=wrong`,
    )
    expect(bad.status).toBe(400)
    const good = await httpGet(
      `http://127.0.0.1:${server.port}${FEISHU_CALLBACK_PATH}?code=c2&state=expected-s`,
    )
    expect(good.status).toBe(200)
    await expect(wait).resolves.toBe('c2')
  })

  it('无 code 的回调 → 400 且继续等待；未知路径 → 404', async () => {
    const server = await startCallbackServer()
    const wait = server.waitForCode(5000)
    const noCode = await httpGet(
      `http://127.0.0.1:${server.port}${FEISHU_CALLBACK_PATH}?error=access_denied`,
    )
    expect(noCode.status).toBe(400)
    const unknown = await httpGet(`http://127.0.0.1:${server.port}/other`)
    expect(unknown.status).toBe(404)
    const ok = await httpGet(`http://127.0.0.1:${server.port}${FEISHU_CALLBACK_PATH}?code=c3`)
    expect(ok.status).toBe(200)
    await expect(wait).resolves.toBe('c3')
  })

  it('超时 → resolve null 并关闭 server', async () => {
    const server = await startCallbackServer()
    await expect(server.waitForCode(150)).resolves.toBeNull()
    await expect(server.waitForCode(50)).resolves.toBeNull()
  })

  it('主动 close → 未决 waitForCode 立即 resolve null', async () => {
    const server = await startCallbackServer()
    const wait = server.waitForCode(5000)
    server.close()
    await expect(wait).resolves.toBeNull()
  })
})

// ============================================================
// notion-oauth
// ============================================================

describe('notion-oauth', () => {
  it('未配置 clientId/clientSecret → 所有入口 oauth_not_configured', async () => {
    setUserConfig({ notion_oauth: { clientId: '', clientSecret: '' } })

    expect(notion.getNotionStatus()).toEqual({ configured: false, connected: false })
    await expect(notion.startNotionAuth()).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    await expect(notion.startNotionAuth({ useLocalCallback: true })).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    await expect(notion.exchangeNotionCode('c')).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    await expect(notion.listNotionDatabases()).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    expect(notion.setNotionDatabase('db-1')).toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    expect(notion.disconnectNotion().connected).toBe(false)
    expect(mockOpenExternal).not.toHaveBeenCalled()
  })

  it('已配置：startNotionAuth 打开协议回调授权 URL（owner=user + state）', async () => {
    setUserConfig({ notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1' } })

    const result = await notion.startNotionAuth()
    expect(result).toEqual({ success: true })

    expect(mockOpenExternal).toHaveBeenCalledTimes(1)
    const url = new URL(mockOpenExternal.mock.calls[0][0] as string)
    expect(url.origin + url.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid-1')
    expect(url.searchParams.get('redirect_uri')).toBe('podmuse://notion/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('owner')).toBe('user')
    expect(url.searchParams.get('state')).toBeTruthy()
  })

  it('本地回调模式：临时 server 收 /notion/callback code 后自动换 token 并保存', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const u = String(input)
        if (u.includes('/v1/oauth/token')) {
          return jsonResponse(200, {
            access_token: fakeCred('ntn-secret-token'),
            workspace_id: 'ws-1',
            bot_id: 'bot-1',
            workspace_name: 'My WS',
          })
        }
        return jsonResponse(404, { message: 'not found' })
      }),
    )
    setUserConfig({ notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1' } })

    const result = await notion.startNotionAuth({ useLocalCallback: true })
    expect(result.success).toBe(true)
    expect(result.port).toBe(NOTION_OAUTH_PORT)

    const opened = new URL(mockOpenExternal.mock.calls[0][0] as string)
    expect(opened.searchParams.get('redirect_uri')).toBe(NOTION_OAUTH_REDIRECT_URI)
    const state = opened.searchParams.get('state') || ''

    const resp = await httpGet(
      `http://127.0.0.1:${result.port}${NOTION_CALLBACK_PATH}?code=code-1&state=${state}`,
    )
    expect(resp.status).toBe(200)

    await waitFor(() => {
      expect((lastSaved().notion_oauth as Record<string, unknown>).accessToken).toBe(
        'ntn-secret-token',
      )
    })
    const o = lastSaved().notion_oauth as Record<string, unknown>
    expect(o.workspaceId).toBe('ws-1')
    expect(o.botId).toBe('bot-1')
    expect(o.connectedAt).toBeTypeOf('number')
    expect(o.clientId).toBe('cid-1')
  })

  it('exchangeNotionCode：Basic 认证换 token 并保存', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { access_token: 'ntn-1', workspace_id: 'ws', bot_id: 'bot' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setUserConfig({ notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1' } })

    const result = await notion.exchangeNotionCode('code-1')
    expect(result).toEqual({ success: true })

    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(String(url)).toBe('https://api.notion.com/v1/oauth/token')
    const auth = (init.headers as Record<string, string>).Authorization
    expect(auth).toBe('Basic ' + Buffer.from('cid-1:csec-1').toString('base64'))
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'podmuse://notion/callback',
    })

    expect((lastSaved().notion_oauth as Record<string, unknown>).accessToken).toBe('ntn-1')
  })

  it('exchangeNotionCode：401 → token_exchange_failed；网络错误 → network_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'invalid_client' })),
    )
    setUserConfig({ notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1' } })
    await expect(notion.exchangeNotionCode('c')).resolves.toMatchObject({
      success: false,
      code: 'token_exchange_failed',
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(notion.exchangeNotionCode('c')).resolves.toMatchObject({
      success: false,
      code: 'network_error',
    })
  })

  it('exchangeNotionCode：200 但缺 access_token → token_exchange_failed，且不保存', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { error: 'oops' })),
    )
    setUserConfig({ notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1' } })

    await expect(notion.exchangeNotionCode('c')).resolves.toMatchObject({
      success: false,
      code: 'token_exchange_failed',
    })
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('listNotionDatabases：filter object=database，映射 [{id,title}]', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        results: [
          {
            id: 'db-1',
            title: [{ type: 'text', text: { content: '播客知识库' }, plain_text: '播客知识库' }],
          },
          { id: 'db-2', title: [] },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setUserConfig({
      notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1', accessToken: 'ntn-1' },
    })

    const result = await notion.listNotionDatabases()
    expect(result.success).toBe(true)
    expect(result.databases).toEqual([
      { id: 'db-1', title: '播客知识库' },
      { id: 'db-2', title: '(未命名数据库)' },
    ])

    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(String(url)).toBe('https://api.notion.com/v1/search')
    expect(JSON.parse(init.body as string).filter).toEqual({
      value: 'database',
      property: 'object',
    })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ntn-1')
  })

  it('listNotionDatabases：401 → token_expired 并置「已断开」（清 token 保留注册与库选择）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { message: 'unauthorized' })),
    )
    setUserConfig({
      notion_oauth: {
        clientId: 'cid-1',
        clientSecret: 'csec-1',
        accessToken: 'ntn-old',
        databaseId: 'db-9',
        workspaceId: 'ws-1',
      },
    })

    const result = await notion.listNotionDatabases()
    expect(result).toMatchObject({ success: false, code: 'token_expired' })

    const o = lastSaved().notion_oauth as Record<string, unknown>
    expect(o.accessToken).toBeUndefined()
    expect(o.workspaceId).toBeUndefined()
    expect(o.clientId).toBe('cid-1')
    expect(o.clientSecret).toBe('csec-1')
    expect(o.databaseId).toBe('db-9')
    expect(notion.getNotionStatus().connected).toBe(false)
  })

  it('setNotionDatabase：写 notion_oauth.databaseId 并同步 export.notion.database_id', () => {
    setUserConfig({
      notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1', accessToken: 'ntn-1' },
    })

    expect(notion.setNotionDatabase('db-42')).toEqual({ success: true })
    const saved = lastSaved()
    expect((saved.notion_oauth as Record<string, unknown>).databaseId).toBe('db-42')
    expect((saved.export as Record<string, unknown>).notion).toEqual({
      token: '',
      database_id: 'db-42',
    })

    expect(notion.setNotionDatabase('  ')).toMatchObject({ success: false })
  })

  it('disconnectNotion：清 token 保留注册与库选择', () => {
    setUserConfig({
      notion_oauth: {
        clientId: 'cid-1',
        clientSecret: 'csec-1',
        accessToken: 'ntn-1',
        workspaceId: 'ws-1',
        databaseId: 'db-1',
      },
    })

    const status = notion.disconnectNotion()
    expect(status.connected).toBe(false)
    const o = lastSaved().notion_oauth as Record<string, unknown>
    expect(o.accessToken).toBeUndefined()
    expect(o.workspaceId).toBeUndefined()
    expect(o.clientId).toBe('cid-1')
    expect(o.clientSecret).toBe('csec-1')
    expect(o.databaseId).toBe('db-1')
  })

  it('parseNotionCallback：解析 podmuse://notion/callback', () => {
    expect(notion.parseNotionCallback('podmuse://notion/callback?code=abc&state=s1')).toEqual({
      code: 'abc',
      state: 's1',
    })
    expect(notion.parseNotionCallback('podmuse://other?code=abc')).toBeNull()
    expect(notion.parseNotionCallback('podmuse://notion/callback?state=s1')).toBeNull()
    expect(notion.parseNotionCallback('https://example.com/?code=abc')).toBeNull()
  })

  it('handleNotionOAuthCallback：协议回调换 token 并保存（state 匹配）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, { access_token: fakeCred('ntn-proto'), workspace_id: 'ws-2', bot_id: 'bot-2' }),
      ),
    )
    setUserConfig({ notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1' } })
    await notion.startNotionAuth()
    const openedState = new URL(mockOpenExternal.mock.calls[0][0] as string).searchParams.get(
      'state',
    )

    const result = await notion.handleNotionOAuthCallback(
      `podmuse://notion/callback?code=code-9&state=${openedState}`,
    )
    expect(result.success).toBe(true)
    expect((lastSaved().notion_oauth as Record<string, unknown>).accessToken).toBe('ntn-proto')
  })

  it('handleNotionOAuthCallback：state 不匹配 → 拒绝且不换 token', async () => {
    setUserConfig({ notion_oauth: { clientId: 'cid-1', clientSecret: 'csec-1' } })
    await notion.startNotionAuth()

    const result = await notion.handleNotionOAuthCallback(
      'podmuse://notion/callback?code=code-9&state=wrong-state',
    )
    expect(result).toMatchObject({ success: false, code: 'token_exchange_failed' })
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('resolveNotionExportCredential：优先 OAuth，回退手动高级模式', () => {
    setUserConfig({
      notion_oauth: {
        clientId: 'cid-1',
        clientSecret: 'csec-1',
        accessToken: fakeCred('ntn-oauth'),
        databaseId: 'db-oauth',
      },
      export: {
        logseq_dir: '',
        notion: { token: 'secret-manual', database_id: 'db-manual' },
      },
    })
    expect(notion.resolveNotionExportCredential()).toEqual({
      token: 'ntn-oauth',
      databaseId: 'db-oauth',
    })

    setUserConfig({
      export: { logseq_dir: '', notion: { token: 'secret-manual', database_id: 'db-manual' } },
    })
    expect(notion.resolveNotionExportCredential()).toEqual({
      token: 'secret-manual',
      databaseId: 'db-manual',
    })

    setUserConfig({})
    expect(notion.resolveNotionExportCredential()).toBeNull()
  })

  it('状态映射：getNotionStatus 不含任何凭据字段', () => {
    setUserConfig({
      notion_oauth: {
        clientId: 'cid-1',
        clientSecret: 'csec-1',
        accessToken: 'ntn-1',
        workspaceId: 'ws-1',
        databaseId: 'db-1',
        connectedAt: 5,
      },
    })
    const n = notion.getNotionStatus()
    expect(n).toMatchObject({
      configured: true,
      connected: true,
      workspaceId: 'ws-1',
      databaseId: 'db-1',
    })
    expect(n).not.toHaveProperty('accessToken')
    expect(n).not.toHaveProperty('clientSecret')
  })
})

// ============================================================
// feishu-oauth
// ============================================================

describe('feishu-oauth', () => {
  it('未配置 appId/appSecret → 所有入口 oauth_not_configured', async () => {
    setUserConfig({ feishu_oauth: { appId: '', appSecret: '' } })

    expect(feishu.getFeishuStatus()).toEqual({ configured: false, connected: false })
    await expect(feishu.startFeishuAuth()).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    await expect(feishu.exchangeFeishuCode('c')).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    await expect(feishu.refreshFeishuToken()).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    await expect(feishu.listFeishuChats()).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    await expect(feishu.getFeishuAppAccessToken()).resolves.toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    expect(feishu.setFeishuChat('oc-1', '群')).toMatchObject({
      success: false,
      code: 'oauth_not_configured',
    })
    expect(mockOpenExternal).not.toHaveBeenCalled()
  })

  it('startFeishuAuth：本地回调优先，浏览器打开 authorize URL（含 state）', async () => {
    setUserConfig({ feishu_oauth: { appId: 'cli-1', appSecret: 'appsec-1' } })

    const result = await feishu.startFeishuAuth()
    expect(result).toEqual({ success: true })

    const opened = new URL(mockOpenExternal.mock.calls[0][0] as string)
    expect(opened.origin + opened.pathname).toBe(
      'https://open.feishu.cn/open-apis/authen/v1/authorize',
    )
    expect(opened.searchParams.get('app_id')).toBe('cli-1')
    expect(opened.searchParams.get('redirect_uri')).toBe(FEISHU_OAUTH_REDIRECT_URI)
    expect(opened.searchParams.get('state')).toBeTruthy()
    // 授权 scope 必须包含 im:chat:readonly，否则 OAuth token 无群列表权限（「飞书接口返回异常」根因）
    expect(opened.searchParams.get('scope')).toContain('im:chat:readonly')
  })

  it('授权回调 → 换 token → 保存（本地回调闭环，token 不出主进程）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const u = String(input)
        if (u.includes('/open-apis/authen/v2/oauth/token')) {
          return jsonResponse(200, {
            code: 0,
            access_token: fakeCred('u-token-1'),
            refresh_token: fakeCred('ur-token-1'),
            expires_in: 7200,
          })
        }
        return jsonResponse(404, {})
      }),
    )
    setUserConfig({ feishu_oauth: { appId: 'cli-1', appSecret: 'appsec-1' } })

    const result = await feishu.startFeishuAuth()
    expect(result.success).toBe(true)

    const opened = new URL(mockOpenExternal.mock.calls[0][0] as string)
    const state = opened.searchParams.get('state') || ''
    const redirectUri = opened.searchParams.get('redirect_uri') || ''

    const resp = await httpGet(`${redirectUri}?code=feishu-code&state=${state}`)
    expect(resp.status).toBe(200)

    await waitFor(() => {
      expect((lastSaved().feishu_oauth as Record<string, unknown>).userAccessToken).toBe(
        'u-token-1',
      )
    })
    const o = lastSaved().feishu_oauth as Record<string, unknown>
    expect(o.refreshToken).toBe('ur-token-1')
    expect(o.expiresAt).toBeTypeOf('number')
    expect(o.expiresAt as number).toBeGreaterThan(Date.now())
  })

  it('进行中的授权流：重复 start → auth_in_progress', async () => {
    setUserConfig({ feishu_oauth: { appId: 'cli-1', appSecret: 'appsec-1' } })
    await expect(feishu.startFeishuAuth()).resolves.toEqual({ success: true })
    await expect(feishu.startFeishuAuth()).resolves.toMatchObject({
      success: false,
      code: 'auth_in_progress',
    })
  })

  it('exchangeFeishuCode：保存 userAccessToken/refreshToken/expiresAt', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { code: 0, access_token: 'u-1', refresh_token: 'ur-1', expires_in: 7200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setUserConfig({ feishu_oauth: { appId: 'cli-1', appSecret: 'appsec-1' } })
    const before = Date.now()

    const result = await feishu.exchangeFeishuCode(
      'code-1',
      'http://127.0.0.1:1234/feishu/callback',
    )
    expect(result).toEqual({ success: true })

    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(String(url)).toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.grant_type).toBe('authorization_code')
    expect(body.client_id).toBe('cli-1')
    expect(body.code).toBe('code-1')
    expect(body.redirect_uri).toBe('http://127.0.0.1:1234/feishu/callback')

    const o = lastSaved().feishu_oauth as Record<string, unknown>
    expect(o.userAccessToken).toBe('u-1')
    expect(o.refreshToken).toBe('ur-1')
    expect(o.expiresAt as number).toBeGreaterThanOrEqual(before + 7200 * 1000 - 50)
  })

  it('exchangeFeishuCode：飞书错误响应 / 网络错误 → 分类失败且不保存', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { code: 400, msg: 'bad' })),
    )
    setUserConfig({ feishu_oauth: { appId: 'cli-1', appSecret: 'appsec-1' } })
    await expect(feishu.exchangeFeishuCode('bad')).resolves.toMatchObject({
      success: false,
      code: 'token_exchange_failed',
    })
    expect(mockWriteFileSync).not.toHaveBeenCalled()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(feishu.exchangeFeishuCode('bad')).resolves.toMatchObject({
      success: false,
      code: 'network_error',
    })
  })

  it('getFeishuAppAccessToken：appId+appSecret 换 app_access_token（不落盘）', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { code: 0, app_access_token: 't-xxx', expire: 7200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setUserConfig({ feishu_oauth: { appId: 'cli-1', appSecret: 'appsec-1' } })

    const result = await feishu.getFeishuAppAccessToken()
    expect(result).toEqual({ success: true, token: 't-xxx' })

    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(String(url)).toBe('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal')
    expect(JSON.parse(init.body as string)).toEqual({ app_id: 'cli-1', app_secret: 'appsec-1' })
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('refreshFeishuToken：续期成功更新 token；缺 refresh_token → refresh_failed', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        code: 0,
        access_token: 'u-new',
        refresh_token: 'ur-new',
        expires_in: 7200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setUserConfig({
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-1',
        userAccessToken: 'u-old',
        refreshToken: 'ur-old',
        expiresAt: Date.now() - 1000,
      },
    })

    const result = await feishu.refreshFeishuToken()
    expect(result.success).toBe(true)
    const o = lastSaved().feishu_oauth as Record<string, unknown>
    expect(o.userAccessToken).toBe('u-new')
    expect(o.refreshToken).toBe('ur-new')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('ur-old')

    setUserConfig({
      feishu_oauth: { appId: 'cli-1', appSecret: 'appsec-1', userAccessToken: 'u-1' },
    })
    await expect(feishu.refreshFeishuToken()).resolves.toMatchObject({
      success: false,
      code: 'refresh_failed',
    })
  })

  it('listFeishuChats：映射 [{id,name}]；未连接 → not_connected', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        code: 0,
        data: {
          items: [
            { chat_id: 'oc-1', name: '播客群' },
            { chat_id: 'oc-2', name: '' },
          ],
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setUserConfig({
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-1',
        userAccessToken: 'u-1',
        expiresAt: Date.now() + 3600_000,
      },
    })

    const result = await feishu.listFeishuChats()
    expect(result.success).toBe(true)
    expect(result.chats).toEqual([
      { id: 'oc-1', name: '播客群' },
      { id: 'oc-2', name: '(未命名群聊)' },
    ])

    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(String(url)).toContain('https://open.feishu.cn/open-apis/im/v1/chats')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer u-1')

    setUserConfig({ feishu_oauth: { appId: 'cli-1', appSecret: 'appsec-1' } })
    await expect(feishu.listFeishuChats()).resolves.toMatchObject({
      success: false,
      code: 'not_connected',
    })
  })

  it('listFeishuChats：token 失效 → 先续期重试；续期也失败 → token_expired 置「已断开」', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse(200, { code: 99991663, msg: 'invalid' }))
      .mockImplementationOnce(async () =>
        jsonResponse(200, {
          code: 0,
          access_token: 'u-new',
          refresh_token: 'ur-new',
          expires_in: 7200,
        }),
      )
      .mockImplementationOnce(async () =>
        jsonResponse(200, { code: 0, data: { items: [{ chat_id: 'oc-1', name: '群' }] } }),
      )
    vi.stubGlobal('fetch', fetchMock)
    setUserConfig({
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-1',
        userAccessToken: 'u-old',
        refreshToken: 'ur-old',
        expiresAt: Date.now() + 3600_000,
      },
    })

    const result = await feishu.listFeishuChats()
    expect(result.success).toBe(true)
    expect(result.chats).toEqual([{ id: 'oc-1', name: '群' }])
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // 续期也失败 → token_expired + 置「已断开」
    setUserConfig({
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-1',
        userAccessToken: 'u-old',
        refreshToken: 'ur-old',
        expiresAt: Date.now() + 3600_000,
      },
    })
    const fetchFail = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse(200, { code: 99991663, msg: 'invalid' }))
      .mockImplementationOnce(async () => jsonResponse(200, { code: 500, msg: 'refresh failed' }))
    vi.stubGlobal('fetch', fetchFail)

    const failed = await feishu.listFeishuChats()
    expect(failed).toMatchObject({ success: false, code: 'token_expired' })
    const o = lastSaved().feishu_oauth as Record<string, unknown>
    expect(o.userAccessToken).toBeUndefined()
    expect(o.appId).toBe('cli-1')
  })

  it('listFeishuChats：非鉴权错误 → 返回带飞书 msg 的「飞书接口返回异常」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { code: 230002, msg: 'no permission' })),
    )
    setUserConfig({
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-1',
        userAccessToken: 'u-1',
        expiresAt: Date.now() + 3600_000,
      },
    })

    const failed = await feishu.listFeishuChats()
    expect(failed.success).toBe(false)
    expect(String(failed.error)).toContain('no permission')
  })

  it('listFeishuChats：expiresAt 前 5 分钟自动续期', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        jsonResponse(200, { code: 0, access_token: 'u-fresh', expires_in: 7200 }),
      )
      .mockImplementationOnce(async () => jsonResponse(200, { code: 0, data: { items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    setUserConfig({
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-1',
        userAccessToken: 'u-old',
        refreshToken: 'ur-old',
        expiresAt: Date.now() + 60_000, // 距过期 1 分钟 < 5 分钟阈值
      },
    })

    const result = await feishu.listFeishuChats()
    expect(result.success).toBe(true)
    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>
    expect(firstBody.grant_type).toBe('refresh_token')
  })

  it('setFeishuChat / disconnectFeishu / getFeishuStatus', () => {
    setUserConfig({
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-1',
        userAccessToken: 'u-1',
        refreshToken: 'ur-1',
        expiresAt: Date.now() + 3600_000,
      },
    })

    expect(feishu.setFeishuChat('oc-9', '播客群')).toEqual({ success: true })
    const saved = lastSaved().feishu_oauth as Record<string, unknown>
    expect(saved.chatId).toBe('oc-9')
    expect(saved.chatName).toBe('播客群')

    const status = feishu.getFeishuStatus()
    expect(status).toMatchObject({
      configured: true,
      connected: true,
      chatId: 'oc-9',
      chatName: '播客群',
    })
    expect(status).not.toHaveProperty('userAccessToken')
    expect(status).not.toHaveProperty('appSecret')

    const disconnected = feishu.disconnectFeishu()
    expect(disconnected.connected).toBe(false)
    const after = lastSaved().feishu_oauth as Record<string, unknown>
    expect(after.userAccessToken).toBeUndefined()
    expect(after.chatId).toBe('oc-9')
    expect(after.appId).toBe('cli-1')
  })

  it('token 已过期：getFeishuStatus 标 tokenExpired', () => {
    setUserConfig({
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-1',
        userAccessToken: 'u-1',
        expiresAt: Date.now() - 1000,
        chatId: 'oc-1',
        chatName: '群',
      },
    })
    expect(feishu.getFeishuStatus()).toMatchObject({
      configured: true,
      connected: true,
      tokenExpired: true,
      chatId: 'oc-1',
      chatName: '群',
    })
  })
})

// ============================================================
// config 脱敏（config:get 前清 token 类字段）
// ============================================================

describe('loadSafeConfig（OAuth token 字段与 douyin_cookie 同级保护）', () => {
  it('config:get 前清空 token 类字段，状态字段与主进程原值不受影响', () => {
    setUserConfig({
      notion_oauth: {
        clientId: 'cid-1',
        clientSecret: fakeCred('csec-secret'),
        accessToken: fakeCred('ntn-secret'),
        workspaceId: 'ws-1',
        botId: 'bot-1',
        databaseId: 'db-1',
        connectedAt: 123,
      },
      feishu_oauth: {
        appId: 'cli-1',
        appSecret: 'appsec-secret',
        userAccessToken: fakeCred('u-secret'),
        refreshToken: fakeCred('ur-secret'),
        expiresAt: 456,
        chatId: 'oc-1',
        chatName: '群',
        connectedAt: 123,
      },
      douyin_cookie: 'sid_guard=secret',
    })

    const safe = loadSafeConfig()
    expect(safe.douyin_cookie).toBe('')

    const n = safe.notion_oauth as NonNullable<PodcastConfig['notion_oauth']>
    expect(n.clientId).toBe('cid-1')
    expect(n.clientSecret).toBe('')
    expect(n.accessToken).toBeUndefined()
    expect(n.workspaceId).toBe('ws-1')
    expect(n.databaseId).toBe('db-1')

    const f = safe.feishu_oauth as NonNullable<PodcastConfig['feishu_oauth']>
    expect(f.appId).toBe('cli-1')
    expect(f.appSecret).toBe('')
    expect(f.userAccessToken).toBeUndefined()
    expect(f.refreshToken).toBeUndefined()
    expect(f.expiresAt).toBeUndefined()
    expect(f.chatId).toBe('oc-1')
    expect(f.chatName).toBe('群')

    // 主进程内部原值不受影响（loadSafeConfig 只复制不清原配置）
    expect(loadConfig().notion_oauth?.accessToken).toBe('ntn-secret')
    expect(loadConfig().feishu_oauth?.userAccessToken).toBe('u-secret')
  })

  it('无 oauth 配置时 loadSafeConfig 返回默认空壳，不影响其他字段', () => {
    setUserConfig({ api_key: 'sk-test' })
    const safe = loadSafeConfig()
    expect(safe.notion_oauth).toEqual({ clientId: '', clientSecret: '' })
    expect(safe.feishu_oauth).toEqual({ appId: '', appSecret: '' })
    expect(safe.api_key).toBe('sk-test')
  })
})

// ============================================================
// restoreProtectedFields（config:save OAuth 凭据还原：token 唯一写入通道是 oauth IPC）
// ============================================================

describe('restoreProtectedFields（OAuth 凭据 renderer 不可写）', () => {
  const current = {
    douyin_cookie: 'sid_guard=real',
    notion_oauth: {
      clientId: 'cid-1',
      clientSecret: fakeCred('csec-real'),
      accessToken: fakeCred('ntn-real'),
      databaseId: 'db-1',
    },
    feishu_oauth: {
      appId: 'cli-1',
      appSecret: 'appsec-real',
      userAccessToken: 'u-real',
      refreshToken: 'ur-real',
      expiresAt: 1,
      chatId: 'oc-1',
      chatName: '群',
    },
  } as unknown as PodcastConfig

  it('renderer 传伪造/脱敏 oauth 字段 → 一律还原为主进程值', () => {
    const out = restoreProtectedFields(
      {
        notion_oauth: { clientId: 'fake', clientSecret: '', accessToken: 'evil' },
        feishu_oauth: { appId: 'fake', appSecret: '****1234', userAccessToken: 'evil' },
        douyin_cookie: 'evil',
      },
      current,
    )
    expect(out.notion_oauth).toEqual(current.notion_oauth)
    expect(out.feishu_oauth).toEqual(current.feishu_oauth)
    expect(out.douyin_cookie).toBe('sid_guard=real')
  })

  it('主进程无 oauth 配置时，renderer 传的 oauth 字段被删除', () => {
    const out = restoreProtectedFields(
      { notion_oauth: { clientId: 'fake' }, feishu_oauth: { appId: 'fake' } },
      { douyin_cookie: '' } as PodcastConfig,
    )
    expect('notion_oauth' in out).toBe(false)
    expect('feishu_oauth' in out).toBe(false)
  })

  it('既有 api_key / douyin_cookie 脱敏还原不受影响（回归）', () => {
    const withLegacy = {
      ...current,
      api_key: 'sk-real',
      feishu_app_secret: 'secret-real',
    } as unknown as PodcastConfig
    const out = restoreProtectedFields(
      { api_key: fakeCred('****abcd'), douyin_cookie: 'x=1', feishu_app_secret: fakeCred('****9999') },
      withLegacy,
    )
    expect(out.api_key).toBe('sk-real')
    expect(out.feishu_app_secret).toBe('secret-real')
    expect(out.douyin_cookie).toBe('sid_guard=real')
  })
})

// ============================================================
// restoreProtectedFields（export.notion.token：config:get 已清空，空值还原防误清空）
// ============================================================

describe('restoreProtectedFields（export.notion.token 防护）', () => {
  const withToken = {
    export: { logseq_dir: '', notion: { token: 'manual-real', database_id: 'db-1' } },
  } as unknown as PodcastConfig

  const exportNotionToken = (out: Record<string, unknown>): string => {
    const exp = out.export as { notion?: { token?: string } } | undefined
    return exp?.notion?.token ?? ''
  }

  it('renderer 传回空 token（未修改）→ 还原主进程值，防止保存时误清空', () => {
    const out = restoreProtectedFields(
      { export: { logseq_dir: '', notion: { token: '', database_id: 'db-1' } } },
      withToken,
    )
    expect(exportNotionToken(out)).toBe('manual-real')
    // database_id 等其他 export 字段原样保留
    expect((out.export as { notion: { database_id: string } }).notion.database_id).toBe('db-1')
  })

  it('renderer 传入新 token（手动高级模式唯一写入通道）→ 原样保留', () => {
    const out = restoreProtectedFields(
      { export: { logseq_dir: '', notion: { token: 'manual-new', database_id: 'db-2' } } },
      withToken,
    )
    expect(exportNotionToken(out)).toBe('manual-new')
  })

  it('主进程无 token 且 renderer 传空 → 保持空（不凭空写入）', () => {
    const empty = {
      export: { logseq_dir: '', notion: { token: '', database_id: 'db-1' } },
    } as unknown as PodcastConfig
    const out = restoreProtectedFields(
      { export: { notion: { token: '', database_id: 'db-1' } } },
      empty,
    )
    expect(exportNotionToken(out)).toBe('')
  })

  it('主进程无 export 且 renderer 未传 export → 不崩溃', () => {
    const out = restoreProtectedFields({ api_key: 'sk-1' }, {
      douyin_cookie: '',
    } as PodcastConfig)
    expect(out.api_key).toBe('sk-1')
    expect('export' in out).toBe(false)
  })

  it('renderer 未携带 notion 子对象（异常 payload）→ 整体还原主进程值（token + database_id）', () => {
    const out = restoreProtectedFields(
      { export: { logseq_dir: 'D:/notes' } },
      withToken,
    )
    expect(exportNotionToken(out)).toBe('manual-real')
    const notion = (out.export as { notion: { database_id: string } }).notion
    expect(notion.database_id).toBe('db-1')
    // logseq_dir 等其他字段原样保留
    expect((out.export as { logseq_dir: string }).logseq_dir).toBe('D:/notes')
  })

  it('renderer 未携带 export 字段 → 由 config:save 合并主进程值，不丢令牌', () => {
    const out = restoreProtectedFields({ api_key: 'sk-1' }, withToken)
    expect('export' in out).toBe(false)
    // config:save 的合并语义：{...currentConfig, ...incoming} 后 export 来自主进程
    const merged = { ...withToken, ...out } as unknown as { export: { notion: { token: string } } }
    expect(merged.export.notion.token).toBe('manual-real')
  })

  it('incoming export.notion 为 null（异常形态）→ 还原主进程值', () => {
    const out = restoreProtectedFields(
      { export: { logseq_dir: '', notion: null } },
      withToken,
    )
    expect(exportNotionToken(out)).toBe('manual-real')
  })
})

// ============================================================
// syncFeishuOAuthCredentials（高级模式凭据 → OAuth 连接服务打通）
// ============================================================

describe('syncFeishuOAuthCredentials（顶层 App ID/Secret 同步进 feishu_oauth）', () => {
  const currentWithOauth = {
    feishu_app_id: 'cli_old',
    feishu_app_secret: '',
    feishu_oauth: {
      appId: 'cli_old',
      appSecret: fakeCred('secret_oauth'),
      userAccessToken: 'u-token',
      chatId: 'oc_chat',
    },
  } as unknown as PodcastConfig

  it('填写 App ID/App Secret → 同步进 feishu_oauth（保留 token/chatId 等既有字段）', () => {
    const merged = { feishu_app_id: 'cli_new', feishu_app_secret: 'secret_new' }
    const out = syncFeishuOAuthCredentials(merged, currentWithOauth)
    const o = out.feishu_oauth as Record<string, unknown>
    expect(o.appId).toBe('cli_new')
    expect(o.appSecret).toBe('secret_new')
    expect(o.userAccessToken).toBe('u-token')
    expect(o.chatId).toBe('oc_chat')
  })

  it('只填 App ID → 仅同步 appId，appSecret 沿用主进程 OAuth 值', () => {
    const merged = { feishu_app_id: 'cli_new' }
    const out = syncFeishuOAuthCredentials(merged, currentWithOauth)
    const o = out.feishu_oauth as Record<string, unknown>
    expect(o.appId).toBe('cli_new')
    expect(o.appSecret).toBe('secret_oauth')
  })

  it('两个字段都为空 → 不动 feishu_oauth', () => {
    const merged = { feishu_app_id: '', feishu_app_secret: '   ' }
    const out = syncFeishuOAuthCredentials(merged, currentWithOauth)
    expect('feishu_oauth' in out).toBe(false)
  })

  it('主进程无 feishu_oauth → 用顶层字段新建', () => {
    const merged = { feishu_app_id: 'cli_new', feishu_app_secret: 'secret_new' }
    const out = syncFeishuOAuthCredentials(merged, {} as PodcastConfig)
    const o = out.feishu_oauth as Record<string, unknown>
    expect(o.appId).toBe('cli_new')
    expect(o.appSecret).toBe('secret_new')
  })
})

// ============================================================
// syncNotionOAuthCredentials（Client ID/Secret → notion_oauth 打通）
// ============================================================

describe('syncNotionOAuthCredentials（顶层 Client ID/Secret 同步进 notion_oauth）', () => {
  const currentWithOauth = {
    notion_oauth_client_id: 'cid_old',
    notion_oauth: {
      clientId: 'cid_old',
      clientSecret: fakeCred('secret_oauth'),
      accessToken: fakeCred('ntn-access'),
      databaseId: 'db-1',
    },
  } as unknown as PodcastConfig

  it('填写 Client ID/Secret → 同步进 notion_oauth（保留 token/databaseId 等既有字段）', () => {
    const merged = { notion_oauth_client_id: 'cid_new', notion_oauth_client_secret: 'secret_new' }
    const out = syncNotionOAuthCredentials(merged, currentWithOauth)
    const o = out.notion_oauth as Record<string, unknown>
    expect(o.clientId).toBe('cid_new')
    expect(o.clientSecret).toBe('secret_new')
    expect(o.accessToken).toBe('ntn-access')
    expect(o.databaseId).toBe('db-1')
  })

  it('只填 Client ID → 仅同步 clientId，clientSecret 沿用主进程 OAuth 值', () => {
    const merged = { notion_oauth_client_id: 'cid_new' }
    const out = syncNotionOAuthCredentials(merged, currentWithOauth)
    const o = out.notion_oauth as Record<string, unknown>
    expect(o.clientId).toBe('cid_new')
    expect(o.clientSecret).toBe('secret_oauth')
  })

  it('两个字段都为空 → 不动 notion_oauth', () => {
    const merged = { notion_oauth_client_id: '', notion_oauth_client_secret: '  ' }
    const out = syncNotionOAuthCredentials(merged, currentWithOauth)
    expect('notion_oauth' in out).toBe(false)
  })

  it('主进程无 notion_oauth → 用顶层字段新建', () => {
    const merged = { notion_oauth_client_id: 'cid_new', notion_oauth_client_secret: 'secret_new' }
    const out = syncNotionOAuthCredentials(merged, {} as PodcastConfig)
    const o = out.notion_oauth as Record<string, unknown>
    expect(o.clientId).toBe('cid_new')
    expect(o.clientSecret).toBe('secret_new')
  })
})
