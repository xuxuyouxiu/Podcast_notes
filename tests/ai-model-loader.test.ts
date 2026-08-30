/**
 * 模型加载编排纯函数测试（loadAIModels）。
 * 依赖注入的 fetchModels 即 mock IPC 边界：测试连接成功后的自动加载、
 * 空列表/主进程错误与 IPC 抛异常三种走向（docs/无感配置方案.md「验证即前进」）。
 */
import { describe, it, expect, vi } from 'vitest'
import { loadAIModels } from '../src/renderer/data/ai-model-loader'
import { fakeCred } from './fake-cred'

describe('loadAIModels', () => {
  const models = [
    { id: 'm1', name: 'M1' },
    { id: 'm2', name: 'M2' },
  ]

  it('成功且当前未选模型 → ok、返回列表并建议选中第一个（自动加载主路径）', async () => {
    const fetchModels = vi.fn(async () => ({ success: true, models }))
    const out = await loadAIModels({
      fetchModels,
      baseUrl: 'https://api.example.com/v1',
      apiKey: fakeCred('sk-test'),
      currentModel: '',
    })
    expect(out.ok).toBe(true)
    expect(out.models).toEqual(models)
    expect(out.autoSelectId).toBe('m1')
    expect(out.error).toBeUndefined()
    expect(out.thrownError).toBeUndefined()
    expect(fetchModels).toHaveBeenCalledWith('https://api.example.com/v1', 'sk-test')
  })

  it('成功且已选模型 → 不覆盖用户选择', async () => {
    const fetchModels = vi.fn(async () => ({ success: true, models }))
    const out = await loadAIModels({
      fetchModels,
      baseUrl: 'u',
      apiKey: fakeCred('k'),
      currentModel: 'm9',
    })
    expect(out.ok).toBe(true)
    expect(out.autoSelectId).toBeUndefined()
  })

  it('success:false 或空列表 → ok=false 携带主进程错误文案', async () => {
    const out1 = await loadAIModels({
      fetchModels: async () => ({ success: false, models: [], error: 'API Key 无效' }),
      baseUrl: 'u',
      apiKey: fakeCred('k'),
    })
    expect(out1.ok).toBe(false)
    expect(out1.error).toBe('API Key 无效')
    expect(out1.models).toEqual([])

    const out2 = await loadAIModels({
      fetchModels: async () => ({ success: true, models: [] }),
      baseUrl: 'u',
      apiKey: fakeCred('k'),
    })
    expect(out2.ok).toBe(false)
    expect(out2.error).toBeUndefined()
    expect(out2.models).toEqual([])
  })

  it('IPC 抛异常 → ok=false 携带 thrownError 消息', async () => {
    const out = await loadAIModels({
      fetchModels: async () => {
        throw new Error('net down')
      },
      baseUrl: 'u',
      apiKey: fakeCred('k'),
    })
    expect(out.ok).toBe(false)
    expect(out.thrownError).toBe('net down')
    expect(out.models).toEqual([])
  })
})
