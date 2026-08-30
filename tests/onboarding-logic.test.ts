/**
 * 首次启动向导判定/恢复步骤纯函数测试（src/renderer/data/onboarding-logic.ts）。
 * 判定逻辑依据 docs/无感配置方案.md §3.1 / §3.2：
 * - 弹窗条件 = (活跃供应商无 key 且无 legacy api_key) 或 obsidian_dir 为空（Whisper 不构成弹窗条件）
 * - completed / neverShowAgain 优先跳过
 * - computeStep 从 onboarding.lastStep 起、跳过已满足前置步、封顶 4
 */
import { describe, it, expect } from 'vitest'
import {
  ONBOARDING_VERSION,
  FIRST_STEP,
  DONE_STEP,
  getActiveProviderKey,
  hasLegacyApiKey,
  isCoreConfigured,
  shouldShowWizard,
  stepSatisfied,
  computeStep,
} from '../src/renderer/data/onboarding-logic'
import type { AIProviderConfig, PodcastConfig } from '../src/shared/types'
import { fakeCred } from './fake-cred'

function provider(apiKey = ''): AIProviderConfig {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    apiKey,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    availableModels: [],
  }
}

/** 最小配置构造器：只填逻辑函数关心的字段，其余以 as 断言补全类型 */
function makeConfig(patch: Partial<PodcastConfig> = {}): PodcastConfig {
  const config = {
    ai_provider: 'deepseek' as const,
    ai_providers: { deepseek: provider() },
    api_key: fakeCred(''),
    feishu_app_id: '',
    feishu_app_secret: '',
    language: 'auto' as const,
    feishu_chat_id: '',
    obsidian_dir: '',
    audio_dir: '',
    whisper_exe_path: '',
    whisper_model: 'large-v3-turbo',
    notification_enabled: true,
    douyin_cookie: '',
    subscriptions: [],
    ...patch,
  } as unknown as PodcastConfig
  return config
}

/** 核心三项配齐的配置（Key + 目录 + Whisper） */
function configuredConfig(): PodcastConfig {
  return makeConfig({
    ai_providers: { deepseek: provider('sk-abcdef123456') },
    obsidian_dir: 'C:/Users/test/Documents/PodMuse笔记',
    whisper_exe_path: 'C:/tools/faster-whisper-xxl.exe',
  })
}

describe('常量', () => {
  it('版本与步骤边界', () => {
    expect(ONBOARDING_VERSION).toBe(1)
    expect(FIRST_STEP).toBe(1)
    expect(DONE_STEP).toBe(4)
  })
})

describe('getActiveProviderKey', () => {
  it('取活跃供应商的 apiKey', () => {
    const c = makeConfig({ ai_providers: { deepseek: provider('sk-abc123456789') } })
    expect(getActiveProviderKey(c)).toBe('sk-abc123456789')
  })

  it('deepseek 且无 provider key 时兜底 legacy api_key', () => {
    const c = makeConfig({ api_key: fakeCred('sk-legacy123456') })
    expect(getActiveProviderKey(c)).toBe('sk-legacy123456')
  })

  it('非 deepseek 供应商不兜底 legacy api_key', () => {
    const c = makeConfig({
      ai_provider: 'zhipu',
      api_key: fakeCred('sk-legacy123456'),
      ai_providers: { deepseek: provider() },
    })
    expect(getActiveProviderKey(c)).toBe('')
  })

  it('key 前后空白会被 trim', () => {
    const c = makeConfig({ ai_providers: { deepseek: provider('  sk-abc123456789  ') } })
    expect(getActiveProviderKey(c)).toBe('sk-abc123456789')
  })
})

describe('hasLegacyApiKey', () => {
  it('有 legacy api_key 为 true，空/缺失为 false', () => {
    expect(hasLegacyApiKey(makeConfig({ api_key: fakeCred('sk-x') }))).toBe(true)
    expect(hasLegacyApiKey(makeConfig({ api_key: fakeCred('') }))).toBe(false)
    expect(hasLegacyApiKey(makeConfig({ api_key: fakeCred('   ') }))).toBe(false)
  })
})

describe('isCoreConfigured', () => {
  it('核心三项配齐 → true', () => {
    expect(isCoreConfigured(configuredConfig())).toBe(true)
  })

  it('legacy api_key 也算 Key 来源', () => {
    const c = configuredConfig()
    const legacy = makeConfig({
      ...c,
      api_key: fakeCred('sk-legacy'),
      ai_providers: { deepseek: provider() },
    })
    expect(isCoreConfigured(legacy)).toBe(true)
  })

  it('缺 Key / 缺目录 / 缺 Whisper 均为 false', () => {
    expect(isCoreConfigured(makeConfig({}))).toBe(false)
    const noKey = makeConfig({
      obsidian_dir: 'D:/notes',
      whisper_exe_path: 'C:/tools/faster-whisper-xxl.exe',
    })
    expect(isCoreConfigured(noKey)).toBe(false)
    const noDir = makeConfig({
      ai_providers: { deepseek: provider('sk-abcdef123456') },
      whisper_exe_path: 'C:/tools/faster-whisper-xxl.exe',
    })
    expect(isCoreConfigured(noDir)).toBe(false)
    const noWhisper = makeConfig({
      ai_providers: { deepseek: provider('sk-abcdef123456') },
      obsidian_dir: 'D:/notes',
    })
    expect(isCoreConfigured(noWhisper)).toBe(false)
  })
})

describe('shouldShowWizard', () => {
  it('onboarding.completed=true 不弹（即使核心缺失）', () => {
    const c = makeConfig({ onboarding: { version: 1, completed: true, lastStep: 4 } })
    expect(shouldShowWizard(c)).toBe(false)
  })

  it('neverShowAgain=true 不弹', () => {
    const c = makeConfig({
      onboarding: { version: 1, completed: false, lastStep: 2, neverShowAgain: true },
    })
    expect(shouldShowWizard(c)).toBe(false)
  })

  it('新用户（核心全缺）→ 弹', () => {
    expect(shouldShowWizard(makeConfig({}))).toBe(true)
  })

  it('active provider 有 key + 目录配齐但缺 Whisper → 不弹（Whisper 不构成弹窗条件）', () => {
    const c = makeConfig({
      ai_providers: { deepseek: provider('sk-abcdef123456') },
      obsidian_dir: 'D:/notes',
      whisper_exe_path: '',
    })
    expect(shouldShowWizard(c)).toBe(false)
  })

  it('active provider 无 key 但有 legacy api_key + 目录 → 不弹', () => {
    const c = makeConfig({ api_key: fakeCred('sk-legacy123456'), obsidian_dir: 'D:/notes' })
    expect(shouldShowWizard(c)).toBe(false)
  })

  it('有 key 但目录为空 → 弹', () => {
    const c = makeConfig({ ai_providers: { deepseek: provider('sk-abcdef123456') } })
    expect(shouldShowWizard(c)).toBe(true)
  })

  it('onboarding 缺失（老用户升级）：核心配齐不打扰、核心缺失弹', () => {
    expect(shouldShowWizard(configuredConfig())).toBe(false)
    expect(shouldShowWizard(makeConfig({ obsidian_dir: 'D:/notes' }))).toBe(true)
  })

  it('非 deepseek 活跃供应商无 key 且无 legacy → 弹（即使其它供应商有 key）', () => {
    const c = makeConfig({
      ai_provider: 'zhipu',
      ai_providers: {
        deepseek: provider('sk-other123456'),
        zhipu: { ...provider(''), id: 'zhipu', name: '智谱AI (GLM)' },
      },
      obsidian_dir: 'D:/notes',
    })
    expect(shouldShowWizard(c)).toBe(true)
  })
})

describe('stepSatisfied', () => {
  it('按步返回对应字段就绪状态', () => {
    const c = configuredConfig()
    expect(stepSatisfied(c, 1)).toBe(true)
    expect(stepSatisfied(c, 2)).toBe(true)
    expect(stepSatisfied(c, 3)).toBe(true)
    expect(stepSatisfied(makeConfig({}), 1)).toBe(false)
    expect(stepSatisfied(makeConfig({}), 2)).toBe(false)
    expect(stepSatisfied(makeConfig({}), 3)).toBe(false)
    expect(stepSatisfied(c, 0)).toBe(false)
    expect(stepSatisfied(c, 4)).toBe(false)
  })
})

describe('computeStep', () => {
  it('无 onboarding / 非法 lastStep → 第 1 步', () => {
    expect(computeStep(makeConfig({}))).toBe(1)
    expect(
      computeStep(
        makeConfig({
          onboarding: { version: 1, completed: false, lastStep: 'x' as unknown as number },
        }),
      ),
    ).toBe(1)
  })

  it('按 lastStep 恢复', () => {
    const c = makeConfig({ onboarding: { version: 1, completed: false, lastStep: 2 } })
    expect(computeStep(c)).toBe(2)
  })

  it('lastStep=1 但 Key 已配 → 跳到 2', () => {
    const c = makeConfig({
      ai_providers: { deepseek: provider('sk-abcdef123456') },
      onboarding: { version: 1, completed: false, lastStep: 1 },
    })
    expect(computeStep(c)).toBe(2)
  })

  it('lastStep=1 但 Key+目录已配 → 跳到 3', () => {
    const c = makeConfig({
      ai_providers: { deepseek: provider('sk-abcdef123456') },
      obsidian_dir: 'D:/notes',
      onboarding: { version: 1, completed: false, lastStep: 1 },
    })
    expect(computeStep(c)).toBe(3)
  })

  it('三项全配 → 完成页 4', () => {
    const c = makeConfig({
      ...configuredConfig(),
      onboarding: { version: 1, completed: false, lastStep: 1 },
    })
    expect(computeStep(c)).toBe(4)
  })

  it('lastStep 越界封顶/兜底：0 → 1，99 → 4', () => {
    expect(
      computeStep(makeConfig({ onboarding: { version: 1, completed: false, lastStep: 0 } })),
    ).toBe(1)
    expect(
      computeStep(makeConfig({ onboarding: { version: 1, completed: false, lastStep: 99 } })),
    ).toBe(4)
  })

  it('lastStep=3 且 Whisper 已配 → 4', () => {
    const c = makeConfig({
      ai_providers: { deepseek: provider('sk-abcdef123456') },
      obsidian_dir: 'D:/notes',
      whisper_exe_path: 'C:/tools/faster-whisper-xxl.exe',
      onboarding: { version: 1, completed: false, lastStep: 3 },
    })
    expect(computeStep(c)).toBe(4)
  })
})
