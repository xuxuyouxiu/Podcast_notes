import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { PodcastConfig } from '@shared/types'

/**
 * 抖音无 Cookie 展示 —— 主进程闭环单元测试。
 * verifyDouyinCookie 四分支（200+昵称 / 401 / 302 / 超时）用 vi.stubGlobal(fetch) mock；
 * config 脱敏还原（restoreProtectedFields）与 disconnect / refresh / getDouyinStatus 状态流转。
 */

// ============================================================
// Mock setup — hoisted so factories can reference these
// ============================================================

const { mockLoadConfig, mockSaveConfig, mockCookiesGet, mockCookiesRemove, mockOpenExternal, mockExecuteJS, MockBrowserWindow } = vi.hoisted(() => {
  /** 极简 BrowserWindow 假件：记录实例、支持 on('closed') 与 close() 联动 */
  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []
    handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    openHandler: ((details: { url: string }) => { action: string }) | null = null
    webContents = {
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        this.handlers['wc:' + ev] = [fn]
      },
      setWindowOpenHandler: (fn: (details: { url: string }) => { action: string }) => {
        this.openHandler = fn
      },
      executeJavaScript: mockExecuteJS,
    }
    destroyed = false
    constructor() {
      MockBrowserWindow.instances.push(this)
    }
    loadURL(_url: string) {}
    isDestroyed() {
      return this.destroyed
    }
    close() {
      if (this.destroyed) return
      this.destroyed = true
      for (const fn of this.handlers['closed'] || []) fn()
    }
    on(ev: string, fn: (...args: unknown[]) => void) {
      ;(this.handlers[ev] ||= []).push(fn)
    }
  }

  return {
    mockLoadConfig: vi.fn(),
    mockSaveConfig: vi.fn(),
    mockCookiesGet: vi.fn(),
    mockCookiesRemove: vi.fn(),
    mockOpenExternal: vi.fn(),
    mockExecuteJS: vi.fn(),
    MockBrowserWindow,
  }
})

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  session: { defaultSession: { cookies: { get: mockCookiesGet, remove: mockCookiesRemove } } },
  app: { getPath: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: mockOpenExternal, showItemInFolder: vi.fn() },
}))

vi.mock('../src/main/config', () => ({
  loadConfig: mockLoadConfig,
  saveConfig: mockSaveConfig,
}))

vi.mock('../src/main/security', () => ({
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

import {
  verifyDouyinCookie,
  getDouyinStatus,
  refreshDouyinStatus,
  disconnectDouyin,
  connectDouyin,
  isLoginSessionCookie,
  isIgnorableLoadError,
  isDouyinHost,
  isDouyinCookieDomain,
  isBlockedExternalHost,
  buildCookieString,
  getSessionDouyinCookie,
  getFreshDouyinCookie,
  markDouyinExpired,
  syncDouyinDownloaderCookie,
  yamlSafeValue,
  } from '../src/main/douyin-auth'
import { restoreProtectedFields } from '../src/main/ipc/config-ipc'
import { fakeCred } from './fake-cred'

// ============================================================
// Helpers
// ============================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function baseConfig(overrides: Record<string, unknown> = {}): PodcastConfig {
  return { douyin_cookie: '', ...overrides } as PodcastConfig
}

const PASSPORT_OK_BODY = {
  data: {
    error_code: 0,
    description: '',
    user_info: { nickname: '播客爱好者', uid: '123' },
  },
  message: 'success',
}

/** 实测 2026-08 无 cookie 时的登录墙形状（passport/web/account/info） */
const PASSPORT_LOGGED_OUT_BODY = {
  data: { captcha: '', desc_url: '', description: '会话过期，请重新登录', error_code: 1 },
  message: 'error',
}

const AWEME_LOGGED_OUT_BODY = { status_code: 8, status_msg: '用户未登录', user: null }

beforeEach(() => {
  MockBrowserWindow.instances = []
  mockLoadConfig.mockReset()
  mockSaveConfig.mockReset()
  mockCookiesGet.mockReset()
  mockCookiesRemove.mockReset()
  mockOpenExternal.mockReset()
  mockExecuteJS.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ============================================================
// verifyDouyinCookie 四分支
// ============================================================

describe('verifyDouyinCookie', () => {
  it('HTTP 200 且含用户信息（passport 形状）→ ok + 昵称', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_OK_BODY)),
    )

    const result = await verifyDouyinCookie('sid_guard=x; sessionid=y')

    expect(result).toEqual({ ok: true, nickname: '播客爱好者', reason: 'ok' })
  })

  it('HTTP 200 且含用户信息（aweme/v1/web 形状 user.nickname）→ ok + 昵称', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { status_code: 0, user: { nickname: 'aweme用户' } })),
    )

    const result = await verifyDouyinCookie('sid_guard=x')

    expect(result).toEqual({ ok: true, nickname: 'aweme用户', reason: 'ok' })
  })

  it('HTTP 401 → invalid（登录墙）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { message: 'unauthorized' })),
    )

    const result = await verifyDouyinCookie('sid_guard=x')

    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('HTTP 302 跳登录页 → invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('', {
            status: 302,
            headers: { Location: 'https://www.douyin.com/passport/login/' },
          }),
      ),
    )

    const result = await verifyDouyinCookie('sid_guard=x')

    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('超时（TimeoutError）→ unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('The operation was aborted due to timeout')
        err.name = 'TimeoutError'
        throw err
      }),
    )

    const result = await verifyDouyinCookie('sid_guard=x')

    expect(result).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('网络错误（fetch failed）→ unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    const result = await verifyDouyinCookie('sid_guard=x')

    expect(result).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('HTTP 200 但未登录形状（实测登录墙 JSON）→ invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_LOGGED_OUT_BODY)),
    )
    expect(await verifyDouyinCookie('sid_guard=x')).toEqual({ ok: false, reason: 'invalid' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, AWEME_LOGGED_OUT_BODY)),
    )
    expect(await verifyDouyinCookie('sid_guard=x')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('HTTP 200 但响应体不是 JSON → invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body>login</body></html>', { status: 200 })),
    )
    expect(await verifyDouyinCookie('sid_guard=x')).toEqual({ ok: false, reason: 'invalid' })
  })
})

// ============================================================
// restoreProtectedFields（config:save 脱敏还原 / 抖音凭据防护）
// ============================================================

describe('restoreProtectedFields（douyin 凭据 renderer 不可写）', () => {
  const current = {
    douyin_cookie: 'sid_guard=real; sessionid=real',
    douyin_login: { status: 'connected', nickname: '真实昵称', verifiedAt: 1 },
    api_key: fakeCred('sk-real'),
    feishu_app_secret: 'secret-real',
  } as unknown as PodcastConfig

  it('renderer 传 **** → 还原为主进程值', () => {
    const out = restoreProtectedFields(
      { douyin_cookie: '****', douyin_login: { status: 'expired' as const } },
      current,
    )
    expect(out.douyin_cookie).toBe('sid_guard=real; sessionid=real')
    expect(out.douyin_login).toEqual(current.douyin_login)
  })

  it('renderer 传空值 → 主进程值保留（不被清空）', () => {
    const out = restoreProtectedFields({ douyin_cookie: '' }, current)
    expect(out.douyin_cookie).toBe('sid_guard=real; sessionid=real')
  })

  it('renderer 传任意伪造值 → 一律还原为主进程值', () => {
    const out = restoreProtectedFields({ douyin_cookie: 'evil=1; sid_guard=fake' }, current)
    expect(out.douyin_cookie).toBe('sid_guard=real; sessionid=real')
  })

  it('主进程无登录状态时，renderer 传的 douyin_login 被删除', () => {
    const out = restoreProtectedFields(
      { douyin_cookie: 'x=1', douyin_login: { status: 'connected', nickname: '伪造' } },
      { douyin_cookie: 'x=1' } as PodcastConfig,
    )
    expect(out.douyin_cookie).toBe('x=1')
    expect('douyin_login' in out).toBe(false)
  })

  it('既有 api_key **** 脱敏还原不受影响（回归）', () => {
    const out = restoreProtectedFields({ api_key: fakeCred('****abcd'), douyin_cookie: 'x=1' }, current)
    expect(out.api_key).toBe('sk-real')
  })

  it('既有 ai_providers.apiKey **** 脱敏还原不受影响（回归）', () => {
    const withProviders = {
      ...current,
      ai_providers: {
        deepseek: {
          id: 'deepseek',
          name: 'x',
          apiKey: fakeCred('sk-ds-real'),
          baseUrl: '',
          model: '',
          availableModels: [],
        },
      },
    } as unknown as PodcastConfig
    const out = restoreProtectedFields(
      {
        ai_providers: { deepseek: { apiKey: fakeCred('****9999') } },
        douyin_cookie: '****',
      },
      withProviders,
    )
    const providers = out.ai_providers as Record<string, Record<string, unknown>>
    expect(providers.deepseek.apiKey).toBe('sk-ds-real')
    expect(out.douyin_cookie).toBe('sid_guard=real; sessionid=real')
  })
})

// ============================================================
// getDouyinStatus / refreshDouyinStatus / disconnectDouyin
// ============================================================

describe('getDouyinStatus', () => {
  it('无 cookie → disconnected', () => {
    mockLoadConfig.mockReturnValue(baseConfig())
    expect(getDouyinStatus()).toEqual({ status: 'disconnected' })
  })

  it('有 cookie 但无 douyin_login（老用户迁移）→ connected（不再显示待验证）', () => {
    mockLoadConfig.mockReturnValue(baseConfig({ douyin_cookie: 'sid_guard=old' }))
    expect(getDouyinStatus()).toEqual({ status: 'connected' })
  })

  it('已连接 → 透传状态与昵称，且不含 cookie', () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        douyin_cookie: 'sid_guard=x',
        douyin_login: { status: 'connected', nickname: '昵称', verifiedAt: 123 },
      }),
    )
    const status = getDouyinStatus()
    expect(status).toEqual({ status: 'connected', nickname: '昵称', verifiedAt: 123 })
    expect(status).not.toHaveProperty('cookie')
  })
})

describe('refreshDouyinStatus', () => {
  it('无 cookie → disconnected，并清掉残留登录状态', async () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({ douyin_login: { status: 'connected', nickname: '旧' } }),
    )
    const result = await refreshDouyinStatus()
    expect(result).toEqual({ status: 'disconnected' })
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ douyin_login: undefined }),
    )
  })

  it('校验 ok → 保存 connected + 昵称 + verifiedAt', async () => {
    mockLoadConfig.mockReturnValue(baseConfig({ douyin_cookie: 'sid_guard=x' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_OK_BODY)),
    )

    const result = await refreshDouyinStatus()

    expect(result.status).toBe('connected')
    expect(result.nickname).toBe('播客爱好者')
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        douyin_login: expect.objectContaining({ status: 'connected', nickname: '播客爱好者' }),
      }),
    )
  })

  it('校验失效 → 保留既有 connected 状态，不标 expired（启动不再判死）', async () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        douyin_cookie: 'sid_guard=dead',
        douyin_login: { status: 'connected', nickname: '旧昵称' },
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_LOGGED_OUT_BODY)),
    )

    const result = await refreshDouyinStatus()

    expect(result.status).toBe('connected')
    expect(result.nickname).toBe('旧昵称')
    expect(mockSaveConfig).not.toHaveBeenCalled()
  })

  it('markDouyinExpired：真实使用失败时才标 expired', () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        douyin_cookie: 'sid_guard=x',
        douyin_login: { status: 'connected', nickname: '旧昵称' },
      }),
    )
    const result = markDouyinExpired()
    expect(result.status).toBe('expired')
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        douyin_login: expect.objectContaining({ status: 'expired', nickname: '旧昵称' }),
      }),
    )
  })

  it('网络不可达且原状态 connected → 不降级、不重写', async () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        douyin_cookie: 'sid_guard=x',
        douyin_login: { status: 'connected', nickname: '昵称', verifiedAt: 1 },
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    const result = await refreshDouyinStatus()

    expect(result).toEqual({ status: 'connected', nickname: '昵称', verifiedAt: 1 })
    expect(mockSaveConfig).not.toHaveBeenCalled()
  })

  it('网络不可达且无登录状态 → 标 unverified（cookie 已存）', async () => {
    mockLoadConfig.mockReturnValue(baseConfig({ douyin_cookie: 'sid_guard=x' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    const result = await refreshDouyinStatus()

    expect(result.status).toBe('unverified')
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ douyin_login: { status: 'unverified' } }),
    )
  })
})

describe('disconnectDouyin', () => {
  it('清空 cookie 与登录状态并保存', () => {
    mockLoadConfig.mockReturnValue(
      baseConfig({
        douyin_cookie: 'sid_guard=x',
        douyin_login: { status: 'connected', nickname: '昵称', verifiedAt: 1 },
      }),
    )

    const result = disconnectDouyin()

    expect(result).toEqual({ status: 'disconnected' })
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ douyin_cookie: '', douyin_login: undefined }),
    )
  })
})

// ============================================================
// connectDouyin（登录窗迁移后的行为）
// ============================================================

describe('会话取鲜 / 下载器 cookie 同步', () => {
  it('getSessionDouyinCookie：会话含登录标记时返回新鲜 cookie 串，否则 null', async () => {
    mockCookiesGet.mockImplementation(async () => [
      { name: 'sid_guard', value: 'sg', domain: '.douyin.com' },
      { name: 'sessionid', value: 'ss', domain: 'sso.douyin.com' },
      { name: 'other', value: 'x', domain: 'example.com' },
    ])
    expect(await getSessionDouyinCookie()).toBe('sid_guard=sg; sessionid=ss')

    mockCookiesGet.mockImplementation(async () => [
      { name: 'sid_guard', value: 'sg', domain: '.douyin.com' },
    ])
    expect(await getSessionDouyinCookie()).toBeNull()
  })

  it('getFreshDouyinCookie：会话优先；无会话时回退配置冻结串（校验通过才用）', async () => {
    mockCookiesGet.mockImplementation(async () => [
      { name: 'sessionid', value: 'fresh', domain: 'www.douyin.com' },
    ])
    mockLoadConfig.mockReturnValue(baseConfig({ douyin_cookie: 'old=1' }))
    expect(await getFreshDouyinCookie()).toBe('sessionid=fresh')
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ douyin_cookie: 'sessionid=fresh' }),
    )

    // 无会话：回退配置串，校验 ok 才返回
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig({ douyin_cookie: 'sessionid=cfg' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_OK_BODY)),
    )
    expect(await getFreshDouyinCookie()).toBe('sessionid=cfg')

    // 校验失败 → null
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_LOGGED_OUT_BODY)),
    )
    expect(await getFreshDouyinCookie()).toBeNull()
  })

  it('syncDouyinDownloaderCookie：只替换 config.yml 的 cookies 块，其余配置保留', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdm-dy-cfg-'))
    const cfgPath = path.join(tmp, 'config.yml')
    fs.writeFileSync(
      cfgPath,
      'path: ./Downloaded/\nthread: 5\ncookies:\n  __ac_nonce: old1\n  __ac_signature: old2\nproxy: \'\'\n',
      'utf-8',
    )
    const prev = process.env.DOUYIN_DOWNLOADER_PATH
    process.env.DOUYIN_DOWNLOADER_PATH = tmp
    try {
      syncDouyinDownloaderCookie('sid_guard=sg; sessionid=ss')
      const out = fs.readFileSync(cfgPath, 'utf-8')
      expect(out).toContain('cookies:')
      expect(out).toContain('  sid_guard: sg')
      expect(out).toContain('  sessionid: ss')
      expect(out).not.toContain('__ac_nonce: old1')
      expect(out).toContain('thread: 5')
      expect(out).toContain('path: ./Downloaded/')
    } finally {
      if (prev === undefined) delete process.env.DOUYIN_DOWNLOADER_PATH
      else process.env.DOUYIN_DOWNLOADER_PATH = prev
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('syncDouyinDownloaderCookie：% 开头等特殊值必须加引号，保证 config.yml 可被 YAML 解析', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdm-dy-cfg-'))
    const cfgPath = path.join(tmp, 'config.yml')
    fs.writeFileSync(cfgPath, 'path: ./Downloaded/\ncookies:\n  old: v1\nproxy: \'\'\n', 'utf-8')
    const prev = process.env.DOUYIN_DOWNLOADER_PATH
    process.env.DOUYIN_DOWNLOADER_PATH = tmp
    try {
      // 真实故障场景：home_can_add_dy_2_desktop 值为 %22...（URL 编码的 JSON），裸写导致 YAML ScannerError
      syncDouyinDownloaderCookie(
        'home_can_add_dy_2_desktop=%220%22; strategyABtestKey=%abc; sessionid=ss',
      )
      const out = fs.readFileSync(cfgPath, 'utf-8')
      expect(out).toContain('  home_can_add_dy_2_desktop: "%220%22"')
      expect(out).toContain('  strategyABtestKey: "%abc"')
      expect(out).toContain('  sessionid: ss') // 普通值保持裸串
    } finally {
      if (prev === undefined) delete process.env.DOUYIN_DOWNLOADER_PATH
      else process.env.DOUYIN_DOWNLOADER_PATH = prev
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('yamlSafeValue：cookie 值转 YAML 安全标量', () => {
  it('普通值保持裸串', () => {
    expect(yamlSafeValue('ss')).toBe('ss')
    expect(yamlSafeValue('abc_123.xyz-def')).toBe('abc_123.xyz-def')
  })

  it('%/@/{/[/,/:/空格等开头或含特殊字符时加双引号并转义', () => {
    expect(yamlSafeValue('%220%22')).toBe('"%220%22"')
    expect(yamlSafeValue('@flag')).toBe('"@flag"')
    expect(yamlSafeValue('{a:b}')).toBe('"{a:b}"')
    expect(yamlSafeValue('has space')).toBe('"has space"')
    expect(yamlSafeValue('has"quote')).toBe('"has\\"quote"')
    expect(yamlSafeValue('back\\slash')).toBe('"back\\\\slash"')
    expect(yamlSafeValue('#comment')).toBe('"#comment"')
  })

  it('空值返回空串标量', () => {
    expect(yamlSafeValue('')).toBe("''")
  })
})

describe('isLoginSessionCookie / isIgnorableLoadError / buildCookieString / 域名工具', () => {
  it('仅真实登录会话 cookie 算登录标记，sid_guard 匿名 cookie 不算', () => {
    expect(isLoginSessionCookie('sid_guard')).toBe(false)
    expect(isLoginSessionCookie('sessionid')).toBe(true)
    expect(isLoginSessionCookie('sessionid_ss')).toBe(true)
    expect(isLoginSessionCookie('uid_tt')).toBe(true)
    expect(isLoginSessionCookie('sid_ucp')).toBe(true)
    expect(isLoginSessionCookie('passport_csrf_token')).toBe(false)
  })

  it('isIgnorableLoadError：-3（ERR_ABORTED 重定向中断）忽略，真实错误不忽略', () => {
    expect(isIgnorableLoadError(-3)).toBe(true)
    expect(isIgnorableLoadError(-105)).toBe(false)
    expect(isIgnorableLoadError(-106)).toBe(false)
    expect(isIgnorableLoadError(0)).toBe(false)
  })

  it('buildCookieString：只拼 douyin 域 cookie（含子域），按 name=value 以 ; 连接', () => {
    const out = buildCookieString([
      { name: 'sid_guard', value: 'sg', domain: '.douyin.com' },
      { name: 'sessionid', value: 'ss', domain: 'www.douyin.com' },
      { name: 'sessionid_ss', value: 's2', domain: 'sso.douyin.com' },
      { name: 'od', value: 'x', domain: '.iesdouyin.com' },
      { name: 'other', value: 'y', domain: 'example.com' },
    ])
    expect(out).toBe('sid_guard=sg; sessionid=ss; sessionid_ss=s2; od=x')
  })

  it('isDouyinCookieDomain：douyin/iesdouyin 及其子域均为真，其它域为假', () => {
    expect(isDouyinCookieDomain('.douyin.com')).toBe(true)
    expect(isDouyinCookieDomain('sso.douyin.com')).toBe(true)
    expect(isDouyinCookieDomain('www.douyin.com')).toBe(true)
    expect(isDouyinCookieDomain('.iesdouyin.com')).toBe(true)
    expect(isDouyinCookieDomain('example.com')).toBe(false)
    expect(isDouyinCookieDomain(undefined)).toBe(false)
  })

  it('isBlockedExternalHost：应用商店/下载引导域名拦截，普通外链放行', () => {
    expect(isBlockedExternalHost('https://play.google.com/store/apps/details?id=x')).toBe(true)
    expect(isBlockedExternalHost('https://apps.apple.com/app/id123')).toBe(true)
    expect(isBlockedExternalHost('https://app.adjust.com/abc')).toBe(true)
    expect(isBlockedExternalHost('https://www.example.com/page')).toBe(false)
    expect(isBlockedExternalHost('bytedance://x')).toBe(false)
  })
})

describe('connectDouyin', () => {
  it('用户关闭登录窗 → cancelled，不保存任何配置', async () => {
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig())

    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    expect(MockBrowserWindow.instances.length).toBe(1)
    MockBrowserWindow.instances[0].close()

    const result = await promise
    expect(result).toEqual({ success: false, cancelled: true })
    expect(mockSaveConfig).not.toHaveBeenCalled()
  })

  it('仅出现匿名 sid_guard 时（用户未登录）窗口保持打开，不关闭不保存', async () => {
    vi.useFakeTimers()
    mockCookiesGet.mockImplementation(async (filter: unknown) => {
      const f = filter as { domain?: string } | undefined
      if (f?.domain === '.douyin.com') return [{ name: 'sid_guard', value: 'sg' }]
      return [{ name: 'sid_guard', value: 'sg', domain: '.douyin.com' }]
    })
    mockLoadConfig.mockReturnValue(baseConfig())
    mockExecuteJS.mockResolvedValue(
      JSON.stringify({ status: 200, body: { data: { user_info: { nickname: '播客爱好者' } } } }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_OK_BODY)),
    )

    const promise = connectDouyin(null)
    // 多轮轮询后窗口仍未关闭（无 sessionid 标记 → 不捕获不校验）
    await vi.advanceTimersByTimeAsync(10000)
    expect(MockBrowserWindow.instances[0].destroyed).toBe(false)
    expect(mockSaveConfig).not.toHaveBeenCalled()

    // 用户完成扫码：sessionid 出现 → 捕获并校验通过 → 完成
    mockCookiesGet.mockImplementation(async (filter: unknown) => {
      const f = filter as { domain?: string } | undefined
      if (f?.domain === '.douyin.com')
        return [{ name: 'sid_guard', value: 'sg' }, { name: 'sessionid', value: 'ss' }]
      return [
        { name: 'sid_guard', value: 'sg', domain: '.douyin.com' },
        { name: 'sessionid', value: 'ss', domain: '.douyin.com' },
      ]
    })
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise
    expect(result).toEqual({ success: true, nickname: '播客爱好者' })
    // 页内昵称：只保存一次 connected（匿名阶段不保存）
    expect(mockSaveConfig).toHaveBeenCalledTimes(1)
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        douyin_cookie: 'sid_guard=sg; sessionid=ss',
        douyin_login: expect.objectContaining({ status: 'connected', nickname: '播客爱好者' }),
      }),
    )
  })

  it('登录成功：页内取到昵称 → 一次性保存 connected + 昵称，返回不含 cookie', async () => {
    vi.useFakeTimers()
    mockCookiesGet.mockImplementation(async () => [
      { name: 'sid_guard', value: 'sg', domain: '.douyin.com' },
      { name: 'sessionid', value: 'ss', domain: '.douyin.com' },
    ])
    mockLoadConfig.mockReturnValue(baseConfig())
    mockExecuteJS.mockResolvedValue(
      JSON.stringify({ status: 200, body: { data: { user_info: { nickname: '播客爱好者' } } } }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_OK_BODY)),
    )

    const promise = connectDouyin(null)
    // 3s 轮询 + 1.2s cookie 落定等待 + 页内取昵称
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result).toEqual({ success: true, nickname: '播客爱好者' })
    expect(result).not.toHaveProperty('cookie')
    // 页内昵称优先：只保存一次 connected（不再走 unverified 两段式）
    expect(mockSaveConfig).toHaveBeenCalledTimes(1)
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        douyin_cookie: 'sid_guard=sg; sessionid=ss',
        douyin_login: expect.objectContaining({ status: 'connected', nickname: '播客爱好者' }),
      }),
    )
  })

  it('登录标记出现但昵称/校验都拿不到 → 仍保存 connected（无昵称），窗口关闭、返回成功', async () => {
    vi.useFakeTimers()
    mockCookiesGet.mockImplementation(async () => [
      { name: 'sid_guard', value: 'sg', domain: '.douyin.com' },
      { name: 'sessionid', value: 'ss', domain: 'sso.douyin.com' },
    ])
    mockLoadConfig.mockReturnValue(baseConfig())
    // 页内取昵称失败（未登录形状）
    mockExecuteJS.mockResolvedValue(JSON.stringify({ status: 200, body: { data: { error_code: 1 } } }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PASSPORT_LOGGED_OUT_BODY)),
    )

    const promise = connectDouyin(null)
    // 3s 轮询 + 1.2s 落定 + 页内探测重试（6×1s）——推进足够时间
    await vi.advanceTimersByTimeAsync(12000)

    expect(MockBrowserWindow.instances[0].destroyed).toBe(true)
    const result = await promise
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        douyin_cookie: 'sid_guard=sg; sessionid=ss',
        douyin_login: expect.objectContaining({ status: 'connected' }),
      }),
    )
  })

  it('登录成功但网络不可达 → 保存 connected + warning（不再产生待验证）', async () => {
    vi.useFakeTimers()
    mockCookiesGet.mockImplementation(async () => [
      { name: 'sid_guard', value: 'sg', domain: '.douyin.com' },
      { name: 'sessionid', value: 'ss', domain: '.douyin.com' },
    ])
    mockLoadConfig.mockReturnValue(baseConfig())
    mockExecuteJS.mockResolvedValue(JSON.stringify({ status: 0 }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    const promise = connectDouyin(null)
    // 3s 轮询 + 1.2s 落定 + 页内探测重试
    await vi.advanceTimersByTimeAsync(12000)
    const result = await promise

    expect(result.success).toBe(true)
    expect(result.warning).toContain('网络不可达')
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        douyin_cookie: 'sid_guard=sg; sessionid=ss',
        douyin_login: expect.objectContaining({ status: 'connected' }),
      }),
    )
  })

  it('isDouyinHost：只认 douyin.com 及其子域', () => {
    expect(isDouyinHost('https://www.douyin.com/passport/login/')).toBe(true)
    expect(isDouyinHost('https://sso.douyin.com/')).toBe(true)
    expect(isDouyinHost('https://example.com/x')).toBe(false)
    expect(isDouyinHost('bytedance://open')).toBe(false)
  })

  it('弹出链接：抖音域内 http/https 允许在应用内打开（登录页必须共享内嵌会话）', async () => {
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig())
    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    const win = MockBrowserWindow.instances[0]
    const result = win.openHandler!({ url: 'https://www.douyin.com/passport/login/' })
    expect(result).toEqual({ action: 'allow' })
    expect(mockOpenExternal).not.toHaveBeenCalled()
    win.close()
    await promise
  })

  it('弹出链接：非抖音域 http/https 走用户默认浏览器', async () => {
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig())
    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    const win = MockBrowserWindow.instances[0]
    const result = win.openHandler!({ url: 'https://www.example.com/help' })
    expect(result).toEqual({ action: 'deny' })
    expect(mockOpenExternal).toHaveBeenCalledWith('https://www.example.com/help')
    win.close()
    await promise
  })

  it('自定义协议（bytedance:// 等）静默拦截：不弹 Windows 协议选择框', async () => {
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig())
    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    const win = MockBrowserWindow.instances[0]
    const result = win.openHandler!({ url: 'bytedance://open?app=aweme' })
    expect(result).toEqual({ action: 'deny' })
    expect(mockOpenExternal).not.toHaveBeenCalled()
    win.close()
    await promise
  })

  it('连接前清掉内嵌会话的旧抖音 cookie（避免显示上次登录账号）', async () => {
    mockCookiesGet.mockImplementation(async () => [
      { name: 'sessionid', value: 'old', domain: '.douyin.com' },
      { name: 'other', value: 'x', domain: 'example.com' },
    ])
    mockLoadConfig.mockReturnValue(baseConfig())
    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    expect(mockCookiesRemove).toHaveBeenCalledWith(
      'https://douyin.com/',
      'sessionid',
    )
    expect(mockCookiesRemove).not.toHaveBeenCalledWith(
      'https://example.com/',
      'other',
    )
    MockBrowserWindow.instances[0].close()
    await promise
  })

  it('will-navigate：主框架禁止离开抖音域（防广告/商店页劫持登录流程）', async () => {
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig())
    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    const win = MockBrowserWindow.instances[0]
    const navHandler = win.handlers['wc:will-navigate'][0]
    const ev = { preventDefault: vi.fn() }
    navHandler(ev, 'https://play.google.com/store/apps/details?id=x')
    expect(ev.preventDefault).toHaveBeenCalled()
    const ev2 = { preventDefault: vi.fn() }
    navHandler(ev2, 'https://www.douyin.com/?recommend=1')
    expect(ev2.preventDefault).not.toHaveBeenCalled()
    win.close()
    await promise
  })

  it('外链限流：同窗口短时间多次 window.open 只打开一次用户浏览器', async () => {
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig())
    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    const win = MockBrowserWindow.instances[0]
    win.openHandler!({ url: 'https://www.example.com/a' })
    win.openHandler!({ url: 'https://www.example.com/b' })
    win.openHandler!({ url: 'https://www.example.com/c' })
    expect(mockOpenExternal).toHaveBeenCalledTimes(1)
    win.close()
    await promise
  })

  it('应用商店域名弹窗（谷歌商店等）静默拦截，不打开浏览器', async () => {
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig())
    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    const win = MockBrowserWindow.instances[0]
    const result = win.openHandler!({ url: 'https://play.google.com/store/apps/details?id=com.ss.android.ugc.aweme' })
    expect(result).toEqual({ action: 'deny' })
    expect(mockOpenExternal).not.toHaveBeenCalled()
    win.close()
    await promise
  })

  it('did-fail-load：-3 重定向中断不误关登录窗，真实错误才失败', async () => {
    vi.useFakeTimers()
    mockCookiesGet.mockImplementation(async () => [])
    mockLoadConfig.mockReturnValue(baseConfig())
    const promise = connectDouyin(null)
    await vi.waitFor(() => {
      expect(MockBrowserWindow.instances.length).toBe(1)
    })
    const win = MockBrowserWindow.instances[0]
    const failHandler = win.handlers['wc:did-fail-load'][0]
    // ERR_ABORTED(-3)：重定向中断，忽略，窗口保持打开
    failHandler({}, -3, 'ERR_ABORTED', 'https://www.douyin.com/', true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(win.destroyed).toBe(false)
    // 真实主框架错误：关闭窗口并返回可读错误
    failHandler({}, -106, 'ERR_CERT_DATE_INVALID', 'https://www.douyin.com/', true)
    await expect(promise).resolves.toEqual({
      success: false,
      error: expect.stringContaining('页面加载失败'),
    })
  })
})
