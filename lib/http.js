import { clip } from './util.js'

const PREFIX = '/dsh-meituan/api'

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        return resolve(JSON.parse(raw))
      } catch {
        return reject(new Error('请求不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function createHttpHandler({ store, meituan, jd, logger }) {
  const handler = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(PREFIX)) {
      if (typeof next === 'function') return next()
      return json(res, 404, { ok: false, error: 'not found' })
    }
    const route = url.pathname.slice(PREFIX.length) || '/'
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    try {
      if (req.method === 'GET' && route === '/status') {
        const status = await meituan.status({})
        return json(res, 200, {
          ok: true,
          status,
          config: store.getConfig(),
          taste: store.getTaste(),
        })
      }
      if (req.method === 'POST' && route === '/config') {
        const patch = await readBody(req)
        const config = store.patchConfig(patch || {})
        return json(res, 200, { ok: true, config })
      }
      if (req.method === 'GET' && route === '/addresses') {
        const result = await meituan.listAddresses()
        return json(res, 200, { ok: true, ...result, config: store.getConfig() })
      }
      if (req.method === 'POST' && route === '/address') {
        const body = await readBody(req)
        const value = String(body.address || '').trim()
        const config = store.patchConfig({ address: value })
        // 立刻按新地点切一次商圈，省得下一句还得等
        let switched = null
        if (value && body.apply !== false) {
          switched = await meituan
            .order({ action: 'address', address: value })
            .catch((error) => ({ ok: false, reason: clip(error?.message || error, 200) }))
        }
        return json(res, 200, { ok: true, config, switched })
      }
      if (req.method === 'POST' && route === '/taste') {
        const patch = await readBody(req)
        const taste = store.setTaste(patch || {})
        return json(res, 200, { ok: true, taste })
      }
      if (req.method === 'POST' && route === '/login/send') {
        const body = await readBody(req)
        const result = await meituan.loginStart(String(body.phone || ''))
        return json(res, 200, { ok: true, ...result })
      }
      if (req.method === 'POST' && route === '/login/verify') {
        const body = await readBody(req)
        const result = await meituan.loginVerify(String(body.code || ''))
        return json(res, 200, { ok: true, result })
      }
      if (req.method === 'POST' && route === '/login/open') {
        const result = await meituan.openLogin()
        return json(res, 200, { ok: true, ...result })
      }
      if (req.method === 'POST' && route === '/logout') {
        const result = await meituan.logout()
        return json(res, 200, { ok: true, ...result })
      }
      if (req.method === 'POST' && route === '/check') {
        const status = await meituan.status({ deep: true })
        return json(res, 200, { ok: true, status })
      }
      if (req.method === 'POST' && route === '/test/list') {
        const body = await readBody(req)
        const result = await meituan.listShops({ keyword: String(body.keyword || ''), limit: Number(body.limit) || 5 })
        return json(res, 200, { ok: true, total: result.total, shops: result.shops.slice(0, 6) })
      }
      if (req.method === 'POST' && route === '/browser/stop') {
        await meituan.stop()
        return json(res, 200, { ok: true })
      }
      if (req.method === 'GET' && route === '/jd/status') {
        return json(res, 200, { ok: true, ...(jd?.status?.() || {}) })
      }
      if (req.method === 'POST' && route === '/jd/pick') {
        const body = await readBody(req)
        const result = await jd.pick({
          count: Number(body.count) || 3,
          keyword: String(body.keyword || ''),
          limit: Number(body.limit) || 12,
          budget: Number(body.budget) || 0,
          taste: store.getTaste(),
          fresh: Boolean(body.fresh),
        })
        return json(res, 200, { ok: true, ...result })
      }
      return json(res, 404, { ok: false, error: `未知接口 ${req.method} ${route}` })
    } catch (error) {
      const message = clip(error?.message || String(error), 400)
      logger?.warn?.(`美团外卖 HTTP ${req.method} ${route} 失败：${message}`)
      return json(res, 400, { ok: false, error: message })
    }
  }
  return { path: PREFIX, handler }
}
