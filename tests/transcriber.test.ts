import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { PodcastConfig } from '@shared/types'

// ============================================================
// Mock：electron（toast 通知）、whisper 本地引擎
// ============================================================

const mockNotifyToast = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      { webContents: { send: (...args: unknown[]) => mockNotifyToast(...args) } },
    ]),
  },
}))

const mockRunWhisper = vi.hoisted(() => vi.fn())

vi.mock('../src/main/whisper', () => ({
  runWhisper: mockRunWhisper,
}))

import { transcribeAudio } from '../src/main/transcriber/registry'
import { nextSliceId } from '../src/main/transcriber/xfyun'
import { fakeCred } from './fake-cred'

function makeConfig(over: Partial<PodcastConfig> = {}): PodcastConfig {
  return {
    ai_provider: 'deepseek',
    ai_providers: {} as PodcastConfig['ai_providers'],
    api_key: fakeCred(''),
    feishu_app_id: '',
    feishu_app_secret: '',
    language: 'auto',
    feishu_chat_id: '',
    obsidian_dir: 'G:/notes',
    audio_dir: '',
    whisper_exe_path: '',
    whisper_model: 'large-v3-turbo',
    notification_enabled: false,
    douyin_cookie: '',
    ...over,
  } as PodcastConfig
}

function makeHooks() {
  return {
    log: vi.fn(),
    status: vi.fn(),
  }
}

function logText(hooks: ReturnType<typeof makeHooks>): string {
  return hooks.log.mock.calls.map(c => String(c[0])).join('\n')
}

/** 建一个真实的小音频占位文件（云端适配器会 statSync/readFileSync） */
function makeTempAudio(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podmuse-transcriber-'))
  const p = path.join(dir, 'audio.mp3')
  fs.writeFileSync(p, Buffer.from('fake-audio-bytes'))
  return p
}

beforeEach(() => {
  mockRunWhisper.mockReset()
  mockNotifyToast.mockReset()
})

describe('讯飞 signa 签名算法（官方文档样例）', () => {
  it('appid=595f23df ts=1512041814 key=d9f4aa... 应产出文档中的 IrrzsJeOFk1NGfJHW6SkHUoN9CU=', () => {
    // 官方 demo 公式：Base64(HmacSHA1(md5hex(appid + ts), api_key))
    const appId = '595f23df'
    const ts = '1512041814'
    const apiKey = fakeCred('d9f4aa7ea6d94faca62cd88a28fd5234')
    const md5 = crypto
      .createHash('md5')
      .update(appId + ts)
      .digest('hex')
    expect(md5).toBe('0829d4012497c14a30e7e72aeebe565e')
    const signa = crypto.createHmac('sha1', apiKey).update(md5).digest('base64')
    expect(signa).toBe('IrrzsJeOFk1NGfJHW6SkHUoN9CU=')
  })
})

describe('讯飞 slice_id 进位生成', () => {
  it("首片 'aaaaaaaaaa' 的下一片是 'aaaaaaaaab'", () => {
    expect(nextSliceId('aaaaaaaaaa')).toBe('aaaaaaaaab')
  })

  it("'aaaaaaaaaz' 进位到 'aaaaaaaaba'（尾字符 z 归 a，前一位进一）", () => {
    expect(nextSliceId('aaaaaaaaaz')).toBe('aaaaaaaaba')
  })

  it('全 z 时左侧补 a', () => {
    expect(nextSliceId('zzz')).toBe('aaaa')
  })
})

describe('transcribeAudio 编排逻辑', () => {
  it('选本地引擎时直接走 runWhisper，成功返回文本', async () => {
    mockRunWhisper.mockResolvedValue('本地转写文本')
    const hooks = makeHooks()
    const result = await transcribeAudio(
      makeConfig({ transcribe_engine: 'local' }),
      'C:/a.mp3',
      'zh',
      hooks,
    )
    expect(result).toBe('本地转写文本')
    expect(mockRunWhisper).toHaveBeenCalledOnce()
  })

  it('云端引擎未配置时自动用本地并提示', async () => {
    mockRunWhisper.mockResolvedValue('降级文本')
    const hooks = makeHooks()
    const cfg = makeConfig({ transcribe_engine: 'aliyun', aliyun_api_key: '' })
    const result = await transcribeAudio(cfg, 'C:/a.mp3', 'zh', hooks)
    expect(result).toBe('降级文本')
    expect(mockRunWhisper).toHaveBeenCalledOnce()
    expect(logText(hooks)).toContain('未配置')
  })

  it('云端失败（非取消）时自动降级本地重试', async () => {
    const audioPath = makeTempAudio()
    const realFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    try {
      mockRunWhisper.mockResolvedValue('本地兜底文本')
      const hooks = makeHooks()
      const cfg = makeConfig({ transcribe_engine: 'aliyun', aliyun_api_key: 'sk-test' })
      const result = await transcribeAudio(cfg, audioPath, 'zh', hooks)
      expect(result).toBe('本地兜底文本')
      const text = logText(hooks)
      expect(text).toContain('阿里云百炼')
      expect(text).toContain('降级')
      expect(mockRunWhisper).toHaveBeenCalledOnce()
      // 用户应收到 toast 通知
      expect(mockNotifyToast).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({ type: 'error' }),
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('用户主动取消时不降级，直接抛 AbortError', async () => {
    const audioPath = makeTempAudio()
    const realFetch = globalThis.fetch
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('已取消'), { name: 'AbortError' }))
    try {
      const controller = new AbortController()
      const hooks = makeHooks()
      const cfg = makeConfig({ transcribe_engine: 'aliyun', aliyun_api_key: 'sk-test' })
      await expect(
        transcribeAudio(cfg, audioPath, 'zh', hooks, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(mockRunWhisper).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('本地引擎失败时返回 null 不抛错（与旧 runWhisper 契约一致）', async () => {
    mockRunWhisper.mockResolvedValue(null)
    const hooks = makeHooks()
    const result = await transcribeAudio(
      makeConfig({ transcribe_engine: 'local' }),
      'C:/a.mp3',
      'zh',
      hooks,
    )
    expect(result).toBeNull()
  })
})
