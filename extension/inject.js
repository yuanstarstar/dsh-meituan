/**
 * 跑在页面自己的环境里（world: MAIN）。
 * 它**不伪造任何请求**：只监听美团页面自己发出的 fetch / XHR，把响应抄一份。
 * 这样拿到的每个接口响应都带着页面自己生成的签名（mtgsig）和登录态，
 * 跟我们用 CDP 去敲接口完全不是一回事——这就是 SnowLuma 那套「真客户端 + 注入」的思路。
 */
;(() => {
  const KEY = '__DSH_MEITUAN__'
  if (window[KEY]) return

  const MAX_ITEMS = 80
  const MAX_BODY = 3 * 1024 * 1024
  const captures = []

  const push = (url, status, mime, text, req) => {
    try {
      if (!/waimai\.meituan\.com|jd\.com|jddj\.com/.test(url)) return
      captures.push({
        url,
        status,
        mime,
        text: String(text ?? '').slice(0, MAX_BODY),
        req: req ? { method: String(req.method || 'GET'), body: String(req.body ?? '').slice(0, 4000) } : null,
        at: Date.now(),
      })
      while (captures.length > MAX_ITEMS) captures.shift()
    } catch {
      /* 绝不影响页面 */
    }
  }

  const fromResponse = (res, url, req) => {
    try {
      const mime = res.headers?.get?.('content-type') || ''
      if (/json|text/i.test(mime)) {
        res
          .clone()
          .text()
          .then((text) => push(url, res.status, mime, text, req))
          .catch(() => {})
      } else {
        push(url, res.status, mime, '', req)
      }
    } catch {
      /* ignore */
    }
  }

  // ---- fetch ----
  const rawFetch = window.fetch
  if (typeof rawFetch === 'function') {
    window.fetch = function (...args) {
      const req = args[0]
      const init = args[1] || {}
      const url = typeof req === 'string' ? req : req && req.url ? req.url : String(req)
      const method = init.method || (req && req.method) || 'GET'
      let body = init.body
      if (body && typeof body !== 'string') body = ''
      const promise = rawFetch.apply(this, args)
      promise.then((res) => fromResponse(res, url, { method, body })).catch(() => {})
      return promise
    }
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest
  if (XHR && XHR.prototype) {
    const rawOpen = XHR.prototype.open
    const rawSend = XHR.prototype.send
    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__dshUrl = String(url)
        this.__dshMethod = String(method || 'GET')
      } catch {
        /* ignore */
      }
      return rawOpen.call(this, method, url, ...rest)
    }
    XHR.prototype.send = function (...args) {
      try {
        const url = this.__dshUrl || ''
        if (/waimai\.meituan\.com|jd\.com|jddj\.com/.test(url)) {
          const body = typeof args[0] === 'string' ? args[0] : ''
          this.addEventListener('loadend', () => {
            try {
              const mime = this.getResponseHeader?.('content-type') || ''
              const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : ''
              push(url, this.status, mime, text, { method: this.__dshMethod || 'GET', body })
            } catch {
              /* ignore */
            }
          })
        }
      } catch {
        /* ignore */
      }
      return rawSend.apply(this, args)
    }
  }

  const drain = () => {
    const items = captures.splice(0, captures.length)
    return items
  }

  window[KEY] = {
    version: '0.1.0',
    drain,
    tail: (n = 5) => captures.slice(-n),
    size: () => captures.length,
  }

  // 让宿主/页面侧可以「借」页面自己的身份发一次请求（真签名、真 cookie，只用于诊断和取数据）
  const pageFetch = async ({ url, credentials = 'include', method = 'GET', body, headers, full = false, maxChars = 400000 } = {}) => {
    if (!url) return { error: '缺 url' }
    try {
      const res = await rawFetch.call(window, url, {
        method,
        credentials,
        body,
        headers: headers || undefined,
        cache: 'no-store',
      })
      const text = await res.text()
      return {
        status: res.status,
        len: text.length,
        head: text.slice(0, 200),
        text: full ? text.slice(0, maxChars) : undefined,
        forbidCode: res.headers.get('x-forbid-code') || '',
        forbidReason: res.headers.get('x-forbid-reason') || '',
        contentType: res.headers.get('content-type') || '',
      }
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) }
    }
  }

  // 与 content script（ISOLATED world）通信：它要数据就往这里要
  window.addEventListener('message', async (event) => {
    const data = event.data
    if (!data || data.__dsh !== 'req' || event.source !== window) return
    let payload
    try {
      if (data.op === 'drain') payload = drain()
      else if (data.op === 'tail') payload = captures.slice(-(data.n || 5))
      else if (data.op === 'size') payload = captures.length
      else if (data.op === 'fetch') payload = await pageFetch(data.args || {})
      else if (data.op === 'reset') {
        captures.length = 0
        payload = 0
      } else payload = { error: `不认识的操作：${data.op}` }
    } catch (error) {
      payload = { error: String(error && error.message ? error.message : error) }
    }
    window.postMessage({ __dsh: 'res', id: data.id, payload }, '*')
  })
})()
