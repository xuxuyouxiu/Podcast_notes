import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, clipboard, shell } from 'electron'
import { join, basename, extname } from 'path'
import { loadConfig, saveConfig, saveState, loadState, maskSecret } from './config'
import { isSafeUrl } from './security'
import { registerCoreIPC } from './ipc'
import { FeishuMonitor } from './feishu'
import { processPodcast } from './podcast'
import { getActiveProviderConfig, normalizeBaseUrl } from './ai-providers'
import { testAIConnection } from './ai-test'
import { fetchPodcastTitle } from './podcast'
import { platformRegistry } from './platforms'
import { scanLocalModels, checkHardware, autoDetectExePath } from './whisper-model-manager'
import {
  startWhisperDownload,
  cancelWhisperDownload,
  getWhisperDownloadState,
  onWhisperDownloadState,
} from './whisper-downloader'
import { setPromptDir, exportBuiltInTemplates } from './ai-client'
import * as fs from 'fs'
import {
  completeRecentTask,
  failRecentTask,
  startRecentTask,
  stopRecentTask,
} from './recent-task-state'
import {
  runStartupRecovery,
  startConsistencyChecker,
  stopConsistencyChecker,
  runConsistencyCheck,
} from './task-recovery'
import { sendNotification, setupNotificationAppId } from './notify'
import { BatchQueueService } from './batch-queue'
import { registerBatchIPC } from './ipc/batch-ipc'
import { registerSubscriptionIPC } from './ipc/subscription-ipc'
import { registerHistoryIPC } from './ipc/history-ipc'
import { registerShareIpc } from './ipc/share-ipc'
import { registerExportDocsIpc } from './ipc/export-docs-ipc'
import { createSubscriptionService, SubscriptionService } from './subscription-service'
import { setupUpdater, type UpdaterHandle } from './updater'
import {
  startClipboardWatcher,
  stopClipboardWatcher,
  registerProtocol,
  handleProtocolUrl,
  processUrl,
} from './clipboard-watcher'
import { startClipServer, stopClipServer } from './clip-server'
import { closeToastWindow } from './clipboard-watcher'
import { processedEpisodeIds, addProcessedId } from './dedup-store'
import { connectDouyin, getDouyinStatus, disconnectDouyin, refreshDouyinStatus } from './douyin-auth'
import {
  startNotionAuth,
  handleNotionOAuthCallback,
  parseNotionCallback,
  getNotionStatus,
  listNotionDatabases,
  setNotionDatabase,
  disconnectNotion,
} from './oauth/notion-oauth'
import { listNotionDatabases as listManualNotionDatabases } from './notion-databases'
import {
  startFeishuAuth,
  getFeishuStatus,
  listFeishuChats,
  setFeishuChat,
  disconnectFeishu,
} from './oauth/feishu-oauth'
import type { StepInfo, FeishuStatus, AIProviderId } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let monitor: FeishuMonitor | null = null
let pendingAbort: AbortController | null = null
let pendingProcessDone: (() => void) | null = null
let tray: Tray | null = null
let isQuitting = false
let batchQueueService: BatchQueueService | null = null
let subscriptionService: SubscriptionService | null = null
let updaterHandle: UpdaterHandle | null = null

// 单实例锁：防止重复打开，第二次启动时聚焦已有窗口
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 已有实例运行：立即退出。app.quit() 是异步的，必须同步阻止后续初始化
  // （否则 whenReady 仍会触发 startClipServer 等初始化 → 端口冲突崩溃）
  app.exit(0)
}

// 全局导航防护：任何 webContents（主窗口/登录窗/子弹窗/iframe）尝试打开
// 非 http(s) 协议（bytedance:// 等）一律拦截，避免 Windows 反复弹
// 「需要使用新应用以打开此链接」系统框（根因见 v1.50.3~1.50.5 修复记录）。
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (!/^https?:\/\//i.test(url)) e.preventDefault()
  })
  contents.on('will-frame-navigate', (e) => {
    if (!/^https?:\/\//i.test(e.url)) e.preventDefault()
  })
})

app.on('second-instance', (_e, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  // podmuse:// 协议唤起（书签小工具 / OAuth 回调）
  const proto = argv.find(a => typeof a === 'string' && a.startsWith('podmuse://'))
  if (proto) routeProtocolUrl(proto)
})

/** OAuth 状态广播（renderer 订阅 notion:oauthStatus / feishu:oauthStatus 事件） */
function broadcastNotionOAuthStatus(): void {
  try {
    mainWindow?.webContents.send('notion:oauthStatus', getNotionStatus())
  } catch {}
}

function broadcastFeishuOAuthStatus(): void {
  try {
    mainWindow?.webContents.send('feishu:oauthStatus', getFeishuStatus())
  } catch {}
}

/**
 * podmuse:// 路由：OAuth 回调（podmuse://notion/callback）先走授权码闭环，
 * 其余交给剪贴板/书签处理（handleProtocolUrl）。飞书本地回调走 callback-server 的 http 端口。
 */
function routeProtocolUrl(rawUrl: string): void {
  if (parseNotionCallback(rawUrl)) {
    void handleNotionOAuthCallback(rawUrl, broadcastNotionOAuthStatus)
    return
  }
  handleProtocolUrl(rawUrl)
}

function hasActiveProcess(): boolean {
  if (pendingAbort && !pendingAbort.signal.aborted) return true
  // 批量队列正在处理时同样视为「有活跃进程」——
  // 否则 30s 一致性巡检会把批量任务误判为孤儿，提前标成「已停止」并截断终态写入
  if (batchQueueService?.hasActiveProcessing) return true
  if (monitor) {
    try {
      if (monitor.hasActiveProcess()) return true
    } catch {}
  }
  return false
}

function updateRecentState(
  updater: (state: ReturnType<typeof loadState>) => ReturnType<typeof loadState>,
): ReturnType<typeof loadState> {
  const current = loadState()
  const updated = updater(current)
  saveState(updated)
  try {
    mainWindow?.webContents.send('task:state-changed')
  } catch {}
  return updated
}

function getResourcePath(...segments: string[]) {
  return join(__dirname, '..', ...segments)
}

function createWindow() {
  Menu.setApplicationMenu(null)

  let icon: Electron.NativeImage | undefined
  try {
    const fs = require('fs')
    const baseDirs = [process.resourcesPath, join(__dirname, '..', '..'), app.getAppPath()].filter(
      Boolean,
    )

    const iconCandidates = ['build/icon.png', '播客笔记_256.png', '播客笔记.png']

    for (const base of baseDirs) {
      for (const candidate of iconCandidates) {
        const p = join(base, candidate)
        if (fs.existsSync(p)) {
          icon = nativeImage.createFromPath(p)
          console.log('图标已加载:', p)
          break
        }
      }
      if (icon) break
    }
    if (!icon)
      console.log(
        '⚠ 未找到图标文件，尝试过的路径:',
        baseDirs.flatMap(d => iconCandidates.map(c => join(d, c))),
      )
  } catch (e) {
    console.log('图标加载异常:', e)
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 680,
    title: 'PodMuse',
    icon,
    backgroundColor: '#0a0a0f',
    show: false,
    frame: false,
    transparent: false,
    resizable: true,
    webPreferences: {
      preload: getResourcePath('preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // 拦截窗口关闭事件，隐藏到系统托盘而非退出
  mainWindow.on('close', e => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`Page load failed: ${code} - ${desc}`)
  })

  // 规则：应用内所有 window.open 弹出链接一律交给用户默认浏览器打开（不在应用内弹窗）。
  // 只放行 http/https：自定义协议（bytedance:// 等）系统无处理程序，
  // 交给 shell.openExternal 会反复弹 Windows「需要使用新应用以打开此链接」对话框。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      try {
        shell.openExternal(url)
      } catch {}
    }
    return { action: 'deny' }
  })

  // 规则：主框架不允许被导航走——笔记等处的 <a> 外链若漏到默认导航，会把无边框主窗口
  // 整页顶成外部网页（无关闭/返回按钮）。一律拦截：http/https 转交默认浏览器，其余阻止。
  // 初始 loadURL/loadFile 与 SPA 路由（pushState）不触发此事件，不受影响。
  mainWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) {
      try {
        shell.openExternal(url)
      } catch {}
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    const htmlPath = join(__dirname, '..', '..', 'dist', 'index.html')
    mainWindow.loadFile(htmlPath)
  }
}

function setupIPC() {
  // 注册无状态/轻量级 IPC handler（配置、任务、搜索、窗口、对话框等）
  registerCoreIPC(mainWindow, monitor)

  // 初始化批量处理队列引擎
  batchQueueService = new BatchQueueService({
    onTaskUpdate: (index, task) => {
      try {
        mainWindow?.webContents.send('batch:task-update', index, task)
      } catch {}
    },
    onQueueStateChange: () => {
      try {
        const state = batchQueueService?.getState()
        mainWindow?.webContents.send('batch:queue-state', state)
        // Sync batch mode to Feishu dispatcher
        const isBatchActive = state && (state.status === 'running' || state.status === 'paused')
        monitor?.setBatchMode(!!isBatchActive)
      } catch {}
    },
    onQueueComplete: summary => {
      try {
        mainWindow?.webContents.send('batch:queue-complete', summary)
      } catch {}
    },
    sendStep: step => {
      try {
        mainWindow?.webContents.send('podcast:step', step)
      } catch {}
    },
    sendLog: msg => {
      try {
        mainWindow?.webContents.send('log', msg)
      } catch {}
    },
    updateRecentState: updater => {
      updateRecentState(updater)
    },
  })
  registerBatchIPC(mainWindow, batchQueueService)
  registerHistoryIPC(batchQueueService)
  registerShareIpc()
  registerExportDocsIpc()

  // 订阅服务（RSS 定时检查 + 自动入队）
  subscriptionService = createSubscriptionService(
    () => mainWindow,
    () => batchQueueService,
  )
  registerSubscriptionIPC(subscriptionService)

  // ---- 自动更新 IPC（开发/便携模式下 updaterHandle 为 null，调用即空转） ----
  ipcMain.handle('updater:manual-check', () => {
    updaterHandle?.manualCheck()
    return true
  })
  ipcMain.handle('updater:download', () => {
    updaterHandle?.download()
    return true
  })
  ipcMain.handle('updater:install', () => {
    updaterHandle?.install()
    return true
  })

  // ---- 抖音下载器安装检查 ----
  ipcMain.handle('douyin:setup', async () => {
    const { execSync } = await import('child_process')
    const downloadPath = process.env.DOUYIN_DOWNLOADER_PATH || 'G:\\douyin-downloader-main'
    const scriptPath = join(downloadPath, 'douyin-cli.py')

    // 检查 Python
    let pythonOk = false
    try {
      const ver = execSync('python --version', { encoding: 'utf-8' }).trim()
      pythonOk = ver.includes('3.')
    } catch {}

    if (!pythonOk) {
      return {
        success: false,
        error:
          '请先安装 Python 3.8+：https://www.python.org/downloads/\n安装时勾选 Add Python to PATH',
      }
    }

    // 检查 douyin-downloader 是否存在
    if (!fs.existsSync(scriptPath)) {
      return {
        success: false,
        error:
          '请下载抖音下载器并解压到 ' +
          downloadPath +
          '\n下载地址: https://github.com/jiji262/douyin-downloader/archive/refs/heads/main.zip',
      }
    }

    // 安装依赖
    try {
      execSync('pip install -r requirements.txt', {
        cwd: downloadPath,
        encoding: 'utf-8',
        timeout: 120000,
      })
    } catch (e: unknown) {
      return {
        success: false,
        error: '安装依赖失败: ' + (e instanceof Error ? e.message : String(e)),
      }
    }

    return { success: true, path: downloadPath }
  })

  // ---- 抖音登录（主进程闭环：cookie 不出主进程，renderer 只见状态与昵称） ----
  ipcMain.handle('douyin:connect', async () => {
    return await connectDouyin(mainWindow)
  })

  ipcMain.handle('douyin:status', () => {
    return getDouyinStatus()
  })

  ipcMain.handle('douyin:disconnect', () => {
    return disconnectDouyin()
  })

  // ---- Notion OAuth 连接服务（凭据未注册时优雅降级为 oauth_not_configured） ----
  ipcMain.handle('notion:oauthStatus', () => {
    return getNotionStatus()
  })
  // 手动 Token 模式：列出当前 Token 可访问的数据库（供设置页下拉选择）
  ipcMain.handle('notion:listManualDatabases', () => {
    return listManualNotionDatabases()
  })
  // useLocalCallback=true 时走本地固定端口回调（localhost:47840，须在 Public integration 登记 Redirect URI）
  ipcMain.handle('notion:oauthStart', (_e, opts?: { useLocalCallback?: boolean }) => {
    return startNotionAuth({
      ...(opts && typeof opts === 'object' ? opts : {}),
      onStatusChange: broadcastNotionOAuthStatus,
    })
  })
  ipcMain.handle('notion:oauthDatabases', () => {
    return listNotionDatabases()
  })
  ipcMain.handle('notion:oauthSelectDb', (_e, databaseId: string) => {
    return setNotionDatabase(typeof databaseId === 'string' ? databaseId : '')
  })
  ipcMain.handle('notion:oauthDisconnect', () => {
    return disconnectNotion()
  })

  // ---- 飞书 OAuth 连接服务（本地回调 server 优先；凭据未注册时优雅降级） ----
  ipcMain.handle('feishu:oauthStatus', () => {
    return getFeishuStatus()
  })
  ipcMain.handle('feishu:oauthStart', () => {
    return startFeishuAuth(broadcastFeishuOAuthStatus)
  })
  ipcMain.handle('feishu:oauthChats', () => {
    return listFeishuChats()
  })
  ipcMain.handle('feishu:oauthSelectChat', (_e, params: { chatId?: string; chatName?: string }) => {
    const chatId = typeof params?.chatId === 'string' ? params.chatId : ''
    const chatName = typeof params?.chatName === 'string' ? params.chatName : undefined
    return setFeishuChat(chatId, chatName)
  })
  ipcMain.handle('feishu:oauthDisconnect', () => {
    return disconnectFeishu()
  })

  // ---- 以下为涉及模块级状态的 handler，保留在 index.ts 中 ----

  ipcMain.handle('feishu:start', async () => {
    try {
      if (monitor) monitor.stop()
      const config = loadConfig()

      // 检测敏感字段解密是否失败
      const failedFields = (config as unknown as Record<string, unknown>)
        ._decryptionFailedFields as string[] | undefined
      if (failedFields?.length) {
        const msg = `⚠ 凭据解密失败（${failedFields.join(', ')}），请在设置中重新输入飞书 App Secret 和 API Key`
        try {
          mainWindow?.webContents.send('log', msg)
        } catch {}
      }

      monitor = new FeishuMonitor(
        config,
        (msg: string) => {
          try {
            mainWindow?.webContents.send('log', msg)
          } catch {}
        },
        (status: FeishuStatus) => {
          try {
            mainWindow?.webContents.send('feishu:status', status)
          } catch {}
        },
        (step: StepInfo) => {
          try {
            mainWindow?.webContents.send('podcast:step', step)
          } catch {}
        },
        (p: boolean, url?: string) => {
          try {
            mainWindow?.webContents.send('podcast:processing', p, url)
          } catch {}
          if (!p && pendingProcessDone) {
            pendingProcessDone()
            pendingProcessDone = null
          }
        },
        () => {
          try {
            mainWindow?.webContents.send('task:state-changed')
          } catch {}
        },
      )
      await monitor.start()
      return monitor.getStatus()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('feishu:start error:', msg)
      try {
        mainWindow?.webContents.send('log', `⚠ 飞书启动异常: ${msg}`)
      } catch {}
      return { connected: false, monitoring: false, chatId: '' }
    }
  })

  ipcMain.handle('feishu:stop', () => {
    monitor?.stop()
    return { connected: monitor?.isConnected() ?? false, monitoring: false, chatId: '' }
  })

  ipcMain.handle('feishu:status', () => {
    return monitor?.getStatus() ?? { connected: false, monitoring: false, chatId: '' }
  })

  // 自动拉取机器人所在群列表（三字段直连模式：Chat ID 无需手动复制，下拉即选）
  ipcMain.handle(
    'feishu:listChats',
    async (_e, params: { appId: string; appSecret: string }) => {
      try {
        const { FeishuClient } = await import('./feishu-client')
        const client = new FeishuClient(params.appId, params.appSecret, () => {})
        const ok = await client.ensureToken()
        if (!ok) return { success: false, error: '飞书鉴权失败，请检查 App ID 和 App Secret' }
        const chats = await client.listChats()
        if (chats.length === 0) {
          return {
            success: true,
            chats: [],
            warning: '未找到群聊：请确认机器人已发布、已开通 im:chat:readonly 权限，并把机器人拉进目标群后重试',
          }
        }
        return { success: true, chats }
      } catch (e) {
        return { success: false, error: (e as Error).message }
      }
    },
  )

  ipcMain.handle(
    'feishu:testConnection',
    async (_e, params: { appId: string; appSecret: string; chatId: string }) => {
      try {
        const { FeishuClient } = await import('./feishu-client')
        const client = new FeishuClient(params.appId, params.appSecret, () => {})
        const ok = await client.ensureToken()
        if (!ok) {
          return { success: false, code: 'auth_failed' }
        }
        // 如果填了 Chat ID，验证是否有效
        if (params.chatId?.trim()) {
          const chatName = await client.getChatInfo(params.chatId.trim())
          if (chatName) {
            return { success: true, code: 'chat_ok', chatName }
          }
          return { success: false, code: 'chat_invalid' }
        }
        return { success: true, code: 'no_chat_skipped' }
      } catch (e) {
        return {
          success: false,
          code: 'test_error',
          detail: (e as Error).message,
        }
      }
    },
  )

  ipcMain.handle(
    'podcast:process',
    async (
      _event,
      {
        url,
        force,
        taskId,
        isLocalFile,
      }: { url: string; force?: boolean; taskId?: string; isLocalFile?: boolean },
    ) => {
      if (!isLocalFile) {
        // 使用平台注册表获取去重 key（通用，支持所有平台）
        const platformInfo = platformRegistry.findAdapter(url)
        const episodeId = platformInfo?.adapter.getDedupKey(url) || null
        if (!force && episodeId && processedEpisodeIds.has(episodeId)) {
          mainWindow?.webContents.send('log', `⏭ 该播客已处理过 (${episodeId})，跳过`)
          return { success: false, error: '该播客已处理过' }
        }
      }
      const initialTitle = isLocalFile
        ? basename(url, extname(url))
        : await fetchPodcastTitle(url).catch(() => null)
      const platformInfoForId = !isLocalFile ? platformRegistry.findAdapter(url) : null
      const episodeId = platformInfoForId?.adapter.getDedupKey(url) || null
      // Capture the actual taskId (auto-generated if none provided) so completeRecentTask can find it
      const stateAfterStart = updateRecentState(state =>
        startRecentTask(state, { id: taskId, url, episodeId, title: initialTitle }),
      )
      const actualTaskId =
        stateAfterStart.activeTasks.find(t => t.url === url && t.status === 'running')?.id || taskId
      pendingAbort = new AbortController()
      const signal = pendingAbort.signal
      const config = loadConfig()
      // 获取活跃 AI 供应商配置，回退到旧 api_key 字段
      let activeProvider = getActiveProviderConfig(config.ai_provider, config.ai_providers)
      if (!activeProvider && config.api_key) {
        activeProvider = {
          baseUrl: 'https://api.deepseek.com',
          apiKey: config.api_key,
          model: 'deepseek-chat',
        }
      }
      let lastErrorDetail: string | null = null
      // 处理阶段从平台适配器拿到的真实标题（预取失败时兜底回填历史记录）
      const processedTitle: { value: string | null } = { value: null }
      try {
        const result = await processPodcast(
          url,
          activeProvider,
          config.ai_provider,
          config.language,
          config.obsidian_dir,
          config.audio_dir,
          (step: StepInfo) => {
            if (step.status === 'error') lastErrorDetail = step.detail || step.subtitle
            try {
              mainWindow?.webContents.send('podcast:step', step)
            } catch {}
          },
          (msg: string) => {
            try {
              mainWindow?.webContents.send('log', msg)
            } catch {}
          },
          signal,
          isLocalFile,
          force || false,
          processedTitle,
        )
        if (result) {
          if (episodeId) {
            addProcessedId(episodeId)
          }
          updateRecentState(state =>
            completeRecentTask(state, {
              taskId: actualTaskId,
              url,
              episodeId,
              filename: result,
              title: processedTitle.value || null,
            }),
          )
          if (config.notification_enabled !== false) {
            sendNotification('PodMuse', `笔记已生成：${result}`)
          }
        } else {
          // 用户取消时 processPodcast 可能返回 null（whisper abort 后 finish(null) 等），
          // 此时应标记为「已停止」而非「失败」，也不发失败通知
          if (signal.aborted) {
            updateRecentState(state =>
              stopRecentTask(state, { taskId: actualTaskId, url, episodeId }),
            )
            mainWindow?.webContents.send('log', '■ 处理已取消')
            for (let i = 1; i <= 5; i++) {
              const titles = ['解析页面', '下载音频', '语音转文字', '修正专有名词', 'AI 提炼笔记']
              mainWindow?.webContents.send('podcast:step', {
                step: i,
                title: titles[i - 1],
                subtitle: '已取消',
                status: 'stopped',
                detail: '用户取消了处理',
              })
            }
            return { success: false, error: '处理已取消' }
          }
          const errorReason = lastErrorDetail || '处理失败，请检查日志'
          updateRecentState(state =>
            failRecentTask(state, errorReason, { taskId: actualTaskId, url, episodeId }),
          )
          if (config.notification_enabled !== false) {
            sendNotification('PodMuse', `处理失败：${errorReason}`)
          }
          return { success: false, error: errorReason }
        }
        return { success: true, filename: result }
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : ''
        const errMsg = err instanceof Error ? err.message : String(err)
        if (errName === 'AbortError' || signal.aborted) {
          updateRecentState(state =>
            stopRecentTask(state, { taskId: actualTaskId, url, episodeId }),
          )
          mainWindow?.webContents.send('log', '■ 处理已取消')
          for (let i = 1; i <= 5; i++) {
            const titles = ['解析页面', '下载音频', '语音转文字', '修正专有名词', 'AI 提炼笔记']
            mainWindow?.webContents.send('podcast:step', {
              step: i,
              title: titles[i - 1],
              subtitle: '已取消',
              status: 'stopped',
              detail: '用户取消了处理',
            })
          }
          return { success: false, error: '处理已取消' }
        }
        updateRecentState(state =>
          failRecentTask(state, errMsg, { taskId: actualTaskId, url, episodeId }),
        )
        if (config.notification_enabled !== false) {
          sendNotification('PodMuse', `处理出错：${errMsg}`)
        }
        return { success: false, error: errMsg }
      } finally {
        if (pendingAbort?.signal === signal) pendingAbort = null
        if (pendingProcessDone) {
          pendingProcessDone()
          pendingProcessDone = null
        }
      }
    },
  )

  ipcMain.handle('podcast:checkProcessed', (_e, url: string) => {
    const platformInfo = platformRegistry.findAdapter(url)
    const episodeId = platformInfo?.adapter.getDedupKey(url) || null
    return episodeId ? processedEpisodeIds.has(episodeId) : false
  })

  ipcMain.handle('podcast:cancel', async () => {
    let cancelled = false

    if (pendingAbort && !pendingAbort.signal.aborted) {
      pendingAbort.abort()
      cancelled = true
    }

    if (monitor?.cancelProcessing()) {
      cancelled = true
    }

    if (!cancelled) {
      const state = loadState()
      const zombieCount = state.activeTasks.filter(t => t.status === 'running').length
      if (zombieCount > 0) {
        const fixed = runConsistencyCheck(hasActiveProcess, (msg: string) => {
          try {
            mainWindow?.webContents.send('log', msg)
          } catch {}
        })
        if (fixed > 0) {
          cancelled = true
          try {
            mainWindow?.webContents.send('task:state-changed')
          } catch {}
        }
      }
    }

    if (cancelled && pendingAbort) {
      await new Promise<void>(resolve => {
        pendingProcessDone = resolve
      })
    }

    return cancelled
  })

  ipcMain.handle('whisper:scanModels', () => {
    const config = loadConfig()
    return scanLocalModels(config.whisper_exe_path)
  })

  ipcMain.handle('whisper:checkHardware', (_e, modelId: string) => {
    return checkHardware(modelId)
  })

  ipcMain.handle('whisper:autoDetect', () => {
    try {
      const detected = autoDetectExePath()
      if (detected) {
        const cfg = loadConfig()
        saveConfig({ ...cfg, whisper_exe_path: detected })
        return { path: detected }
      }
      return { path: null }
    } catch (e) {
      return { path: null, error: (e as Error).message }
    }
  })

  // Whisper 一键下载（后台执行：invoke 立即返回，进度经 whisper:download-progress 事件推送；
  // TabWhisper 与首次启动向导共用同一份主进程状态）
  ipcMain.handle('whisper:download', () => {
    void startWhisperDownload().catch(() => {})
    return getWhisperDownloadState()
  })

  ipcMain.handle('whisper:downloadStatus', () => {
    return getWhisperDownloadState()
  })

  ipcMain.handle('whisper:downloadCancel', () => {
    return cancelWhisperDownload()
  })

  // 下载状态 → 渲染进程事件（挂载时通过 whisper:downloadStatus 拉取当前状态兜底）
  onWhisperDownloadState(state => {
    try {
      mainWindow?.webContents.send('whisper:download-progress', state)
    } catch {}
  })

  // 剪贴板读取：无感配置向导步激活期间由渲染进程按需轮询（clipboard-watcher.ts 先例）；
  // 主进程不记录剪贴板内容
  ipcMain.handle('clipboard:readText', () => {
    try {
      return clipboard.readText()
    } catch {
      return ''
    }
  })

  // AI 测试连接：发送 1 token 最小 chat 请求，返回结构化错误码（ai-test.ts）；
  // detail 只含状态码与脱敏摘要，绝不回传 apiKey / 响应体全文
  ipcMain.handle(
    'ai:testConnection',
    async (
      _e,
      params: { baseUrl: string; apiKey: string; model: string; providerId: string },
    ) => {
      try {
        let apiKey = params?.apiKey || ''
        const baseUrl = params?.baseUrl || ''
        const model = params?.model || ''
        const providerId = (params?.providerId || 'deepseek') as AIProviderId

        if (!baseUrl || !apiKey) {
          return { success: false, code: 'unknown', detail: '请先填写 API 地址和 API Key' }
        }
        if (!isSafeUrl(baseUrl)) {
          return {
            success: false,
            code: 'bad_url',
            detail: 'API 地址必须使用 http:// 或 https:// 协议',
          }
        }

        // 脱敏值还原（复用 ai:fetchModels 先例）
        if (/^\*{4}/.test(apiKey)) {
          const config = loadConfig()
          const realKey = config.ai_providers
            ? Object.values(config.ai_providers).find(
                p => p.apiKey && maskSecret(p.apiKey) === apiKey,
              )?.apiKey
            : undefined
          if (realKey) {
            apiKey = realKey
          } else if (config.api_key && maskSecret(config.api_key) === apiKey) {
            apiKey = config.api_key
          } else {
            return {
              success: false,
              code: 'unknown',
              detail: 'API Key 是脱敏值，无法获取真实密钥。请在设置中重新输入 API Key',
            }
          }
        }

        return await testAIConnection({ baseUrl, apiKey, model, providerId })
      } catch (err) {
        const msg = err instanceof Error ? err.message : '测试连接失败'
        return { success: false, code: 'unknown', detail: msg }
      }
    },
  )

  ipcMain.handle(
    'ai:fetchModels',
    async (_e, { baseUrl, apiKey }: { baseUrl: string; apiKey: string }) => {
      try {
        // 如果 apiKey 是脱敏值（以 **** 开头），从配置文件读取真实值
        if (apiKey && /^\*{4}/.test(apiKey)) {
          const config = loadConfig()
          const realKey = config.ai_providers
            ? Object.values(config.ai_providers).find(
                p => p.apiKey && maskSecret(p.apiKey) === apiKey,
              )?.apiKey
            : undefined
          if (realKey) {
            apiKey = realKey
          } else if (config.api_key && maskSecret(config.api_key) === apiKey) {
            apiKey = config.api_key
          } else {
            return {
              success: false,
              error: 'API Key 是脱敏值，无法获取真实密钥。请在设置中重新输入 API Key',
              models: [],
            }
          }
        }

        if (!baseUrl || !apiKey) {
          return { success: false, error: '请先填写API地址和API Key', models: [] }
        }
        if (!isSafeUrl(baseUrl)) {
          return { success: false, error: 'API 地址必须使用 http:// 或 https:// 协议', models: [] }
        }
        const url = normalizeBaseUrl(baseUrl) + '/models'

        const resp = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
        })

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => '')
          return { success: false, error: `HTTP ${resp.status}: ${errorText}`, models: [] }
        }

        const data = (await resp.json()) as { data?: Array<{ id: string }> }
        const models = (data.data || [])
          .map(m => ({ id: m.id, name: m.id }))
          .sort((a, b) => a.id.localeCompare(b.id))

        return { success: true, models }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '获取模型列表失败'
        return { success: false, error: msg, models: [] }
      }
    },
  )
}

function createTray() {
  let icon: Electron.NativeImage | undefined
  try {
    const baseDirs = [process.resourcesPath, join(__dirname, '..', '..'), app.getAppPath()].filter(
      Boolean,
    )

    const iconCandidates = ['build/icon.png', '播客笔记_256.png', '播客笔记.png']

    for (const base of baseDirs) {
      for (const candidate of iconCandidates) {
        const p = join(base, candidate)
        if (fs.existsSync(p)) {
          icon = nativeImage.createFromPath(p)
          break
        }
      }
      if (icon) break
    }
  } catch {}

  tray = new Tray(icon || nativeImage.createEmpty())
  tray.setToolTip('PodMuse')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  // 项目更名后 userData 路径可能变化（podcast-notes → podmuse），迁移旧配置
  try {
    const oldData = join(app.getPath('appData'), 'podcast-notes')
    const newData = app.getPath('userData')
    if (oldData !== newData && fs.existsSync(oldData) && !fs.existsSync(newData)) {
      fs.mkdirSync(newData, { recursive: true })
      fs.cpSync(oldData, newData, { recursive: true })
      console.log('[migrate] 已从旧配置目录迁移: ' + oldData + ' -> ' + newData)
    }
  } catch (e) {
    console.error('[migrate] 配置迁移失败:', e)
  }

  // 设置 AppUserModelID 以支持 Windows 通知
  setupNotificationAppId()

  // 初始化 prompt 模板目录并导出内置模板
  const promptsDir = join(app.getPath('userData'), 'prompts')
  setPromptDir(promptsDir)
  exportBuiltInTemplates()

  runStartupRecovery((msg: string) => {
    console.log(msg)
  })

  createWindow()
  setupIPC()
  createTray()

  // 启动时自动刷新抖音登录状态（已存 cookie 时重验，失效标 expired；不阻塞启动）
  void refreshDouyinStatus().catch(() => {})

  // 自动更新（增量）：开发/便携模式自动跳过
  updaterHandle = setupUpdater({
    send: state => {
      try {
        mainWindow?.webContents.send('updater:state', state)
      } catch {}
    },
    beforeQuitAndInstall: () => {
      isQuitting = true
    },
  })

  // 剪贴板链接检测 + podmuse:// 协议（浏览器剪藏）
  registerProtocol()
  startClipboardWatcher()
  startClipServer(url => processUrl(url))
  ipcMain.on('toast:close', () => closeToastWindow())
  const protoArgv = process.argv.find(a => a.startsWith('podmuse://'))
  if (protoArgv) routeProtocolUrl(protoArgv)

  startConsistencyChecker(
    hasActiveProcess,
    (msg: string) => {
      console.log(msg)
      try {
        mainWindow?.webContents.send('log', msg)
      } catch {}
    },
    (_count: number) => {
      try {
        mainWindow?.webContents.send('task:state-changed')
      } catch {}
    },
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  stopConsistencyChecker()
  stopClipboardWatcher()
  stopClipServer()
  if (pendingAbort && !pendingAbort.signal.aborted) {
    pendingAbort.abort()
  }
  subscriptionService?.stopScheduler()
  if (batchQueueService?.isRunning) {
    batchQueueService.pause()
  }
  batchQueueService?.forceFlush?.()
  monitor?.cancelProcessing()
  monitor?.stop()
  tray?.destroy()
  tray = null
})

app.on('window-all-closed', () => {
  // 窗口全部关闭时不退出，保持后台运行（系统托盘）
})
