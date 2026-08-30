import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  FileText,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  AlertCircle,
  User,
  Briefcase,
  Lightbulb,
  Bookmark,
  X,
} from 'lucide-react'
import NoteMarkdown from './NoteMarkdown'
import QAPanel from './QAPanel'
import { useI18n } from '../i18n'

interface NoteFileEntry {
  name: string
  path: string
  relPath: string
  mtime: number
}

interface TabState {
  id: string
  path: string
  name: string
  content: string
  loading: boolean
  error: string
}

/** 按名称生成稳定色相（每个笔记颜色不同，且同名恒同色） */
function tabHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) % 360
  }
  // 避免过暗/过亮区段，映射到 0-360 视觉舒适区间
  return ((h % 360) + 360) % 360
}

interface NoteDirGroup {
  dir: string
  files: NoteFileEntry[]
}

const ENTITY_DIRS = new Set(['人物', '项目', '概念', '术语'])

const DIR_ICONS: Record<string, { icon: typeof User; color: string }> = {
  人物: { icon: User, color: 'var(--accent)' },
  项目: { icon: Briefcase, color: 'var(--success)' },
  概念: { icon: Lightbulb, color: 'var(--warning)' },
  术语: { icon: Bookmark, color: 'var(--text-muted)' },
}

interface PreviewState {
  content: string
  name: string
  left: number
  top: number
}

/**
 * 笔记库面板 — 左侧文件树 + 右侧 Obsidian 式阅读器 + 链接悬停预览
 */
export default function NotesPanel() {
  const { t } = useI18n()
  const [groups, setGroups] = useState<NoteDirGroup[]>([])
  const [rootDir, setRootDir] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // 三栏布局：文件树 / 聊天栏宽度 + 折叠状态
  const [filesWidth, setFilesWidth] = useState(210)
  const [chatWidth, setChatWidth] = useState(300)
  const [filesCollapsed, setFilesCollapsed] = useState(false)
  const [chatCollapsed, setChatCollapsed] = useState(false)

  // 标签页模型（Obsidian 式多标签）
  const [tabs, setTabs] = useState<TabState[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null)
  const tabIdRef = useRef(0)

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null

  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // 标签右键菜单（Obsidian 式批量关闭），坐标为屏幕固定定位
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)
  // 拖动分隔条调整栏宽
  const startDrag = useCallback(
    (e: React.MouseEvent, side: 'files' | 'chat') => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = side === 'files' ? filesWidth : chatWidth
      const onMove = (ev: MouseEvent) => {
        const delta = side === 'files' ? ev.clientX - startX : startX - ev.clientX
        const next = Math.round(startWidth + delta)
        if (side === 'files') {
          setFilesWidth(Math.max(150, Math.min(420, next)))
        } else {
          setChatWidth(Math.max(220, Math.min(520, next)))
        }
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [filesWidth, chatWidth],
  )

  // 记录当前预览对应的链接，浮层打开期间同一链接不重复触发
  const [previewHref, setPreviewHref] = useState('')
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const nameMapRef = useRef<Map<string, string>>(new Map())
  const [typeMap, setTypeMap] = useState<Map<string, string>>(new Map())
  const [knownNames, setKnownNames] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.electronAPI
      .listNotes()
      .then(res => {
        if (res.success) {
          const list = res.groups || []
          setGroups(list)
          // 默认全部折叠，只留分组标题（Obsidian 文件树风格）
          setCollapsed(new Set(list.map(g => g.dir)))
          setRootDir(res.rootDir || null)
          // 构建文件名→绝对路径映射（Obsidian wiki-link 全局解析用）
          // 同名冲突时实体目录（概念/术语/人物/项目）优先，其次播客分类
          const map = new Map<string, string>()
          const typeMap = new Map<string, string>()
          const dirType: Record<string, string> = {
            人物: 'people',
            项目: 'projects',
            概念: 'concepts',
            术语: 'terms',
          }
          const entityDirs = new Set(Object.keys(dirType))
          const addFile = (name: string, path: string, dir: string) => {
            const existing = map.get(name)
            if (!existing) map.set(name, path)
            else if (entityDirs.has(dir) && !entityDirs.has(existing.split('/').slice(-2)[0])) {
              map.set(name, path)
            }
            // 类型映射（实体目录才有类型）
            if (dirType[dir]) typeMap.set(name, dirType[dir])
          }
          for (const g of list) {
            for (const file of g.files) addFile(file.name, file.path, g.dir)
          }
          nameMapRef.current = map
          setTypeMap(typeMap)
          setKnownNames(new Set(map.keys()))
        } else {
          setError(res.error || t('加载失败'))
        }
      })
      .catch(e => setError((e as Error).message || t('加载失败')))
      .finally(() => setLoading(false))
  }, [t])

  // 打开笔记：已存在标签则激活，否则新开标签
  const openNote = useCallback(
    (path: string, name: string) => {
      setPreview(null)
      const existing = tabs.find(t => t.path === path)
      if (existing) {
        setActiveTabId(existing.id)
        setActiveTabPath(existing.path)
        return
      }
      const id = `tab-${++tabIdRef.current}`
      const tab: TabState = { id, path, name, content: '', loading: true, error: '' }
      setTabs(prev => [...prev, tab])
      setActiveTabId(id)
      setActiveTabPath(path)
      window.electronAPI
        .readNote(path)
        .then(res => {
          if (res.success && res.content) {
            setTabs(prev =>
              prev.map(t => (t.id === id ? { ...t, content: res.content!, loading: false } : t)),
            )
          } else {
            setTabs(prev =>
              prev.map(t =>
                t.id === id ? { ...t, error: res.error || t.name, loading: false } : t,
              ),
            )
          }
        })
        .catch(e => {
          setTabs(prev =>
            prev.map(t =>
              t.id === id ? { ...t, error: (e as Error).message, loading: false } : t,
            ),
          )
        })
    },
    [tabs],
  )

  // 关闭标签（普通函数，避免 memoization 规则冲突）
  function closeTab(id: string) {
    const idx = tabs.findIndex(t => t.id === id)
    const next = tabs.filter(t => t.id !== id)
    setTabs(next)
    if (activeTabId === id) {
      const newActive = next[Math.min(idx, next.length - 1)] ?? null
      setActiveTabId(newActive?.id ?? null)
      setPreview(null)
    }
  }

  // 批量关闭（右键菜单：关闭其他/左侧/右侧/全部）。
  // 激活标签被关时，落到锚点（菜单所在标签）位置的邻近标签，模拟 Obsidian 的焦点走向
  function closeTabs(ids: string[], anchorId: string) {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const anchorIdx = tabs.findIndex(tb => tb.id === anchorId)
    const next = tabs.filter(tb => !idSet.has(tb.id))
    setTabs(next)
    if (activeTabId && idSet.has(activeTabId)) {
      const fallback = next[Math.min(Math.max(anchorIdx, 0), next.length - 1)] ?? null
      setActiveTabId(fallback?.id ?? null)
      setPreview(null)
    }
  }

  // 右键菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!tabMenu) return
    const onDown = (e: MouseEvent) => {
      if (tabMenuRef.current && !tabMenuRef.current.contains(e.target as Node)) setTabMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [tabMenu])

  // 解析链接 href → 候选绝对路径列表（相对当前笔记 + 库根全局，Obsidian 语义）
  const resolveHrefs = useCallback(
    (href: string): string[] => {
      if (!rootDir) return []
      // marked 会把中文路径 URL 编码（../项目/xxx.md → ../%E9%A1%B9...），需先解码
      let decoded = href
      try {
        decoded = decodeURIComponent(href)
      } catch {
        /* 解码失败用原始值 */
      }
      if (decoded.startsWith('file://')) return [decoded.slice(7).replace(/\\/g, '/')]
      if (decoded.startsWith('/') || /^[a-zA-Z]:/.test(decoded)) {
        return [decoded.replace(/\\/g, '/')]
      }

      const root = rootDir.replace(/\\/g, '/')
      const candidates: string[] = []
      const seen = new Set<string>()

      const normalize = (input: string): string => {
        const parts = input.split('/')
        const stack: string[] = []
        for (const p of parts) {
          if (p === '..') stack.pop()
          else if (p === '.' || p === '') continue
          else stack.push(p)
        }
        return stack.join('/')
      }

      // 1) 相对当前笔记目录
      if (activeTabPath) {
        const normPath = activeTabPath.replace(/\\/g, '/')
        const base = normPath.substring(0, normPath.lastIndexOf('/') + 1)
        const abs = normalize(base + decoded)
        if (abs.startsWith(root) && abs.length > root.length && !seen.has(abs)) {
          candidates.push(abs)
          seen.add(abs)
        }
      }

      // 2) 从库根解析（处理作者漏写 ../ 的情况）
      const rootAbs = normalize(root + '/' + decoded)
      if (!seen.has(rootAbs)) {
        candidates.push(rootAbs)
        seen.add(rootAbs)
      }

      // 3) 去掉首段 .. 后从库根解析（../项目/x.md → 项目/x.md）
      const stripped = decoded.replace(/^(?:\.\.\/)+/, '')
      if (stripped !== decoded) {
        const strippedAbs = normalize(root + '/' + stripped)
        if (!seen.has(strippedAbs)) {
          candidates.push(strippedAbs)
          seen.add(strippedAbs)
        }
      }

      // 4) wiki: 协议 — 全局文件名查找（Obsidian wiki-link 语义：[[牛津大学]] → 概念/牛津大学.md）
      if (decoded.startsWith('wiki:')) {
        const wikiName = decoded.slice(5).trim()
        const byName = nameMapRef.current.get(wikiName)
        if (byName && !seen.has(byName)) {
          candidates.push(byName.replace(/\\/g, '/'))
        }
        return candidates
      }

      // 5) 兜底：按文件名全局查找（相对链接指向不存在的路径时）
      const basename = decoded.split('/').pop()?.replace(/\.md$/i, '') || ''
      if (basename) {
        const byName = nameMapRef.current.get(basename)
        if (byName && !seen.has(byName)) {
          candidates.push(byName.replace(/\\/g, '/'))
        }
      }

      return candidates
    },
    [rootDir, activeTabPath],
  )

  // 从候选列表中读取第一个存在的笔记
  const readFirstExisting = useCallback(
    (
      candidates: string[],
    ): Promise<{
      success: boolean
      content?: string
      filename?: string
      path?: string
      error?: string
    }> => {
      let index = 0
      const tryNext = (): Promise<{
        success: boolean
        content?: string
        filename?: string
        path?: string
        error?: string
      }> => {
        if (index >= candidates.length) {
          return Promise.resolve({ success: false, error: '笔记不存在' })
        }
        const abs = candidates[index]
        index++
        return window.electronAPI.readNote(abs).then(res => {
          if (res.success) return res
          return tryNext()
        })
      }
      return tryNext()
    },
    [],
  )

  const loadPreview = useCallback(
    (href: string, anchor: DOMRect) => {
      setPreviewHref(href)
      // 用 portal 渲染到 body，位置基于 viewport 坐标
      // 优先显示在链接下方；下方空间不足时显示在链接上方（绝不覆盖链接本身，避免闪烁）
      const POP_H = 300
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 348))
      const below = anchor.bottom + 8
      const top = below + POP_H <= window.innerHeight ? below : Math.max(8, anchor.top - POP_H - 8)
      setPreviewLoading(true)
      setPreview({ content: '', name: '', left, top })
      readFirstExisting(resolveHrefs(href))
        .then(res => {
          setPreviewLoading(false)
          if (res.success && res.content) {
            setPreview({
              content: res.content,
              name: res.filename?.replace(/\.md$/i, '') || '',
              left,
              top,
            })
          } else {
            setPreview({ content: '', name: '', left, top })
          }
        })
        .catch(() => {
          setPreviewLoading(false)
          setPreview({ content: '', name: '', left, top })
        })
    },
    [readFirstExisting, resolveHrefs],
  )

  const handleLinkHover = useCallback(
    (href: string, el: HTMLElement) => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
      if (resolveHrefs(href).length === 0) return
      // 同一链接的浮层已显示时不再重复加载（防止闪烁循环）
      if (previewHref === href) return
      hoverTimerRef.current = setTimeout(() => {
        loadPreview(href, el.getBoundingClientRect())
      }, 300)
    },
    [resolveHrefs, loadPreview, previewHref],
  )

  const clearPreview = useCallback(() => {
    setPreviewHref('')
    setPreview(null)
  }, [])

  const handleLinkLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    // 给鼠标从链接移入浮层留出时间；到期用 clearPreview 同时重置 previewHref，
    // 否则同一链接第二次悬浮会被 previewHref 短路、浮层不再出现
    leaveTimerRef.current = setTimeout(() => clearPreview(), 420)
  }, [clearPreview])

  const handleLinkClick = useCallback(
    (href: string) => {
      readFirstExisting(resolveHrefs(href)).then(res => {
        if (res.success && res.content && res.path) {
          const name = res.filename?.replace(/\.md$/i, '') || ''
          // 当前标签内跳转（Obsidian 普通点击行为）
          setTabs(prev =>
            prev.map(t =>
              t.id === activeTabId
                ? { ...t, path: res.path!, name, content: res.content!, loading: false, error: '' }
                : t,
            ),
          )
          setActiveTabPath(res.path!)
          clearPreview()
        }
      })
    },
    [readFirstExisting, resolveHrefs, activeTabId, clearPreview],
  )

  const toggleGroup = (dir: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }

  if (loading) {
    return (
      <div className="notes-panel notes-panel--status">
        <Loader2 size={18} className="note-preview__spin" />
        {t('加载中...')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="notes-panel notes-panel--status notes-panel--error">
        <AlertCircle size={18} />
        {error}
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="notes-panel notes-panel--status">
        <FileText size={20} />
        {t('暂无笔记，先处理一个播客试试')}
      </div>
    )
  }

  return (
    <div className="notes-panel" ref={panelRef}>
      {/* 左侧文件树（可折叠 + 可拖宽） */}
      {filesCollapsed ? (
        <button
          className="notes-panel__files-collapsed"
          onClick={() => setFilesCollapsed(false)}
          title={t('展开文件树')}
        >
          <ChevronsRight size={13} />
        </button>
      ) : (
        <div className="notes-panel__files" style={{ width: filesWidth }}>
          <div className="notes-panel__files-title">
            <FolderOpen size={13} />
            <span className="notes-panel__files-title-text">{t('笔记库')}</span>
            <button
              className="notes-panel__collapse-btn"
              onClick={() => setFilesCollapsed(true)}
              title={t('收起文件树')}
            >
              <ChevronsLeft size={12} />
            </button>
          </div>
          <div className="notes-panel__files-scroll">
            {groups.map(group => {
              const isCollapsed = collapsed.has(group.dir)
              const isEntity = ENTITY_DIRS.has(group.dir)
              const dirMeta = DIR_ICONS[group.dir]
              const DirIcon = dirMeta?.icon || FolderOpen
              return (
                <div key={group.dir} className="notes-panel__group">
                  <button className="notes-panel__group-btn" onClick={() => toggleGroup(group.dir)}>
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <DirIcon size={13} style={{ color: dirMeta?.color || 'var(--text-muted)' }} />
                    <span className="notes-panel__group-name">{group.dir}</span>
                    <span className="notes-panel__group-count">{group.files.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="notes-panel__group-files">
                      {group.files.map(file => (
                        <button
                          key={file.path}
                          className={`notes-panel__file ${activeTab?.path === file.path ? 'is-active' : ''}`}
                          onClick={() => openNote(file.path, file.name)}
                          title={file.relPath}
                        >
                          <span className="notes-panel__file-indent" />
                          <FileText
                            size={11}
                            className={isEntity ? 'notes-panel__file-entity' : ''}
                          />
                          <span className="notes-panel__file-name">{file.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 文件树分隔条（拖动调宽） */}
      <div
        className="notes-panel__resizer"
        onMouseDown={e => startDrag(e, 'files')}
        title={t('拖动调整宽度')}
      />

      {/* 中间阅读器（标签页） */}
      <div className="notes-panel__reader">
        {tabs.length > 0 ? (
          <>
            <div className="notes-panel__tabbar">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  className={`notes-panel__tab ${tab.id === activeTabId ? 'is-active' : ''}`}
                  style={{ ['--tab-hue' as string]: String(tabHue(tab.name)) }}
                  onClick={() => {
                    setActiveTabId(tab.id)
                    setActiveTabPath(tab.path)
                  }}
                  onContextMenu={e => {
                    e.preventDefault()
                    // 视口内夹紧，避免菜单贴边溢出
                    setTabMenu({
                      x: Math.min(e.clientX, window.innerWidth - 190),
                      y: Math.min(e.clientY, window.innerHeight - 200),
                      tabId: tab.id,
                    })
                  }}
                  title={tab.name}
                >
                  <span className="notes-panel__tab-dot" />
                  <span className="notes-panel__tab-name">{tab.name}</span>
                  <span
                    className="notes-panel__tab-close"
                    onClick={e => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                    title={t('关闭标签')}
                  >
                    <X size={11} />
                  </span>
                </button>
              ))}
            </div>
            <div className="notes-panel__reader-body">
              {activeTab ? (
                activeTab.loading ? (
                  <div className="notes-panel--status">
                    <Loader2 size={18} className="note-preview__spin" />
                    {t('加载中...')}
                  </div>
                ) : activeTab.error ? (
                  <div className="notes-panel--status notes-panel--error">{activeTab.error}</div>
                ) : (
                  <NoteMarkdown
                    content={activeTab.content}
                    onLinkHover={handleLinkHover}
                    onLinkLeave={handleLinkLeave}
                    onLinkClick={handleLinkClick}
                    linkTypeMap={typeMap}
                    knownNames={knownNames.size > 0 ? knownNames : undefined}
                  />
                )
              ) : null}
            </div>
          </>
        ) : (
          <div className="notes-panel--status notes-panel--empty">
            <FileText size={22} />
            <div>{t('从左侧选择一篇笔记开始阅读')}</div>
          </div>
        )}
      </div>

      {/* 聊天栏分隔条（拖动调宽） */}
      <div
        className="notes-panel__resizer"
        onMouseDown={e => startDrag(e, 'chat')}
        title={t('拖动调整宽度')}
      />

      {/* 右侧聊天侧边栏（可折叠 + 可拖宽） */}
      {chatCollapsed ? (
        <button
          className="notes-panel__chat-collapsed"
          onClick={() => setChatCollapsed(false)}
          title={t('展开聊天')}
        >
          <ChevronsLeft size={13} />
        </button>
      ) : (
        <div className="notes-panel__chat" style={{ width: chatWidth }}>
          <div className="notes-panel__chat-header">
            <span>{t('问答')}</span>
            <button
              className="notes-panel__collapse-btn"
              onClick={() => setChatCollapsed(true)}
              title={t('收起聊天')}
            >
              <ChevronsRight size={12} />
            </button>
          </div>
          <QAPanel
            onOpenSource={source => {
              openNote(source.path, source.title)
            }}
          />
        </div>
      )}

      {/* 悬停预览 — portal 到 body，避免被 transform/motion 容器影响定位 */}
      {preview &&
        createPortal(
          <div
            className="notes-preview-pop"
            style={{ left: preview.left, top: preview.top }}
            onMouseEnter={() => {
              if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
            }}
            onMouseLeave={() => {
              // 只有移出浮层边缘才关闭；250ms 宽限避免在边缘附近轻微移动导致误关
              if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
              leaveTimerRef.current = setTimeout(() => clearPreview(), 250)
            }}
          >
            <div className="notes-preview-pop__head">
              <span className="notes-preview-pop__title">{preview.name || t('加载中...')}</span>
              <button className="notes-preview-pop__close" onClick={() => clearPreview()}>
                <X size={12} />
              </button>
            </div>
            {previewLoading ? (
              <div className="notes-preview-pop__loading">
                <Loader2 size={14} className="note-preview__spin" />
              </div>
            ) : preview.name ? (
              <NoteMarkdown
                content={preview.content}
                className="notes-preview-pop__body"
                onLinkClick={href => {
                  handleLinkClick(href)
                  clearPreview()
                }}
              />
            ) : (
              <div className="notes-preview-pop__empty">{t('笔记不存在')}</div>
            )}
          </div>,
          document.body,
        )}

      {/* 标签右键菜单 — Obsidian 式批量关闭 */}
      {tabMenu &&
        createPortal(
          <div
            ref={tabMenuRef}
            className="notes-tab-menu"
            style={{ top: tabMenu.y, left: tabMenu.x }}
          >
            <button
              className="notes-tab-menu__item"
              onClick={() => {
                closeTab(tabMenu.tabId)
                setTabMenu(null)
              }}
            >
              {t('关闭标签')}
            </button>
            <button
              className="notes-tab-menu__item"
              onClick={() => {
                closeTabs(
                  tabs.filter(tb => tb.id !== tabMenu.tabId).map(tb => tb.id),
                  tabMenu.tabId,
                )
                setTabMenu(null)
              }}
            >
              {t('关闭其他标签')}
            </button>
            <button
              className="notes-tab-menu__item"
              onClick={() => {
                const i = tabs.findIndex(tb => tb.id === tabMenu.tabId)
                closeTabs(tabs.slice(0, Math.max(i, 0)).map(tb => tb.id), tabMenu.tabId)
                setTabMenu(null)
              }}
            >
              {t('关闭左侧标签')}
            </button>
            <button
              className="notes-tab-menu__item"
              onClick={() => {
                const i = tabs.findIndex(tb => tb.id === tabMenu.tabId)
                closeTabs(tabs.slice(i + 1).map(tb => tb.id), tabMenu.tabId)
                setTabMenu(null)
              }}
            >
              {t('关闭右侧标签')}
            </button>
            <div className="notes-tab-menu__sep" />
            <button
              className="notes-tab-menu__item notes-tab-menu__item--danger"
              onClick={() => {
                closeTabs(tabs.map(tb => tb.id), tabMenu.tabId)
                setTabMenu(null)
              }}
            >
              {t('关闭全部标签')}
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}
