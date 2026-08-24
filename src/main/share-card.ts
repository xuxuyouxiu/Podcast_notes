/**
 * 分享卡片生成 — 笔记一键生成 1080×1440 分享图
 * 隐藏 BrowserWindow 渲染 HTML 模板 → capturePage 截图 → 保存对话框 → 写文件
 */

import { BrowserWindow, dialog, app } from 'electron'
import { join } from 'node:path'
import * as fs from 'fs'
import { loadConfig } from './config'
import { isPathWithinBase } from './security'
import { analyzeForShareCard } from './ai-client'
import { getActiveProviderConfig } from './ai-providers'

interface ShareParams {
  notePath: string
  title: string
  podcastName?: string
  platform?: string
}

export interface ShareResult {
  success: boolean
  path?: string
  cancelled?: boolean
  error?: string
  /** AI 未生效时的提示（展示给用户） */
  warning?: string
}

/** 从 markdown 提取要点（按信息密度排序：关键数据 → 金句 → 动态列表兜底），最多 3 条 */
function extractPoints(md: string): string[] {
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  const seen = new Set<string>()
  const clean = (text: string) =>
    text
      .replace(/^\*\*|^\s*[-*]\s+|\*\*$/g, '')
      .replace(/\*\*/g, '')
      .replace(/^#+\s*/, '')
      .replace(/^(关键数据|事件概要|影响分析|核心观点)[:：]\s*/, '')
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^>+\s*/, '')
      .replace(/\s*——\s*.+$/, '')
      .trim()
  const push = (text: string) => {
    const c = clean(text)
    // 关键数据允许更长（模板 2 行截断），普通要点 90 字
    const isData = /^(关键数据)[:：]/.test(text)
    if (!c || c.length < 8 || (isData ? c.length > 120 : c.length > 90) || seen.has(c)) return
    seen.add(c)
    out.push(c)
  }

  // ① 关键数据（信息密度最高）：优先「深度解读」章节内（主题相关），再全文
  const sectionOf = (line: string): string => {
    for (let i = lines.indexOf(line); i >= 0; i--) {
      const t = lines[i].trim()
      if (t.startsWith('## ')) return t
    }
    return ''
  }
  const dataLines = lines.filter(l => /^\*\*关键数据\*\*|^关键数据[:：]/.test(l.trim()))
  const themed = dataLines.filter(l => /深度解读|押注|机会/.test(sectionOf(l)))
  const orderedData = [...themed, ...dataLines.filter(l => !themed.includes(l))]
  for (const line of orderedData) {
    if (out.length >= 3) break
    push(line)
  }
  // ② 金句摘录（传播力最强）
  for (const line of lines) {
    if (out.length >= 3) break
    if (/^>\s*["“]/.test(line.trim())) push(line)
  }
  // ③ 深度解读/事件概要 的第一句
  if (out.length < 3) {
    for (const line of lines) {
      if (out.length >= 3) break
      const t = line.trim()
      if (/^##\s*深度解读/.test(t)) {
        const next = lines[lines.indexOf(line) + 1]
        if (next) push(next)
        break
      }
    }
  }
  // ④ 动态列表兜底（- 项，优先含「深度解读」主题的最长项）
  if (out.length < 3) {
    const items = lines
      .map(l => l.trim())
      .filter(l => /^-\s+/.test(l))
      .sort((a, b) => b.length - a.length)
    for (const item of items) {
      if (out.length >= 3) break
      push(item)
    }
  }
  // ⑤ 正文段落兜底
  if (out.length === 0) {
    for (const line of lines) {
      if (out.length >= 3) break
      const t = line.trim()
      if (!t || t.startsWith('#') || t.startsWith('>') || t.startsWith('|') || t.startsWith('```')) continue
      push(t)
    }
  }
  return out
}

/** 从 frontmatter 提取日期（优先），无则当天 */
function extractDate(md: string): string {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const dateLine = fm[1].split(/\r?\n/).find(l => /^date[:：]/.test(l.trim()))
    if (dateLine) {
      const d = dateLine.replace(/^date[:：]\s*/, '').trim()
      if (d) {
        try {
          const [y, mo, day] = d.split('-').map(Number)
          if (y && mo && day) {
            return `${y} 年 ${mo} 月 ${day} 日`
          }
          return d
        } catch {
          return d
        }
      }
    }
  }
  return new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function sanitizeFilename(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40)
  return clean || '分享'
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function renderAndCapture(query: Record<string, string>): Promise<Buffer> {
  const win = new BrowserWindow({
    width: 1080,
    height: 1440,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  })
  try {
    const htmlPath = join(__dirname, '..', '..', 'dist', 'share-card.html')
    await win.loadFile(htmlPath, { query })
    // 等待字体渲染完成（模板底部有 ready 标记）
    for (let i = 0; i < 30; i++) {
      const ready = await win.webContents.executeJavaScript('document.body.dataset.ready === "1"')
      if (ready) break
      await sleep(100)
    }
    await sleep(300)

    // 高度随内容自适应：测量内容自然高度，调整窗口后重截
    try {
      const contentHeight = (await win.webContents.executeJavaScript(
        'document.body.scrollHeight',
      )) as number
      const h = Math.max(1080, Math.min(2560, Math.ceil(contentHeight)))
      if (h !== 1440) {
        win.setContentSize(1080, h)
        await sleep(350)
      }
    } catch {
      // 测量失败保持默认尺寸
    }

    const image = await win.webContents.capturePage()
    return image.toPNG()
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export async function generateShareCard(params: ShareParams): Promise<ShareResult> {
  try {
    // 路径安全校验（同 notes:read）
    const config = loadConfig()
    const allowedDirs = [config.obsidian_dir, app.getPath('userData')].filter(Boolean)
    if (!isPathWithinBase(params.notePath, allowedDirs)) {
      return { success: false, error: '路径不在允许范围内' }
    }
    if (!fs.existsSync(params.notePath)) {
      return { success: false, error: '笔记文件不存在' }
    }
    const md = fs.readFileSync(params.notePath, 'utf-8')
    if (!md.trim()) {
      return { success: false, error: '笔记读取失败：文件不存在或为空' }
    }

    const title = params.title || extractTitle(md)

    // AI 内容编辑：类型判断 + 传播标题 + 摘要 + 知识点 + 金句（失败回退规则提取）
    let aiWarning = ''
    let content:
      | {
          cardType: 'summary' | 'quote' | 'steps' | 'compare' | 'framework' | 'poster'
          shareTitle: string
          summary: string
          points: { title: string; desc: string }[]
          quote: string
          steps: string[]
          compare?: {
            leftTitle: string
            rightTitle: string
            leftItems: string[]
            rightItems: string[]
          }
        }
      | null = null
    try {
      const config = loadConfig()
      const aiCfg = getActiveProviderConfig(config.ai_provider, config.ai_providers)
      if (aiCfg) {
        content = await analyzeForShareCard(aiCfg, config.ai_provider, md, title)
      } else {
        aiWarning = '未配置 AI 模型，分享图使用原文要点'
      }
    } catch (e) {
      aiWarning =
        'AI 内容编辑失败，已回退原文要点：' + (e instanceof Error ? e.message : String(e))
      console.log('[share-card] AI 内容编辑失败，回退规则提取:', aiWarning)
    }
    if (content && !content.shareTitle) {
      aiWarning = 'AI 未生成传播标题，已使用原笔记标题'
    }

    // 规则回退：传播标题用原标题，知识点用原文提取
    const shareTitle = content?.shareTitle || title
    const summary = content?.summary || ''
    const points =
      content?.points.length
        ? content.points
        : extractPoints(md).map(text => ({ title: '', desc: text }))
    const quote = content?.quote || ''
    const steps = content?.steps || []
    const template = content?.cardType || 'summary'

    const png = await renderAndCapture({
      template: encodeURIComponent(template),
      title: encodeURIComponent(shareTitle),
      summary: encodeURIComponent(summary),
      quote: encodeURIComponent(quote),
      points: encodeURIComponent(JSON.stringify(points)),
      steps: encodeURIComponent(JSON.stringify(steps)),
      compare: encodeURIComponent(JSON.stringify(content?.compare || {})),
      source: encodeURIComponent(params.podcastName || ''),
      date: encodeURIComponent(extractDate(md)),
    })

    const defaultName = `PodMuse-分享-${sanitizeFilename(title)}-${todayStr()}.png`
    const defaultDir = app.getPath('desktop')
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存分享图',
      defaultPath: join(defaultDir, defaultName),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    })
    if (canceled || !filePath) {
      return { success: true, cancelled: true }
    }

    fs.writeFileSync(filePath, png)
    return { success: true, path: filePath, warning: aiWarning || undefined }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function extractTitle(md: string): string {
  const first = md
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.startsWith('#'))
  if (first) return first.replace(/^#+\s*/, '').trim()
  return '本期节目'
}
