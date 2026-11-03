/**
 * 后台：只做「搬运」——从 DSH 那边接命令（长轮询），转给美团页面的 content script，
 * 再把结果送回去。它不伪造请求、不改页面代码，所有网络数据都是页面自己发的。
 *
 * 配置：chrome.storage.local 里的 { host, token }
 *   host  默认 http://127.0.0.1:45321
 *   token 在 DSH 插件的数据目录 data/bridge.json 里，复制过来即可
 */

const DEFAULT_HOST = 'http://127.0.0.1:45321'
// 默认 token 与 DSH 插件 data/bridge.json 里的一致；换机器/重装时会变，可在扩展设置里改
const DEFAULT_TOKEN = '02ee7aa91bef7be129e3a3d5'
const HOME = 'https://h5.waimai.meituan.com/waimai/mindex/home'
// 支持两个平台：美团外卖 h5 / 京东秒送（京东到家聚合频道）
const SITE_PATTERNS = [
  'https://h5.waimai.meituan.com/*',
  'https://hour.jd.com/*',
  'https://*.jd.com/*',
  'https://*.jddj.com/*',
]
const MEITUAN_PATTERNS = SITE_PATTERNS
const ALLOWED_PAGE = /^https:\/\/(h5\.waimai\.meituan\.com|([a-z0-9-]+\.)*(jd|jddj)\.com)\//i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let config = { host: DEFAULT_HOST, token: DEFAULT_TOKEN }
let polling = false
let lastSeen = 0

const loadConfig = async () => {
  const saved = await chrome.storage.local.get(['host', 'token'])
  config = {
    host: (saved.host || DEFAULT_HOST).replace(/\/$/, ''),
    token: saved.token || DEFAULT_TOKEN,
  }
  return config
}

/**
 * 配对：DSH 那边的 token 是每次安装随机生成的，扩展默认不知道。
 * 先问 /bridge/pair（这个口只认扩展来的请求），拿到 token 存进 chrome.storage。
 */
const pair = async () => {
  try {
    const response = await fetch(`${config.host}/bridge/pair`, {
      cache: 'no-store',
      headers: { 'x-bridge-client': 'dsh-meituan-extension' },
    })
    if (!response.ok) return null
    const payload = await response.json()
    if (!payload?.token) return null
    config = { ...config, token: String(payload.token), port: payload.port }
    await chrome.storage.local.set({ host: config.host, token: config.token })
    setBadge('pair', '#16a34a')
    return config.token
  } catch {
    return null
  }
}

const setBadge = (text, color = '#2b7fff') => {
  try {
    chrome.action.setBadgeText({ text: String(text || '') })
    chrome.action.setBadgeBackgroundColor({ color })
  } catch {
    /* ignore */
  }
}

async function findTab() {
  const tabs = await chrome.tabs.query({ url: MEITUAN_PATTERNS })
  return tabs.find((t) => t.active) || tabs[0] || null
}

async function waitComplete(tabId, timeoutMs = 25000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab && tab.status === 'complete') return tab
    await sleep(400)
  }
  return chrome.tabs.get(tabId).catch(() => null)
}

async function ensureTab(url, { active = true } = {}) {
  let tab = await findTab()
  if (!tab) {
    tab = await chrome.tabs.create({ url: url || HOME, active })
    await waitComplete(tab.id)
    await sleep(1200)
    return chrome.tabs.get(tab.id)
  }
  if (url && url !== tab.url) {
    await chrome.tabs.update(tab.id, { url })
    await waitComplete(tab.id)
    await sleep(1200)
    return chrome.tabs.get(tab.id)
  }
  if (active && !tab.active) await chrome.tabs.update(tab.id, { active: true })
  return tab
}

/** 给页面发消息；页面还没注入脚本时（扩展刚装/老标签页）现场补注入再发 */
async function sendToPage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch (error) {
    await chrome.scripting
      .executeScript({ target: { tabId }, files: ['inject.js'], world: 'MAIN' })
      .catch(() => {})
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {})
    await sleep(600)
    return chrome.tabs.sendMessage(tabId, message)
  }
}

async function resetIdentity() {
  // ① 删掉所有 *.meituan.com / *.dianping.com 的 cookie（这就是风控认「设备身份」的那套）
  const all = await chrome.cookies.getAll({}).catch(() => [])
  const targets = all.filter((c) => /(^|\.)(meituan\.com|dianping\.com|jd\.com|jddj\.com|360buyimg\.com)$/.test(String(c.domain || '').replace(/^\./, '.')) || /meituan\.com$|dianping\.com$|jd\.com$|jddj\.com$/.test(String(c.domain || '')))
  let removed = 0
  for (const cookie of targets) {
    const scheme = cookie.secure ? 'https' : 'http'
    const host = String(cookie.domain || '').replace(/^\./, '')
    const url = `${scheme}://${host}${cookie.path || '/'}`
    const done = await chrome.cookies
      .remove({ url, name: cookie.name, storeId: cookie.storeId })
      .catch(() => null)
    if (done) removed += 1
  }

  // ② 清站点存储（localStorage / IndexedDB / 缓存），这部分要 browsingData 权限
  const origins = [
    'https://h5.waimai.meituan.com',
    'https://i.waimai.meituan.com',
    'https://waimai.meituan.com',
    'https://verify.meituan.com',
    'https://www.meituan.com',
  ]
  let storage = 'skipped'
  if (chrome.browsingData) {
    storage = await chrome.browsingData
      .remove({ origins }, { cache: true, localStorage: true, indexedDB: true, serviceWorkers: true })
      .then(() => 'ok')
      .catch((error) => String(error?.message || error))
  }
  return {
    ok: true,
    removedCookies: removed,
    seenCookies: all.length,
    storage,
    note: '已清掉美团的设备身份（cookie + 站点存储）；需要重新登录',
  }
}

// 用 chrome.debugger 往页面里打「真」输入事件（isTrusted=true），跟人手点的一样
const attached = new Set()
let rewriteState = null

const rewriteBodyText = (postData, latitude, longitude) => {
  if (!postData) return null
  let text = postData
  let changed = false
  for (const [key, value] of [
    ['lat', latitude],
    ['lng', longitude],
    ['realTimeLat', latitude],
    ['realTimeLng', longitude],
  ]) {
    const re = new RegExp(`(${key}=)([0-9.]+)`, 'g')
    if (re.test(text)) {
      text = text.replace(new RegExp(`(${key}=)([0-9.]+)`, 'g'), `$1${value}`)
      changed = true
    }
  }
  return changed ? text : null
}

/** 京东的 feed 是把 JSON 塞进查询串的 body= 里（GET），所以坐标要从 URL 上改 */
const rewriteUrlCoords = (rawUrl, latitude, longitude) => {
  if (!rawUrl || !rawUrl.includes('body=')) return null
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const raw = url.searchParams.get('body')
  if (!raw) return null
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  const walk = (node) => {
    let touched = false
    if (!node || typeof node !== 'object') return false
    for (const key of ['lat', 'lng', 'realTimeLat', 'realTimeLng']) {
      if (Object.prototype.hasOwnProperty.call(node, key) && typeof node[key] === 'number') {
        node[key] = key === 'lat' || key === 'realTimeLat' ? latitude : longitude
        touched = true
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object' && walk(value)) touched = true
    }
    return touched
  }
  if (!walk(body)) return null
  url.searchParams.set('body', JSON.stringify(body))
  return url.toString()
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!rewriteState || source.tabId !== rewriteState.tabId) return
  if (method !== 'Fetch.requestPaused') return
  const { requestId, request } = params || {}
  if (!requestId) return
  const latitude = rewriteState.latitude.toFixed(6)
  const longitude = rewriteState.longitude.toFixed(6)
  const body = rewriteBodyText(request?.postData, latitude, longitude)
  const nextUrl = body ? null : rewriteUrlCoords(request?.url, rewriteState.latitude, rewriteState.longitude)
  if (body) {
    chrome.debugger
      .sendCommand({ tabId: source.tabId }, 'Fetch.continueRequest', { requestId, postData: body })
      .then(() => {
        rewriteState.count += 1
      })
      .catch(() => {})
    return
  }
  if (nextUrl) {
    chrome.debugger
      .sendCommand({ tabId: source.tabId }, 'Fetch.continueRequest', { requestId, url: nextUrl })
      .then(() => {
        rewriteState.count += 1
      })
      .catch(() => {})
    return
  }
  chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.continueRequest', { requestId }).catch(() => {})
})

async function ensureDebugger(tabId) {
  if (attached.has(tabId)) return { ok: true }
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    attached.add(tabId)
    return { ok: true }
  } catch (error) {
    const message = String(error?.message || error)
    if (/Another debugger|already attached/i.test(message)) {
      attached.add(tabId)
      return { ok: true }
    }
    return { ok: false, reason: `调试接口没开起来：${message}（在 edge://extensions 里把「DSH 点餐桥」重新加载一次可以授权）` }
  }
}

async function realInput(tabId, command) {
  const op = command.op
  if (op === 'detach') {
    if (attached.has(tabId)) {
      await chrome.debugger.detach({ tabId }).catch(() => {})
      attached.delete(tabId)
    }
    return { ok: true, detached: true }
  }
  const ready = await ensureDebugger(tabId)
  if (!ready.ok) return ready
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const send = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params)
  const x = Math.round(Number(command.x) || 0)
  const y = Math.round(Number(command.y) || 0)

  if (op === 'realMove') {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
    return { ok: true, moved: { x, y } }
  }

  if (op === 'realType') {
    const text = String(command.text || '')
    for (const char of text) {
      await send('Input.dispatchKeyEvent', { type: 'char', text: char })
      await sleep(40 + Math.random() * 60)
    }
    return { ok: true, typed: text.length, target: command.selector || '' }
  }

  // realClick：挪过去 → 停一下 → 按下 → 停一下 → 抬起（带随机抖动，像人手）
  const jitter = () => Math.round((Math.random() - 0.5) * 3)
  if (op === 'realTap' || command.touch) {
    // 京东/Taro 的移动端页面监听的是触摸事件，鼠标事件它不认——所以先开触摸模拟再点
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {})
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }).catch(() => {})
    const point = [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }]
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point })
    await sleep(60 + Math.random() * 90)
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(command.verifyMs ? Number(command.verifyMs) : 700)
    const info = await send('Runtime.evaluate', {
      expression: `(() => { const el = document.elementFromPoint(${x}, ${y}); return JSON.stringify({ href: location.href, tag: el && el.tagName, text: el && (el.innerText || '').slice(0, 40) }) })()`,
      returnByValue: true,
    }).catch(() => null)
    return { ok: true, tapped: { x, y }, after: info?.result?.value || null }
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + jitter(), y: y + jitter(), button: 'none', clickCount: 0 })
  await sleep(120 + Math.random() * 160)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(60 + Math.random() * 90)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(command.verifyMs ? Number(command.verifyMs) : 700)
  const info = await send('Runtime.evaluate', {
    expression: `(() => { const el = document.elementFromPoint(${x}, ${y}); return JSON.stringify({ href: location.href, tag: el && el.tagName, cls: el && String(el.className || '').slice(0, 60), text: el && (el.innerText || '').slice(0, 40) }) })()`,
    returnByValue: true,
  }).catch(() => null)
  return { ok: true, clicked: { x, y }, after: info?.result?.value || null }
}

async function runCommand(command) {
  const op = command.op
  if (op === 'open' || op === 'goto') {
    const tab = await ensureTab(command.url || HOME, { active: command.active !== false })
    const info = await sendToPage(tab.id, { op: 'ping' }).catch((error) => ({ ok: false, reason: String(error?.message || error) }))
    return { ok: Boolean(info?.ok), href: tab.url, tabId: tab.id, ping: info }
  }
  if (op === 'apiGet') {
    // 用扩展自己的身份往京东/美团接口发一次 GET（带 cookie）。用于「换个坐标查数据」这类只读查询。
    if (!command.url) return { ok: false, reason: 'apiGet 需要 url' }
    try {
      const res = await fetch(command.url, {
        method: command.method || 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: command.headers || undefined,
      })
      const text = await res.text()
      const maxChars = Number(command.maxChars) || 300000
      return { ok: true, status: res.status, len: text.length, text: text.slice(0, maxChars), truncated: text.length > maxChars }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) }
    }
  }
  if (op === 'rewriteStatus') {
    return {
      ok: true,
      active: Boolean(rewriteState),
      count: rewriteState?.count || 0,
      latitude: rewriteState?.latitude ?? null,
      longitude: rewriteState?.longitude ?? null,
      msLeft: rewriteState ? Math.max(0, rewriteState.until - Date.now()) : 0,
    }
  }
  if (op === 'rewrite') {
    // 在「请求真正发出去之前」把 lat/lng 换成指定坐标：页面自己发请求、自己带 cookie 和签名，
    // 我们只改坐标，既不伪造身份也不碰账号。
    const tab = (await findTab()) || (await ensureTab(command.tabUrl || '', { active: false }))
    if (!tab?.id) return { ok: false, reason: '没有可用的页面' }
    const ready = await ensureDebugger(tab.id)
    if (!ready.ok) return ready
    const latitude = Number(command.latitude)
    const longitude = Number(command.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { ok: false, reason: 'rewrite 需要 latitude/longitude' }
    const ms = Math.min(Math.max(Number(command.ms) || 20000, 3000), 120000)
    rewriteState = { tabId: tab.id, latitude, longitude, count: 0, until: Date.now() + ms }
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.enable', {
      patterns: [{ urlPattern: '*api.m.jd.com*', requestStage: 'Request' }],
    })
    setTimeout(() => {
      if (rewriteState && rewriteState.tabId === tab.id) {
        chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.disable', {}).catch(() => {})
        rewriteState = null
      }
    }, ms)
    return { ok: true, rewrite: { latitude, longitude, ms } }
  }
  if (op === 'geo') {
    // 把浏览器对「这个站点」报告的位置改成指定坐标，页面自己算出来的 lat/lng 就跟着变
    const tab = (await findTab()) || (await ensureTab(command.tabUrl || '', { active: false }))
    if (!tab?.id) return { ok: false, reason: '没有可用的页面' }
    const ready = await ensureDebugger(tab.id)
    if (!ready.ok) return ready
    const send = (method, params) => chrome.debugger.sendCommand({ tabId: tab.id }, method, params)
    const latitude = Number(command.latitude)
    const longitude = Number(command.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { ok: false, reason: 'geo 需要 latitude/longitude' }
    await send('Browser.grantPermissions', {
      origin: 'https://hour.jd.com',
      permissions: ['geolocation'],
    }).catch(() => {})
    const res = await send('Emulation.setGeolocationOverride', {
      latitude,
      longitude,
      accuracy: Number(command.accuracy) || 25,
    }).catch((error) => ({ error: String(error?.message || error) }))
    return { ok: true, geo: { latitude, longitude }, res }
  }
  if (op === 'apiFetch') {
    // 在「当前这个受支持的页面」里就地发一次请求（带页面自己的 cookie / mtgsig / eid），
    // 但**不跳转**：命令里用 apiUrl 传目标地址，避免被当成要导航的 url。
    const tab = (await findTab()) || (await ensureTab(command.tabUrl || '', { active: false }))
    if (!tab?.id) return { ok: false, reason: '没有可用的页面' }
    return sendToPage(tab.id, {
      op: 'pageFetch',
      url: command.apiUrl || '',
      method: command.method || 'GET',
      body: command.body || '',
      headers: command.headers || null,
      full: command.full !== false,
      maxChars: command.maxChars || 400000,
    })
  }
  if (op === 'inject') {
    // 诊断用：强制把脚本注入当前页，并把注入结果 / ping 结果原样报回来
    const tab = (await findTab()) || (await ensureTab(command.tabUrl || '', { active: false }))
    if (!tab?.id) return { ok: false, reason: '没有可用的页面' }
    const out = { tabId: tab.id, href: tab.url, status: tab.status }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['inject.js'], world: 'MAIN' })
      out.main = 'ok'
    } catch (error) {
      out.main = String(error?.message || error)
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
      out.isolated = 'ok'
    } catch (error) {
      out.isolated = String(error?.message || error)
    }
    try {
      out.ping = await chrome.tabs.sendMessage(tab.id, { op: 'ping' })
    } catch (error) {
      out.ping = { err: String(error?.message || error) }
    }
    return { ok: true, ...out }
  }
  if (op === 'cookiesFull') {
    const all = await chrome.cookies.getAll({}).catch(() => [])
    const list = all
      .filter((c) => /jd\.com$|jddj\.com$/.test(String(c.domain || '').replace(/^\./, '')))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      }))
    return { ok: true, count: list.length, cookies: list }
  }
  if (op === 'cookies') {
    const all = await chrome.cookies.getAll({}).catch(() => [])
    const mine = all
      .filter((c) => /meituan\.com|dianping\.com|jd\.com|jddj\.com/.test(String(c.domain || '')))
      .map((c) => ({ name: c.name, domain: c.domain, secure: c.secure }))
    return {
      ok: true,
      total: all.length,
      meituan: mine.length,
      names: mine.map((c) => c.name),
      hasAuth: mine.some((c) => /^(token|userId|w_token|mt_c_token)$/i.test(c.name)),
    }
  }
  if (op === 'resetIdentity') {
    const result = await resetIdentity()
    const tab = await findTab()
    if (tab) await chrome.tabs.reload(tab.id).catch(() => {})
    return result
  }
  if (op === 'tabs') {
    const tabs = await chrome.tabs.query({ url: MEITUAN_PATTERNS })
    return { ok: true, tabs: tabs.map((t) => ({ id: t.id, href: t.url, active: t.active, status: t.status })) }
  }
  if (op === 'activate') {
    const tab = await findTab()
    if (!tab) return { ok: false, reason: '没有美团标签页' }
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    return { ok: true, href: tab.url }
  }
  // 真·鼠标点击：走 chrome.debugger 的 Input.dispatchMouseEvent，产生 isTrusted 事件
  // （页面自己派发的事件，京东这类站点的关键按钮会忽略，所以必须用这一条）
  if (op === 'realClick' || op === 'realTap' || op === 'realMove' || op === 'realType' || op === 'detach') {
    const tab = (await findTab()) || (await ensureTab(command.url || '', { active: false }))
    if (!tab?.id) return { ok: false, reason: '没有可点的标签页' }
    return realInput(tab.id, command)
  }

  const tab = await ensureTab(command.url || '', { active: false })
  if (!tab) return { ok: false, reason: '没有可用的页面' }
  if (tab.url && !ALLOWED_PAGE.test(tab.url)) {
    return { ok: false, reason: `当前标签页不是受支持的页面：${tab.url}` }
  }
  return sendToPage(tab.id, command)
}

async function postResult(id, result) {
  try {
    await fetch(`${config.host}/bridge/result?token=${encodeURIComponent(config.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, result }),
    })
  } catch {
    /* DSH 没开着就算了 */
  }
}

async function loop() {
  if (polling) return
  polling = true
  await loadConfig()
  while (polling) {
    try {
      // 给长轮询加超时：否则一旦有一次请求挂住，整个循环就永远卡死（之前就是这样失联的）
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 40000)
      const response = await fetch(
        `${config.host}/bridge/poll?token=${encodeURIComponent(config.token)}&wait=25000`,
        { cache: 'no-store', signal: controller.signal },
      ).finally(() => clearTimeout(timer))
      if (response.status === 204) continue
      if (response.status === 401) {
        setBadge('token', '#ff4d4f')
        const fresh = await pair()
        if (fresh) {
          setBadge('●')
          continue
        }
        await sleep(5000)
        continue
      }
      if (!response.ok) {
        setBadge('?', '#ff4d4f')
        await sleep(3000)
        continue
      }
      const payload = await response.json()
      if (!payload || !payload.id || !payload.op) continue
      lastSeen = Date.now()
      setBadge('●')
      let result
      try {
        result = await runCommand(payload)
      } catch (error) {
        result = { ok: false, reason: String(error?.message || error) }
      }
      await postResult(payload.id, result)
    } catch {
      setBadge('off', '#999999')
      await sleep(2500)
      await loadConfig()
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  loop()
})
chrome.runtime.onStartup.addListener(() => {
  loop()
})
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => {
  // 看门狗：90 秒没收到任何命令就强制重启轮询（防止某次请求挂死后永久失联）
  if (!lastSeen || Date.now() - lastSeen > 90_000) {
    polling = false
    loop()
    return
  }
  if (!polling) loop()
})
chrome.action.onClicked.addListener(async () => {
  const tab = await findTab()
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
  } else {
    await chrome.tabs.create({ url: HOME })
  }
})
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.op === 'page-ready') {
    setBadge('●')
    sendResponse({ ok: true })
    return false
  }
  if (message?.op === 'setConfig') {
    chrome.storage.local
      .set({ host: message.host, token: message.token })
      .then(() => loadConfig())
      .then((cfg) => sendResponse({ ok: true, config: cfg }))
    return true
  }
  if (message?.op === 'state') {
    sendResponse({ ok: true, config, polling, lastSeen })
    return false
  }
  // 页面脚本问「桥在哪」：直接给内置地址，省得手动配
  if (message?.op === 'bridge-info') {
    sendResponse({ ok: true, host: DEFAULT_HOST, token: DEFAULT_TOKEN, version: chrome.runtime.getManifest().version })
    return false
  }
  return false
})

loop()
