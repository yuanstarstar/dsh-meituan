/**
 * 「真浏览器」桥：DSH 这边开的本地小服务，靠扩展（extension/）在用户本人的 Edge 里收命令。
 *
 * 为什么要它：走 CDP 遥控 + 无头浏览器是明显的自动化特征，美团风控会直接 403。
 * 换成「你自己的浏览器 + 扩展注入」后，所有请求都是页面自己发的（带真签名、真登录态），
 * 我们只是旁听结果。这就是 SnowLuma 那套「真客户端 + 注入」的做法。
 *
 * 协议（全部要求 token）：
 *   GET  /bridge/poll?wait=25000      扩展长轮询取命令（没有命令就挂住，超时回 204）
 *   POST /bridge/result               {id, result} 扩展回传结果
 *   POST /bridge/command              外部（探针/调试）投一条命令并等结果
 *   GET  /bridge/health               连通性
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_PORT = 45321

const json = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

const readBody = (req, limit = 8 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大了'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })

export class Bridge {
  constructor({ store, port, token, logger } = {}) {
    this.store = store
    this.logger = logger
    this.port = Number(port || process.env.DSH_MEITUAN_BRIDGE_PORT || DEFAULT_PORT)
    this.token = token || ''
    this.server = null
    this.pending = new Map()
    this.ready = [] // 正在长轮询的扩展响应
    this.seq = 0
    this.lastPollAt = 0
    this.lastResultAt = 0
    this.started = false
    this.file = store ? path.join(store.dir, 'bridge.json') : ''
  }

  /** 端口 + token 存到 data/bridge.json，方便贴进扩展设置 */
  loadCredentials() {
    let saved = {}
    if (this.file && fs.existsSync(this.file)) {
      try {
        saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      } catch {
        saved = {}
      }
    }
    const token = saved.token || this.token || crypto.randomBytes(12).toString('hex')
    const port = saved.port || this.port
    this.token = token
    this.port = Number(port)
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, `${JSON.stringify({ port: this.port, token }, null, 2)}\n`, 'utf8')
    }
    return { port: this.port, token: this.token }
  }

  get connected() {
    return Date.now() - this.lastPollAt < 70_000
  }

  status() {
    return {
      port: this.port,
      token: this.token,
      started: this.started,
      connected: this.connected,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : '',
      lastResultAt: this.lastResultAt ? new Date(this.lastResultAt).toISOString() : '',
      pending: this.pending.size,
    }
  }

  async start() {
    if (this.started) return this.status()
    this.loadCredentials()

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`)
      const token = url.searchParams.get('token') || req.headers['x-bridge-token'] || ''

      // 配对：扩展第一次连上来时还不知道 token（token 是每次安装随机生成的）。
      // 只接受「来自扩展」的请求（Origin: chrome-extension://…），普通网页拿不到。
      if (url.pathname === '/bridge/pair') {
        const origin = String(req.headers.origin || '')
        const fromExtension = /^chrome-extension:\/\//i.test(origin) || req.headers['x-bridge-client'] === 'dsh-meituan-extension'
        if (!fromExtension) {
          json(res, 403, { ok: false, error: '只给浏览器扩展配对' })
          return
        }
        json(res, 200, { ok: true, port: this.port, token: this.token })
        return
      }

      if (url.pathname !== '/bridge/health' && token !== this.token) {
        json(res, 401, { ok: false, error: 'token 不对' })
        return
      }

      try {
        if (url.pathname === '/bridge/health') {
          json(res, 200, { ok: true, ...this.status() })
          return
        }

        if (url.pathname === '/bridge/poll') {
          this.lastPollAt = Date.now()
          const wait = Math.min(40_000, Math.max(1000, Number(url.searchParams.get('wait')) || 25_000))
          const reply = () => {
            const index = this.ready.indexOf(reply)
            if (index >= 0) this.ready.splice(index, 1)
          }
          const timer = setTimeout(() => {
            reply()
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
          }, wait)
          reply.send = (value) => {
            clearTimeout(timer)
            reply()
            json(res, 200, value)
          }
          reply.close = () => {
            clearTimeout(timer)
            reply()
          }
          req.on('close', reply.close)
          this.ready.push(reply)
          this.flush()
          return
        }

        if (url.pathname === '/bridge/result' && req.method === 'POST') {
          const body = await readBody(req)
          const entry = this.pending.get(body.id)
          this.lastResultAt = Date.now()
          if (entry) {
            this.pending.delete(body.id)
            clearTimeout(entry.timer)
            entry.resolve(body.result)
          }
          json(res, 200, { ok: true })
          return
        }

        if (url.pathname === '/bridge/command' && req.method === 'POST') {
          const body = await readBody(req)
          const timeoutMs = Math.min(180_000, Number(body.timeoutMs) || 60_000)
          const result = await this.call(body.op, body, { timeoutMs })
          json(res, 200, { ok: true, result })
          return
        }

        json(res, 404, { ok: false, error: '没有这个路由' })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, '127.0.0.1', resolve)
    })
    server.on('error', (error) => this.logger?.warn?.(`美团桥出错：${error.message}`))
    this.server = server
    this.started = true
    this.logger?.info?.(`美团桥已启动：http://127.0.0.1:${this.port}（token ${this.token}）`)
    return this.status()
  }

  flush() {
    for (const [id, entry] of this.pending) {
      if (entry.sent) continue
      const reply = this.ready.shift()
      if (!reply) return
      entry.sent = true
      reply.send({ id, ...entry.command })
    }
  }

  /** 发一条命令给扩展，等它回结果 */
  async call(op, args = {}, { timeoutMs = 60_000 } = {}) {
    await this.start()
    if (!this.ready.length && !this.connected) {
      // 先给个机会（扩展可能刚好在重启轮询）
      await new Promise((r) => setTimeout(r, 1200))
    }
    if (!this.ready.length && !this.connected) {
      throw new Error(
        `没连上浏览器扩展（${this.port}）。请在 Edge 里装好并启用 extension/ 这个扩展，把端口 ${this.port} 和 token 填进去，然后打开一个美团外卖页面。`,
      )
    }
    const id = `c${++this.seq}-${crypto.randomBytes(3).toString('hex')}`
    const command = { op, ...args }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`扩展 ${Math.round(timeoutMs / 1000)} 秒没回结果（操作：${op}）`))
      }, timeoutMs)
      this.pending.set(id, { command, resolve, timer, sent: false })
      this.flush()
    })
  }

  async stop() {
    for (const reply of this.ready.splice(0)) reply.close?.()
    this.ready.length = 0
    for (const [, entry] of this.pending) clearTimeout(entry.timer)
    this.pending.clear()
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()))
      this.server = null
    }
    this.started = false
  }
}
