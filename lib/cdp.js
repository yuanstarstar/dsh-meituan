// 极简 CDP 控制器：启动本机 Chromium 内核浏览器（Edge/Chrome），用 DevTools 协议读页面。
// 不依赖任何第三方包：Node 22+ 自带 WebSocket / fetch。
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

const CANDIDATES = [
  process.env.DSH_MEITUAN_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

export function findBrowser(override) {
  if (override && fs.existsSync(override)) return override
  for (const candidate of CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.method) {
        for (const handler of this.listeners.get(message.method) || []) {
          try {
            handler(message.params)
          } catch {
            /* 监听器异常不影响主流程 */
          }
        }
        return
      }
      const entry = message.id ? this.pending.get(message.id) : null
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
    })
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(new Error('CDP 连接已断开'))
      this.pending.clear()
    })
  }

  open(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      this.ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('CDP 连接失败'))
        },
        { once: true },
      )
    })
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已断开'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(handler)
    return () => this.listeners.get(method)?.delete(handler)
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 一个常驻的浏览器会话：进程活着、页面连着、UA/视口是移动端。
 * 插件里全局复用一个实例，工具调用之间不用反复启动。
 */
export class Browser {
  constructor({ exe, profileDir, headless = true, width = 412, height = 915, scale = 2, logger } = {}) {
    this.logger = logger
    this.exe = exe || findBrowser()
    this.profileDir = profileDir
    this.headless = headless !== false
    this.width = width
    this.height = height
    this.scale = scale
    this.proc = null
    this.cdp = null
    this.port = 0
    this.pages = 0
  }

  get running() {
    return Boolean(this.proc && this.cdp && !this.cdp.closed)
  }

  async ensure() {
    if (this.running && (await this.alive())) return this.cdp
    await this.start()
    return this.cdp
  }

  async alive() {
    try {
      await this.cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 3000)
      return true
    } catch {
      return false
    }
  }

  async start() {
    if (!this.exe) throw new Error('没找到 Edge/Chrome：请先在设置里指定浏览器路径（DSH_MEITUAN_BROWSER）')
    await this.stop()
    this.port = await freePort()
    const args = [
      ...(this.headless ? ['--headless=new', '--disable-gpu', '--hide-scrollbars'] : []),
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${this.width},${this.height}`,
      '--lang=zh-CN',
      'about:blank',
    ]
    fs.mkdirSync(this.profileDir, { recursive: true })
    this.proc = spawn(this.exe, args, { detached: false, stdio: 'ignore' })
    this.proc.on('error', (error) => this.logger?.warn?.(`浏览器启动失败：${error.message}`))
    this.proc.on('exit', () => {
      this.proc = null
      this.cdp = null
    })

    const deadline = Date.now() + 25000
    let version = null
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`)
        if (response.ok) {
          version = await response.json()
          break
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(250)
    }
    if (!version) throw new Error('浏览器调试端口没起来（可能被安全软件拦了）')
    this.version = version.Browser

    const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()
    let page = list.find((target) => target.type === 'page')
    if (!page) {
      page = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' })).json()
    }
    const cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.open()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    if (this.headless !== false || true) {
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: MOBILE_UA,
        acceptLanguage: 'zh-CN,zh;q=0.9',
        platform: 'Linux armv8l',
      })
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: this.scale,
        mobile: true,
      })
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    }
    this.cdp = cdp
    return cdp
  }

  async stop() {
    if (this.cdp) {
      try {
        await this.cdp.send('Browser.close', {}, 2000)
      } catch {
        /* ignore */
      }
      this.cdp.close()
      this.cdp = null
    }
    if (this.proc) {
      const pid = this.proc.pid
      try {
        this.proc.kill()
      } catch {
        /* ignore */
      }
      if (pid && process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } catch {
          /* ignore */
        }
      }
      this.proc = null
    }
    await sleep(150)
  }

  /**
   * 监听页面发出的网络响应并抓正文（美团的数据都是接口给的，比扒 DOM 稳）。
   * 返回 { items, stop }，items 里是 { url, status, mime, text }。
   */
  async tap(pattern, { limit = 40, maxBytes = 500000 } = {}) {
    const cdp = await this.ensure()
    const items = []
    const matcher = pattern instanceof RegExp ? pattern : new RegExp(pattern)
    const meta = new Map()
    const offs = []
    offs.push(
      cdp.on('Network.responseReceived', (params) => {
        if (params.type !== 'XHR' && params.type !== 'Fetch' && params.type !== 'Document') return
        const url = params.response?.url || ''
        if (!matcher.test(url)) return
        meta.set(params.requestId, { url, status: params.response.status, mime: params.response.mimeType })
      }),
    )
    offs.push(
      cdp.on('Network.loadingFinished', (params) => {
        const info = meta.get(params.requestId)
        if (!info) return
        meta.delete(params.requestId)
        if (items.length >= limit) return
        cdp
          .send('Network.getResponseBody', { requestId: params.requestId }, 8000)
          .then((body) => {
            const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
            items.push({ ...info, text: String(text).slice(0, maxBytes) })
          })
          .catch(() => {})
      }),
    )
    return { items, stop: () => offs.forEach((off) => off()) }
  }

  async evaluate(expression, { timeoutMs = 30000 } = {}) {
    const cdp = await this.ensure()
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text
      throw new Error(`页面脚本出错：${detail}`)
    }
    return result.result?.value
  }

  async goto(url, { settleMs = 1200 } = {}) {
    const cdp = await this.ensure()
    await cdp.send('Page.navigate', { url })
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState').catch(() => null)
      if (state === 'complete') break
      await sleep(200)
    }
    if (settleMs) await sleep(settleMs)
  }

  async waitFor(selector, { timeoutMs = 15000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await this.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)
      if (found) return true
      await sleep(intervalMs)
    }
    return false
  }

  async click(selector, index = 0) {
    return this.evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const node = nodes[${index}]
      if (!node) return { ok: false, reason: 'selector not found', count: nodes.length }
      node.scrollIntoView({ block: 'center' })
      node.click()
      return { ok: true, count: nodes.length }
    })()`)
  }

  /** 真实点一下视口坐标（CSS 像素）。美团很多按钮只有 touch/pointer 监听，DOM.click() 不生效 */
  async clickAt(x, y, { settleMs = 260 } = {}) {
    const cdp = await this.ensure()
    const send = (type, button, clickCount) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount }, 10000)
    await send('mouseMoved', 'none', 0)
    await sleep(90)
    await send('mousePressed', 'left', 1)
    await sleep(80)
    await send('mouseReleased', 'left', 1)
    if (settleMs) await sleep(settleMs)
  }

  capture() {
    return this.evaluate('location.href').then(() => this.cdp.send('Page.captureScreenshot', { format: 'png' }))
  }

  /** 把浏览器窗口提到最前（要让用户亲手点的时候用） */
  async bringToFront() {
    const cdp = await this.ensure()
    await cdp.send('Page.bringToFront', {}, 8000).catch(() => {})
    return true
  }

  async screenshot(filePath) {
    await this.ensure()
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' })
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'))
      return filePath
    }
    return Buffer.from(shot.data, 'base64')
  }

  async cookies(domains = ['https://h5.waimai.meituan.com', 'https://waimai.meituan.com', 'https://i.meituan.com']) {
    const cdp = await this.ensure()
    const result = await cdp.send('Network.getCookies', { urls: domains }).catch(() => ({ cookies: [] }))
    return result.cookies || []
  }
}
