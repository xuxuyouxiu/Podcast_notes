import { useMemo, useRef, useEffect } from 'react'
import { marked } from 'marked'

/** 简单清理：移除 script 标签等危险内容 */
export function sanitizeHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '')
}

/** 剥离 YAML frontmatter */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md
  const fmEnd = md.indexOf('\n---', 3)
  return fmEnd > 0 ? md.substring(fmEnd + 4) : md
}

/**
 * 将 Obsidian wiki-link 转换为标准 Markdown 链接
 * - [[名称]]       → [名称](wiki:名称)
 * - [[名称|别名]]  → [别名](wiki:名称)
 * 使用 wiki: 协议前缀，由 NotesPanel 做全局文件名查找（Obsidian 全局解析语义）
 */
export function convertWikiLinksToMd(md: string): string {
  return md.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, name: string, alias?: string) => {
    const target = (name || '').trim()
    const label = (alias || name || '').trim()
    if (!target) return _m
    // encodeURIComponent 处理带空格的英文名（Michael Woldridge），否则 marked 不渲染为链接
    return `[${label}](wiki:${encodeURIComponent(target)})`
  })
}

/** 链接类型颜色（与知识关联面板 TYPE_META 对应，统一走 --entity-* token） */
export const LINK_TYPE_COLORS: Record<string, string> = {
  people: 'var(--entity-people)', // 人物-紫
  projects: 'var(--entity-projects)', // 项目-绿
  concepts: 'var(--entity-concepts)', // 概念-黄
  terms: 'var(--entity-terms)', // 术语-灰
}

interface Props {
  content: string
  className?: string
  /** 链接 hover 事件（href 为 .md 文件绝对路径或相对路径） */
  onLinkHover?: (href: string, el: HTMLElement) => void
  onLinkLeave?: () => void
  onLinkClick?: (href: string) => void
  /** 文件名（不含 .md）→ 实体类型映射，用于链接着色 */
  linkTypeMap?: Map<string, string>
  /** 已知卡片文件名集合（不含 .md）；wiki: 链接指向不存在的卡片时显示为纯文本 */
  knownNames?: Set<string>
}

/**
 * Markdown 渲染组件 — Obsidian 风格外观
 * 渲染后的链接通过事件冒泡交给父组件处理悬停预览/跳转
 */
export default function NoteMarkdown({
  content,
  className,
  onLinkHover,
  onLinkLeave,
  onLinkClick,
  linkTypeMap,
  knownNames,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  const html = useMemo(() => {
    try {
      return sanitizeHtml(
        marked.parse(convertWikiLinksToMd(stripFrontmatter(content)), { breaks: true }) as string,
      )
    } catch {
      return `<pre>${content.replace(/</g, '&lt;')}</pre>`
    }
  }, [content])

  // 渲染完成后为所有内部链接绑定事件
  useEffect(() => {
    const root = ref.current
    if (!root) return

    const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]')
    const onEnter = (e: MouseEvent) => {
      const a = e.currentTarget as HTMLAnchorElement
      const href = a.getAttribute('href') || ''
      if (href.startsWith('http')) return // 外部链接不预览
      onLinkHover?.(href, a)
    }
    const onLeave = () => onLinkLeave?.()
    const onClick = (e: MouseEvent) => {
      const a = e.currentTarget as HTMLAnchorElement
      const href = a.getAttribute('href') || ''
      if (/^https?:\/\//i.test(href)) {
        // 外部链接：不 preventDefault 会让主窗口整页导航到网页（无边框窗口直接被顶掉，回不来），
        // 必须阻止默认行为并转交用户默认浏览器
        e.preventDefault()
        e.stopPropagation()
        void window.electronAPI.openExternal(href)
        return
      }
      e.preventDefault()
      onLinkClick?.(href)
    }

    // 按实体类型着色（人物紫/概念黄/项目绿/术语灰）
    if (linkTypeMap || knownNames) {
      anchors.forEach(a => {
        let href = a.getAttribute('href') || ''
        try {
          href = decodeURIComponent(href)
        } catch {
          /* keep raw */
        }
        const isWiki = href.startsWith('wiki:')
        // wiki: 协议（旧笔记 [[名称]] 转换而来）→ 提取名称
        if (isWiki) href = href.slice(5)
        const name = href.split('/').pop()?.replace(/\.md$/i, '') || ''

        // wiki: 链接指向的卡片不存在（如被过滤的主持人）→ 降级为纯文本
        if (isWiki && knownNames && name && !knownNames.has(name)) {
          const span = document.createElement('span')
          span.textContent = a.textContent || name
          a.replaceWith(span)
          return
        }

        const type = linkTypeMap?.get(name)
        if (type && LINK_TYPE_COLORS[type]) {
          a.style.color = LINK_TYPE_COLORS[type]
        }
      })
    }

    anchors.forEach(a => {
      a.addEventListener('mouseenter', onEnter)
      a.addEventListener('mouseleave', onLeave)
      a.addEventListener('click', onClick)
    })
    return () => {
      anchors.forEach(a => {
        a.removeEventListener('mouseenter', onEnter)
        a.removeEventListener('mouseleave', onLeave)
        a.removeEventListener('click', onClick)
      })
    }
  }, [html, onLinkHover, onLinkLeave, onLinkClick, linkTypeMap, knownNames])

  return (
    <div
      ref={ref}
      className={`markdown-body ${className || ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
