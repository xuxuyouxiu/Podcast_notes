import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import type { PodcastConfig } from '@shared/types'
import { fakeCred } from './fake-cred'

// ============================================================
// Mock setup — hoisted so factories can reference these
// ============================================================

const {
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockMkdirSync,
  mockIsSafeDirectoryPath,
  mockIsSafeExecutablePath,
  mockDecryptField,
  mockGetPath,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockIsSafeDirectoryPath: vi.fn().mockReturnValue(true),
  mockIsSafeExecutablePath: vi.fn().mockReturnValue(true),
  mockDecryptField: vi.fn(),
  mockGetPath: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: mockGetPath },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
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
  decryptField: mockDecryptField,
  isSafeDirectoryPath: mockIsSafeDirectoryPath,
  isSafeExecutablePath: mockIsSafeExecutablePath,
}))

vi.mock('../src/main/platforms/yt-dlp', () => ({
  detectYtDlp: vi.fn(),
}))

vi.mock('../src/main/backlinks', () => ({
  buildBacklinkIndex: vi.fn(),
  buildTagIndex: vi.fn(),
}))

// ============================================================
// Constants
// ============================================================

const USER_DATA_DIR = 'C:\\Users\\test\\AppData\\Roaming\\podcast-notes'
const USER_CONFIG_PATH = path.join(USER_DATA_DIR, 'podcast_config.json')

// ============================================================
// stripPlaceholderValues
// ============================================================

describe('stripPlaceholderValues', () => {
  let stripPlaceholderValues: (config: PodcastConfig) => PodcastConfig

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../src/main/config')
    stripPlaceholderValues = mod.stripPlaceholderValues
  })

  it('cleans values starting with "你的" for all targeted fields', () => {
    const config = {
      api_key: fakeCred('你的API密钥'),
      feishu_app_id: '你的飞书App ID',
      feishu_app_secret: '你的飞书App Secret',
      feishu_chat_id: '你的飞书Chat ID',
      obsidian_dir: '你的Obsidian目录',
      whisper_exe_path: '你的Whisper路径',
    } as PodcastConfig

    const result = stripPlaceholderValues(config)

    expect(result.api_key).toBe('')
    expect(result.feishu_app_id).toBe('')
    expect(result.feishu_app_secret).toBe('')
    expect(result.feishu_chat_id).toBe('')
    expect(result.obsidian_dir).toBe('')
    expect(result.whisper_exe_path).toBe('')
  })

  it('preserves non-placeholder string values', () => {
    const config = {
      api_key: fakeCred('sk-1234567890'),
      feishu_app_id: 'cli_abc123',
      feishu_app_secret: 'secret123',
      feishu_chat_id: 'oc_xyz',
      obsidian_dir: 'C:\\Users\\test\\obsidian',
      whisper_exe_path: 'C:\\Tools\\whisper.exe',
    } as PodcastConfig

    const result = stripPlaceholderValues(config)

    expect(result.api_key).toBe('sk-1234567890')
    expect(result.feishu_app_id).toBe('cli_abc123')
    expect(result.feishu_app_secret).toBe('secret123')
    expect(result.feishu_chat_id).toBe('oc_xyz')
    expect(result.obsidian_dir).toBe('C:\\Users\\test\\obsidian')
    expect(result.whisper_exe_path).toBe('C:\\Tools\\whisper.exe')
  })

  it('preserves empty strings unchanged', () => {
    const config = {
      api_key: fakeCred(''),
      feishu_app_id: '',
      obsidian_dir: '',
    } as PodcastConfig

    const result = stripPlaceholderValues(config)

    expect(result.api_key).toBe('')
    expect(result.feishu_app_id).toBe('')
    expect(result.obsidian_dir).toBe('')
  })

  it('does not mutate the original config', () => {
    const config = {
      api_key: fakeCred('你的API密钥'),
      feishu_app_id: 'cli_abc123',
    } as PodcastConfig

    stripPlaceholderValues(config)

    expect(config.api_key).toBe('你的API密钥')
    expect(config.feishu_app_id).toBe('cli_abc123')
  })

  it('ignores non-string field values', () => {
    const config = {
      api_key: 12345,
      notification_enabled: true,
    } as unknown as PodcastConfig

    const result = stripPlaceholderValues(config)

    expect(result.api_key).toBe(12345)
    expect(result.notification_enabled).toBe(true)
  })

  it('handles mixed placeholder and non-placeholder values', () => {
    const config = {
      api_key: fakeCred('你的API密钥'),
      feishu_app_id: 'cli_abc123',
      feishu_app_secret: '你的飞书App Secret',
      obsidian_dir: 'C:\\Users\\test\\obsidian',
    } as PodcastConfig

    const result = stripPlaceholderValues(config)

    expect(result.api_key).toBe('')
    expect(result.feishu_app_id).toBe('cli_abc123')
    expect(result.feishu_app_secret).toBe('')
    expect(result.obsidian_dir).toBe('C:\\Users\\test\\obsidian')
  })

  it('does not clean fields not in the targeted list', () => {
    const config = {
      language: '你的语言',
      whisper_model: '你的模型',
      ai_provider: '你的供应商',
    } as unknown as PodcastConfig

    const result = stripPlaceholderValues(config)

    // language, whisper_model, ai_provider are NOT in fieldsToClean
    expect(result.language).toBe('你的语言')
    expect(result.whisper_model).toBe('你的模型')
    expect(result.ai_provider).toBe('你的供应商')
  })
})

// ============================================================
// validateConfigInput
// ============================================================

describe('validateConfigInput', () => {
  let validateConfigInput: (config: Record<string, unknown>) => string | null

  beforeEach(async () => {
    vi.resetModules()
    mockIsSafeDirectoryPath.mockReturnValue(true)
    mockIsSafeExecutablePath.mockReturnValue(true)

    const mod = await import('../src/main/ipc/config-ipc')
    validateConfigInput = mod.validateConfigInput
  })

  it('returns null for valid config', () => {
    expect(validateConfigInput({ ai_provider: 'deepseek', api_key: fakeCred('sk-123') })).toBeNull()
  })

  it('returns null for empty config object', () => {
    expect(validateConfigInput({})).toBeNull()
  })

  it('accepts all valid AI providers', () => {
    const valid = ['deepseek', 'openai', 'moonshot', 'zhipu', 'qwen', 'yi', 'minimax', 'custom']
    for (const provider of valid) {
      expect(validateConfigInput({ ai_provider: provider })).toBeNull()
    }
  })

  it('returns error for non-object config', () => {
    expect(validateConfigInput(null as any)).toBe('配置必须是对象')
    expect(validateConfigInput(undefined as any)).toBe('配置必须是对象')
    expect(validateConfigInput('string' as any)).toBe('配置必须是对象')
    expect(validateConfigInput(42 as any)).toBe('配置必须是对象')
  })

  it('returns error for invalid string field types', () => {
    expect(validateConfigInput({ api_key: 12345 })).toBe('字段 api_key 类型无效')
    expect(validateConfigInput({ language: true })).toBe('字段 language 类型无效')
    expect(validateConfigInput({ whisper_model: {} })).toBe('字段 whisper_model 类型无效')
  })

  it('returns error for invalid ai_provider value', () => {
    expect(validateConfigInput({ ai_provider: 'invalid' })).toBe('无效的 AI 供应商: invalid')
    expect(validateConfigInput({ ai_provider: 'chatgpt' })).toBe('无效的 AI 供应商: chatgpt')
  })

  it('returns error for unsafe obsidian_dir path', () => {
    mockIsSafeDirectoryPath.mockReturnValue(false)
    expect(validateConfigInput({ obsidian_dir: 'C:\\Windows\\system32' })).toBe(
      '路径不安全: obsidian_dir'
    )
  })

  it('returns error for unsafe audio_dir path', () => {
    mockIsSafeDirectoryPath.mockReturnValue(false)
    expect(validateConfigInput({ audio_dir: 'C:\\Windows' })).toBe('路径不安全: audio_dir')
  })

  it('skips directory validation for empty or whitespace-only paths', () => {
    mockIsSafeDirectoryPath.mockReturnValue(false)
    expect(validateConfigInput({ obsidian_dir: '' })).toBeNull()
    expect(validateConfigInput({ obsidian_dir: '   ' })).toBeNull()
    expect(validateConfigInput({ audio_dir: '' })).toBeNull()
  })

  it('returns error for unsafe executable path', () => {
    mockIsSafeExecutablePath.mockReturnValue(false)
    expect(validateConfigInput({ whisper_exe_path: 'C:\\Windows\\cmd.exe' })).toBe(
      '可执行文件路径不安全: C:\\Windows\\cmd.exe'
    )
  })

  it('skips executable validation for empty or whitespace-only paths', () => {
    mockIsSafeExecutablePath.mockReturnValue(false)
    expect(validateConfigInput({ whisper_exe_path: '' })).toBeNull()
    expect(validateConfigInput({ whisper_exe_path: '   ' })).toBeNull()
  })

  it('returns error for invalid export.notion.token type', () => {
    expect(validateConfigInput({ export: { notion: { token: 12345 } } })).toBe(
      '字段 export.notion.token 类型无效'
    )
  })

  it('returns error for invalid export.notion.database_id type', () => {
    expect(validateConfigInput({ export: { notion: { database_id: false } } })).toBe(
      '字段 export.notion.database_id 类型无效'
    )
  })

  it('returns error for unsafe export.logseq_dir', () => {
    mockIsSafeDirectoryPath.mockReturnValue(false)
    expect(validateConfigInput({ export: { logseq_dir: 'C:\\Windows' } })).toBe(
      '路径不安全: export.logseq_dir'
    )
  })

  it('skips export.logseq_dir validation when empty', () => {
    mockIsSafeDirectoryPath.mockReturnValue(false)
    expect(validateConfigInput({ export: { logseq_dir: '' } })).toBeNull()
  })

  it('skips export validation when export is undefined or null', () => {
    expect(validateConfigInput({ export: undefined })).toBeNull()
    expect(validateConfigInput({ export: null })).toBeNull()
  })

  it('returns error for invalid ai_providers entry', () => {
    expect(validateConfigInput({ ai_providers: { deepseek: 'not_object' } })).toBe(
      'AI 供应商配置无效'
    )
    expect(validateConfigInput({ ai_providers: { deepseek: null } })).toBe('AI 供应商配置无效')
  })

  it('accepts valid ai_providers object', () => {
    expect(
      validateConfigInput({
        ai_providers: { deepseek: { apiKey: fakeCred('sk-123'), model: 'deepseek-chat' } },
      })
    ).toBeNull()
  })
})

// ============================================================
// loadConfig
// ============================================================

describe('loadConfig', () => {
  beforeEach(() => {
    vi.resetModules()
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
    mockGetPath.mockReset()
    mockGetPath.mockReturnValue(USER_DATA_DIR)
    mockDecryptField.mockReset()
  })

  it('loads user config when file exists', async () => {
    mockExistsSync.mockImplementation((p: string) => p === USER_CONFIG_PATH)
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === USER_CONFIG_PATH) return JSON.stringify({ api_key: fakeCred('sk-test123') })
      return ''
    })

    const { loadConfig, clearConfigCache } = await import('../src/main/config'); clearConfigCache()
    const result = loadConfig()

    expect(result.api_key).toBe('sk-test123')
  })

  it('merges user config with defaults', async () => {
    mockExistsSync.mockImplementation((p: string) => p === USER_CONFIG_PATH)
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === USER_CONFIG_PATH) return JSON.stringify({ api_key: fakeCred('sk-test') })
      return ''
    })

    const { loadConfig, clearConfigCache } = await import('../src/main/config'); clearConfigCache()
    const result = loadConfig()

    expect(result.api_key).toBe('sk-test')
    expect(result.ai_provider).toBe('deepseek')
    expect(result.language).toBe('auto')
    expect(result.whisper_model).toBe('large-v3-turbo')
    expect(result.notification_enabled).toBe(true)
  })

  it('strips placeholder values from loaded config', async () => {
    mockExistsSync.mockImplementation((p: string) => p === USER_CONFIG_PATH)
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === USER_CONFIG_PATH)
        return JSON.stringify({
          api_key: fakeCred('你的API密钥'),
          feishu_app_id: '你的飞书App ID',
          obsidian_dir: 'C:\\Users\\test\\obsidian',
        })
      return ''
    })

    const { loadConfig, clearConfigCache } = await import('../src/main/config'); clearConfigCache()
    const result = loadConfig()

    expect(result.api_key).toBe('')
    expect(result.feishu_app_id).toBe('')
    expect(result.obsidian_dir).toBe('C:\\Users\\test\\obsidian')
  })

  it('returns defaults when no config files exist', async () => {
    mockExistsSync.mockReturnValue(false)

    const { loadConfig, clearConfigCache } = await import('../src/main/config'); clearConfigCache()
    const result = loadConfig()

    expect(result.ai_provider).toBe('deepseek')
    expect(result.api_key).toBe('')
    expect(result.language).toBe('auto')
    expect(result.notification_enabled).toBe(true)
  })

  it('handles malformed JSON gracefully and falls back to defaults', async () => {
    mockExistsSync.mockImplementation((p: string) => p === USER_CONFIG_PATH)
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === USER_CONFIG_PATH) return 'not valid json{{'
      return ''
    })

    const { loadConfig, clearConfigCache } = await import('../src/main/config'); clearConfigCache()
    const result = loadConfig()

    expect(result.ai_provider).toBe('deepseek')
    expect(result.api_key).toBe('')
  })

  it('returns a fresh object each time (no shared reference)', async () => {
    mockExistsSync.mockReturnValue(false)

    const { loadConfig, clearConfigCache } = await import('../src/main/config'); clearConfigCache()
    const c1 = loadConfig()
    const c2 = loadConfig()

    expect(c1).not.toBe(c2)
    expect(c1).toEqual(c2)
  })
})

// ============================================================
// loadSafeConfig（douyin_cookie 永不下发渲染层）
// ============================================================

describe('loadSafeConfig', () => {
  beforeEach(() => {
    vi.resetModules()
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
    mockGetPath.mockReset()
    mockGetPath.mockReturnValue(USER_DATA_DIR)
  })

  it('douyin_cookie 返回前置空（渲染层永不接触明文 cookie）', async () => {
    mockExistsSync.mockImplementation((p: string) => p === USER_CONFIG_PATH)
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === USER_CONFIG_PATH)
        return JSON.stringify({ douyin_cookie: 'sid_guard=secret; sessionid=secret' })
      return ''
    })

    const { loadSafeConfig, clearConfigCache } = await import('../src/main/config'); clearConfigCache()
    const result = loadSafeConfig()

    expect(result.douyin_cookie).toBe('')
  })

  it('无 cookie 时同样返回空串，其余字段不受影响', async () => {
    mockExistsSync.mockImplementation((p: string) => p === USER_CONFIG_PATH)
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === USER_CONFIG_PATH) return JSON.stringify({ api_key: fakeCred('sk-test') })
      return ''
    })

    const { loadSafeConfig, clearConfigCache } = await import('../src/main/config'); clearConfigCache()
    const result = loadSafeConfig()

    expect(result.douyin_cookie).toBe('')
    expect(result.api_key).toBe('sk-test')
  })
})

// ============================================================
// saveConfig
// ============================================================

describe('saveConfig', () => {
  beforeEach(() => {
    vi.resetModules()
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
    mockGetPath.mockReset()
    mockGetPath.mockReturnValue(USER_DATA_DIR)
  })

  /** Default existsSync: only the user config directory exists, not the portable file */
  function setupDefaultFs() {
    mockExistsSync.mockImplementation((p: string) => {
      // user data directory exists
      if (p === USER_DATA_DIR) return true
      // everything else (including portable marker) does not
      return false
    })
  }

  it('writes config to the correct user data path', async () => {
    setupDefaultFs()

    const { saveConfig } = await import('../src/main/config')
    saveConfig({ api_key: fakeCred('sk-test') } as PodcastConfig)

    expect(mockWriteFileSync).toHaveBeenCalledWith(USER_CONFIG_PATH, expect.any(String), 'utf-8')
  })

  it('creates directory when it does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    const { saveConfig } = await import('../src/main/config')
    saveConfig({ api_key: fakeCred('sk-test') } as PodcastConfig)

    expect(mockMkdirSync).toHaveBeenCalledWith(USER_DATA_DIR, { recursive: true })
  })

  it('does not create directory when it already exists', async () => {
    setupDefaultFs()

    const { saveConfig } = await import('../src/main/config')
    saveConfig({ api_key: fakeCred('sk-test') } as PodcastConfig)

    expect(mockMkdirSync).not.toHaveBeenCalled()
  })

  it('removes legacy _enc fields before saving', async () => {
    setupDefaultFs()

    const { saveConfig } = await import('../src/main/config')
    const config = {
      api_key: fakeCred('sk-test'),
      _api_key_enc: 'encrypted_value',
      _feishu_app_secret_enc: 'encrypted_secret',
    } as unknown as PodcastConfig

    saveConfig(config)

    const saved = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
    expect(saved._api_key_enc).toBeUndefined()
    expect(saved._feishu_app_secret_enc).toBeUndefined()
    expect(saved.api_key).toBe('sk-test')
  })

  it('removes _decryptionFailedFields before saving', async () => {
    setupDefaultFs()

    const { saveConfig } = await import('../src/main/config')
    const config = {
      api_key: fakeCred('sk-test'),
      _decryptionFailedFields: ['api_key'],
    } as unknown as PodcastConfig

    saveConfig(config)

    const saved = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
    expect(saved._decryptionFailedFields).toBeUndefined()
  })

  it('removes _apiKey_enc from ai_providers before saving', async () => {
    setupDefaultFs()

    const { saveConfig } = await import('../src/main/config')
    const config = {
      ai_providers: {
        deepseek: { apiKey: fakeCred('sk-ds'), _apiKey_enc: 'enc1' },
        openai: { apiKey: fakeCred('sk-oa'), _apiKey_enc: 'enc2' },
      },
    } as unknown as PodcastConfig

    saveConfig(config)

    const saved = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
    expect(saved.ai_providers.deepseek._apiKey_enc).toBeUndefined()
    expect(saved.ai_providers.openai._apiKey_enc).toBeUndefined()
    expect(saved.ai_providers.deepseek.apiKey).toBe('sk-ds')
    expect(saved.ai_providers.openai.apiKey).toBe('sk-oa')
  })

  it('writes pretty-printed JSON (2-space indent)', async () => {
    mockExistsSync.mockReturnValue(true)

    const { saveConfig } = await import('../src/main/config')
    saveConfig({ api_key: fakeCred('sk-test') } as PodcastConfig)

    const raw = mockWriteFileSync.mock.calls[0][1] as string
    // Verify valid JSON
    const parsed = JSON.parse(raw)
    expect(parsed.api_key).toBe('sk-test')
    // Verify 2-space indent (stringify with 2 spaces produces a specific format)
    expect(raw).toContain('\n  ')
  })

  it('handles write errors gracefully without throwing', async () => {
    mockExistsSync.mockReturnValue(true)
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('disk full')
    })

    const { saveConfig } = await import('../src/main/config')

    expect(() => saveConfig({ api_key: fakeCred('sk-test') } as PodcastConfig)).not.toThrow()
  })
})
