/**
 * AI 供应商配置单元测试
 * 覆盖：getAllDefaultProviderConfigs / getActiveProviderConfig（baseUrl /v1 归一化、
 * 无 key 优雅失败）、buildApiUrl、qa-ipc 无 key 可读错误、
 * batch-queue 任务级 providerId+model 覆盖（含无 key 不生效、不崩溃）。
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AIProviderConfig, AIProviderId, PodcastConfig } from '@shared/types'

// ============================================================
// Mock setup — hoisted
// ============================================================

const {
  mockLoadConfig,
  mockGetUserDataDir,
  mockIpcHandle,
  mockAskQuestion,
  mockProcessPodcast,
  mockFetchPodcastTitle,
  mockSendNotification,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockGetUserDataDir: vi.fn(),
  mockIpcHandle: vi.fn(),
  mockAskQuestion: vi.fn(),
  mockProcessPodcast: vi.fn(),
  mockFetchPodcastTitle: vi.fn(),
  mockSendNotification: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: mockIpcHandle },
}))

vi.mock('../src/main/config', () => ({
  loadConfig: mockLoadConfig,
  getUserDataDir: mockGetUserDataDir,
}))

vi.mock('../src/main/qa-service', () => ({
  askQuestion: mockAskQuestion,
}))

vi.mock('../src/main/podcast', () => ({
  processPodcast: mockProcessPodcast,
  fetchPodcastTitle: mockFetchPodcastTitle,
}))

vi.mock('../src/main/notify', () => ({
  sendNotification: mockSendNotification,
}))

vi.mock('../src/main/recent-task-state', () => ({
  startRecentTask: (s: unknown) => s,
  completeRecentTask: (s: unknown) => s,
  failRecentTask: (s: unknown) => s,
  stopRecentTask: (s: unknown) => s,
  reconcileRecentTasksWithBatch: (s: unknown) => s,
}))

vi.mock('../src/main/platforms', () => ({
  platformRegistry: { findAdapter: () => null },
}))

// ============================================================
// 被测真实模块
// ============================================================

import {
  getProviderPreset,
  createDefaultProviderConfig,
  createCustomProviderConfig,
  getAllDefaultProviderConfigs,
  getActiveProviderConfig,
} from '../src/main/ai-providers'
import { buildApiUrl } from '../src/main/ai-client'
import { BatchQueueService } from '../src/main/batch-queue'
import { registerQaIpc } from '../src/main/ipc/qa-ipc'
import { fakeCred } from './fake-cred'

/** 构造一个带 key 的供应商配置副本（默认配置 + 覆盖） */
function withKey(
  providerId: AIProviderId,
  apiKey: string,
  overrides?: Partial<AIProviderConfig>,
): Record<AIProviderId, AIProviderConfig> {
  const configs = getAllDefaultProviderConfigs()
  configs[providerId] = { ...configs[providerId], apiKey, ...(overrides || {}) }
  return configs
}

// ============================================================
// 预设与默认配置
// ============================================================

describe('getProviderPreset / createDefaultProviderConfig', () => {
  it('每个默认供应商都有预设，未知 id 返回 undefined', () => {
    for (const id of [
      'deepseek',
      'openai',
      'moonshot',
      'zhipu',
      'qwen',
      'yi',
      'minimax',
    ] as AIProviderId[]) {
      expect(getProviderPreset(id)).toBeDefined()
      expect(createDefaultProviderConfig(id)).toBeDefined()
    }
    expect(getProviderPreset('custom')).toBeUndefined()
    expect(createDefaultProviderConfig('custom')).toBeUndefined()
  })

  it('默认配置不携带任何真实 key（apiKey 恒为空字符串）', () => {
    for (const id of [
      'deepseek',
      'openai',
      'moonshot',
      'zhipu',
      'qwen',
      'yi',
      'minimax',
    ] as AIProviderId[]) {
      expect(createDefaultProviderConfig(id)?.apiKey).toBe('')
    }
  })

  it('自定义供应商默认配置为空壳', () => {
    const c = createCustomProviderConfig()
    expect(c.id).toBe('custom')
    expect(c.isCustom).toBe(true)
    expect(c.apiKey).toBe('')
    expect(c.baseUrl).toBe('')
    expect(c.model).toBe('')
    expect(c.availableModels).toEqual([])
  })
})

describe('getAllDefaultProviderConfigs', () => {
  it('包含 7 个预设供应商 + custom，共 8 项', () => {
    const configs = getAllDefaultProviderConfigs()
    const keys = Object.keys(configs).sort()
    expect(keys).toEqual(
      ['custom', 'deepseek', 'minimax', 'moonshot', 'openai', 'qwen', 'yi', 'zhipu'].sort(),
    )
  })

  it('每个预设供应商 availableModels 非空，且每个模型 id 为非空字符串', () => {
    const configs = getAllDefaultProviderConfigs()
    for (const id of [
      'deepseek',
      'openai',
      'moonshot',
      'zhipu',
      'qwen',
      'yi',
      'minimax',
    ] as AIProviderId[]) {
      const cfg = configs[id]
      expect(cfg.availableModels.length, `${id}.availableModels 非空`).toBeGreaterThan(0)
      for (const m of cfg.availableModels) {
        expect(typeof m.id, `${id} 模型 id 为字符串`).toBe('string')
        expect(m.id.trim().length, `${id} 模型 id 非空`).toBeGreaterThan(0)
        expect(typeof m.name).toBe('string')
      }
      expect(cfg.baseUrl).toBeTruthy()
    }
  })

  it('每个预设供应商的默认模型都在自己的 availableModels 列表中', () => {
    const configs = getAllDefaultProviderConfigs()
    for (const id of [
      'deepseek',
      'openai',
      'moonshot',
      'zhipu',
      'qwen',
      'yi',
      'minimax',
    ] as AIProviderId[]) {
      const cfg = configs[id]
      expect(
        cfg.availableModels.map(m => m.id),
        `${id} 默认模型 ${cfg.model} 应在列表中`,
      ).toContain(cfg.model)
    }
  })

  it('所有预设供应商默认 apiKey 为空（出厂不带密钥）', () => {
    const configs = getAllDefaultProviderConfigs()
    for (const [id, cfg] of Object.entries(configs)) {
      expect(cfg.apiKey, `${id} 出厂 apiKey 应为空`).toBe('')
    }
  })
})

// ============================================================
// getActiveProviderConfig：/v1 归一化
// ============================================================

describe('getActiveProviderConfig 无 key 时返回 null', () => {
  it('未配置 key 的供应商返回 null', () => {
    const configs = getAllDefaultProviderConfigs() // 所有 apiKey 均为 ''
    expect(getActiveProviderConfig('openai', configs)).toBeNull()
    expect(getActiveProviderConfig('deepseek', configs)).toBeNull()
  })

  it('providers 中不存在该供应商时返回 null', () => {
    expect(
      getActiveProviderConfig('moonshot', {} as Record<AIProviderId, AIProviderConfig>),
    ).toBeNull()
    const partial = { deepseek: getAllDefaultProviderConfigs().deepseek } as Record<
      AIProviderId,
      AIProviderConfig
    >
    expect(getActiveProviderConfig('openai', partial)).toBeNull()
  })

  it('apiKey 为空字符串或仅空白时返回 null（已做 trim 校验）', () => {
    const configs = withKey('deepseek', '')
    expect(getActiveProviderConfig('deepseek', configs)).toBeNull()
    const configs2 = withKey('deepseek', '   ')
    expect(getActiveProviderConfig('deepseek', configs2)).toBeNull()
  })

  it('不修改传入的 providers 配置对象（baseUrl 归一化不产生副作用）', () => {
    const configs = withKey('openai', 'test-key')
    const before = configs.openai.baseUrl
    getActiveProviderConfig('openai', configs)
    expect(configs.openai.baseUrl).toBe(before)
  })
})

describe('getActiveProviderConfig baseUrl /v1 归一化（默认供应商）', () => {
  it('按每个默认供应商的 baseUrl 归一化并透传 apiKey/model', () => {
    const expected: Array<[AIProviderId, string]> = [
      // 不带 /v1 → 自动补 /v1
      ['deepseek', 'https://api.deepseek.com/v1'],
      // 已带 /v1 → 保持不变
      ['openai', 'https://api.openai.com/v1'],
      ['moonshot', 'https://api.moonshot.cn/v1'],
      // zhipu 预设 baseUrl 是版本化路径 /api/paas/v4：normalizeBaseUrl 识别
      // /v\d+ 结尾保持原样，不再机械追加 /v1（官方端点为 /api/paas/v4/chat/completions）
      ['zhipu', 'https://open.bigmodel.cn/api/paas/v4'],
      ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
      ['yi', 'https://api.lingyiwanwu.com/v1'],
      ['minimax', 'https://api.minimax.chat/v1'],
    ]
    for (const [id, normalized] of expected) {
      const configs = withKey(id, 'test-key')
      const result = getActiveProviderConfig(id, configs)
      expect(result, `${id} 应有配置`).not.toBeNull()
      expect(result!.baseUrl).toBe(normalized)
      expect(result!.apiKey).toBe('test-key')
      expect(result!.model).toBe(getAllDefaultProviderConfigs()[id].model)
    }
  })
})

describe('getActiveProviderConfig baseUrl 归一化边界（自定义值）', () => {
  function run(baseUrl: string): { baseUrl: string; apiKey: string; model: string } | null {
    const configs = withKey('custom', 'test-key', { baseUrl, model: 'm1' })
    return getActiveProviderConfig('custom', configs)
  }

  it('不带 /v1 的裸域名补上 /v1', () => {
    expect(run('https://api.example.com')!.baseUrl).toBe('https://api.example.com/v1')
  })

  it('带尾部斜杠（单个/多个）时先去掉再补 /v1', () => {
    expect(run('https://api.example.com/')!.baseUrl).toBe('https://api.example.com/v1')
    expect(run('https://api.example.com////')!.baseUrl).toBe('https://api.example.com/v1')
  })

  it('已带 /v1 的保持不变（尾部斜杠被去掉）', () => {
    expect(run('https://api.example.com/v1')!.baseUrl).toBe('https://api.example.com/v1')
    expect(run('https://api.example.com/v1/')!.baseUrl).toBe('https://api.example.com/v1')
  })

  it('含 /v1/ 子路径（如 /v1/chat/completions）保持不变', () => {
    expect(run('https://api.example.com/v1/chat/completions')!.baseUrl).toBe(
      'https://api.example.com/v1/chat/completions',
    )
  })

  it('空 baseUrl 不崩溃、原样返回空字符串', () => {
    expect(run('')!.baseUrl).toBe('')
  })

  it('版本化路径 /api/paas/v4 保持原样（智谱类端点不追加 /v1）', () => {
    expect(run('https://api.example.com/api/paas/v4')!.baseUrl).toBe(
      'https://api.example.com/api/paas/v4',
    )
    expect(run('https://api.example.com/api/paas/v4/')!.baseUrl).toBe(
      'https://api.example.com/api/paas/v4',
    )
  })
})

// ============================================================
// buildApiUrl（ai-client 第二层归一化）
// ============================================================

describe('buildApiUrl', () => {
  it('裸域名补 /v1 并拼 /chat/completions', () => {
    expect(buildApiUrl('https://api.example.com', 'openai')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(buildApiUrl('https://api.example.com/', 'openai')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
  })

  it('已带 /v1（含尾部斜杠）不重复追加、不产生双斜杠', () => {
    expect(buildApiUrl('https://api.example.com/v1', 'openai')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(buildApiUrl('https://api.example.com/v1/', 'openai')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
  })

  it('getActiveProviderConfig + buildApiUrl 两层归一化对常规 URL 幂等', () => {
    const configs = withKey('openai', 'test-key', { baseUrl: 'https://api.openai.com' })
    const active = getActiveProviderConfig('openai', configs)!
    expect(buildApiUrl(active.baseUrl, 'openai')).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('智谱端到端 URL：版本化路径 /api/paas/v4 直接拼 /chat/completions', () => {
    // 官方端点为 https://open.bigmodel.cn/api/paas/v4/chat/completions
    const configs = withKey('zhipu', 'test-key')
    const active = getActiveProviderConfig('zhipu', configs)!
    expect(buildApiUrl(active.baseUrl, 'zhipu')).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    )
  })

  it('版本化路径（非 /v1）不追加 /v1', () => {
    expect(buildApiUrl('https://api.example.com/api/paas/v4', 'custom')).toBe(
      'https://api.example.com/api/paas/v4/chat/completions',
    )
  })
})

// ============================================================
// qa-ipc：无 key 优雅错误路径
// ============================================================

describe('qa-ipc 无 key 优雅错误路径', () => {
  let askHandler: (event: unknown, params: unknown) => Promise<unknown>

  beforeAll(async () => {
    registerQaIpc()
    const call = mockIpcHandle.mock.calls.find((c: unknown[]) => c[0] === 'qa:ask')
    askHandler = call![1] as (event: unknown, params: unknown) => Promise<unknown>
  })

  beforeEach(() => {
    mockLoadConfig.mockReset()
    mockAskQuestion.mockReset()
  })

  function makeEvent(send: (...args: unknown[]) => void) {
    return { sender: { send } }
  }

  it('无效请求直接拒绝，不抛错', async () => {
    const send = vi.fn()
    const r = await askHandler(makeEvent(send), null)
    expect(r).toEqual({ success: false, error: '无效请求' })
  })

  it('选中供应商未配置 key（且无 legacy api_key）→ 返回可读错误，不抛异常', async () => {
    // 默认供应商均无 key，openai 被选中
    mockLoadConfig.mockReturnValue({
      ai_provider: 'openai',
      ai_providers: getAllDefaultProviderConfigs(),
      api_key: fakeCred(''),
      obsidian_dir: '',
    } as unknown as PodcastConfig)

    const send = vi.fn()
    await expect(
      askHandler(makeEvent(send), { requestId: 'r1', question: '测试' }),
    ).resolves.toEqual({
      success: true,
      started: false,
    })
    expect(send).toHaveBeenCalledWith('qa:error', {
      requestId: 'r1',
      error: '未配置 AI 模型，请在设置中配置',
    })
    expect(mockAskQuestion).not.toHaveBeenCalled()
  })

  it('配置了 key 时正常走 QA 流程，且 baseUrl 已归一化', async () => {
    mockLoadConfig.mockReturnValue({
      ai_provider: 'deepseek',
      ai_providers: withKey('deepseek', 'test-key'),
      api_key: fakeCred(''),
      obsidian_dir: 'C:/notes',
    } as unknown as PodcastConfig)
    mockAskQuestion.mockResolvedValue({ answer: 'A', sources: [] })

    const send = vi.fn()
    const r = await askHandler(makeEvent(send), { requestId: 'r2', question: '问题' })
    expect(r).toEqual({ success: true, started: true })
    expect(mockAskQuestion).toHaveBeenCalledWith(
      'C:/notes',
      { baseUrl: 'https://api.deepseek.com/v1', apiKey: fakeCred('test-key'), model: 'deepseek-v4-flash' },
      'deepseek',
      '问题',
      expect.any(Function),
      expect.anything(),
    )
    expect(send).toHaveBeenCalledWith('qa:done', { requestId: 'r2', answer: 'A', sources: [] })
  })

  it('未配置 Obsidian 目录时给出可读错误', async () => {
    mockLoadConfig.mockReturnValue({
      ai_provider: 'deepseek',
      ai_providers: withKey('deepseek', 'test-key'),
      api_key: fakeCred(''),
      obsidian_dir: '',
    } as unknown as PodcastConfig)

    const send = vi.fn()
    await askHandler(makeEvent(send), { requestId: 'r3', question: '问题' })
    expect(send).toHaveBeenCalledWith('qa:error', {
      requestId: 'r3',
      error: '未配置 Obsidian 笔记目录',
    })
  })
})

// ============================================================
// batch-queue：任务级 providerId+model 覆盖
// ============================================================

describe('batch-queue 任务级模型覆盖', () => {
  let tmpDir: string
  let queue: BatchQueueService & { forceFlush: () => void }

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdmuse-ai-provider-test-'))
    mockGetUserDataDir.mockReturnValue(tmpDir)
    mockProcessPodcast.mockResolvedValue('note.md')

    queue = new BatchQueueService({
      onTaskUpdate: vi.fn(),
      onQueueStateChange: vi.fn(),
      onQueueComplete: vi.fn(),
      sendStep: vi.fn(),
      sendLog: vi.fn(),
      updateRecentState: (updater: (s: unknown) => unknown) => {
        updater(null)
      },
    }) as BatchQueueService & { forceFlush: () => void }
  })

  afterEach(() => {
    try {
      queue.forceFlush()
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  async function runTask(task: { providerId?: string; model?: string }) {
    queue.addTasks([{ source: 'file-a.mp3', type: 'file', title: 'A', ...task }])
    await (queue as unknown as { processTask(i: number): Promise<void> }).processTask(0)
  }

  it('覆盖目标供应商无 apiKey 时：覆盖不生效、回退活跃供应商、不崩溃', async () => {
    mockLoadConfig.mockReturnValue({
      ai_provider: 'deepseek',
      ai_providers: withKey('deepseek', 'ds-key'), // openai 等无 key
      api_key: fakeCred(''),
    } as unknown as PodcastConfig)

    await runTask({ providerId: 'openai', model: 'gpt-4o' })

    const providerArg = mockProcessPodcast.mock.calls[0][1]
    expect(providerArg).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: fakeCred('ds-key'),
      model: 'deepseek-v4-flash',
    })
    const state = queue.getState()
    expect(state.tasks[0].status).toBe('completed')
  })

  it('覆盖目标供应商有 apiKey 时：覆盖生效，baseUrl 同样归一化', async () => {
    const providers = withKey('deepseek', 'ds-key')
    providers.openai = { ...providers.openai, apiKey: fakeCred('oa-key'), baseUrl: 'https://api.openai.com' }
    mockLoadConfig.mockReturnValue({
      ai_provider: 'deepseek',
      ai_providers: providers,
      api_key: fakeCred(''),
    } as unknown as PodcastConfig)

    await runTask({ providerId: 'openai', model: 'gpt-4o' })

    const providerArg = mockProcessPodcast.mock.calls[0][1]
    expect(providerArg).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: fakeCred('oa-key'),
      model: 'gpt-4o',
    })
  })

  it('活跃供应商无 key 且 legacy api_key 为空：activeProvider 为 null 传入，不崩溃', async () => {
    mockLoadConfig.mockReturnValue({
      ai_provider: 'openai', // 无 key
      ai_providers: getAllDefaultProviderConfigs(), // 全部无 key
      api_key: fakeCred(''),
    } as unknown as PodcastConfig)

    await runTask({})

    const providerArg = mockProcessPodcast.mock.calls[0][1]
    expect(providerArg).toBeNull()
    // processPodcast（真实实现）对 null provider 有可读错误守卫：返回 null 并日志
    // 「未配置 AI 供应商，跳过 AI 处理」。此处 mock 返回 note.md 仅验证队列不崩溃。
  })

  it('活跃供应商无 key 但 legacy api_key 有值：回退到旧 DeepSeek 字段', async () => {
    mockLoadConfig.mockReturnValue({
      ai_provider: 'openai',
      ai_providers: getAllDefaultProviderConfigs(),
      api_key: fakeCred('legacy-key'),
    } as unknown as PodcastConfig)

    await runTask({})

    const providerArg = mockProcessPodcast.mock.calls[0][1]
    expect(providerArg).toEqual({
      baseUrl: 'https://api.deepseek.com',
      apiKey: fakeCred('legacy-key'),
      model: 'deepseek-chat',
    })
  })

  it('覆盖 providerId 指向不存在的供应商时：忽略覆盖、沿用活跃供应商，不崩溃', async () => {
    mockLoadConfig.mockReturnValue({
      ai_provider: 'deepseek',
      ai_providers: withKey('deepseek', 'ds-key'),
      api_key: fakeCred(''),
    } as unknown as PodcastConfig)

    await runTask({ providerId: 'not-exist', model: 'm' })

    const providerArg = mockProcessPodcast.mock.calls[0][1]
    expect(providerArg).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: fakeCred('ds-key'),
      model: 'deepseek-v4-flash',
    })
  })

  it('只有 model 没有 providerId 时：不触发覆盖', async () => {
    mockLoadConfig.mockReturnValue({
      ai_provider: 'deepseek',
      ai_providers: withKey('deepseek', 'ds-key'),
      api_key: fakeCred(''),
    } as unknown as PodcastConfig)

    await runTask({ model: 'gpt-4o' })

    const providerArg = mockProcessPodcast.mock.calls[0][1]
    expect(providerArg!.model).toBe('deepseek-v4-flash')
  })
})
