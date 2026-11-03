/**
 * 跑在隔离环境里，负责「在你本人的浏览器里动手」：
 * 找元素、像人一样点、输入、滚动、等页面、把页面自己抓到的接口数据取回来。
 * 所有动作都用真实事件（pointer/mouse/key），并且带随机延时与随机落点。
 */
const KEY = '__DSH_MEITUAN__'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (a, b) => a + Math.random() * (b - a)

let reqId = 0
const mainWorld = (op, extra = {}, timeoutMs = 8000) =>
  new Promise((resolve) => {
    const id = ++reqId
    const onMessage = (event) => {
      const data = event.data
      if (!data || data.__dsh !== 'res' || data.id !== id) return
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(data.payload)
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      resolve({ error: '页面脚本没响应（可能还没注入）' })
    }, timeoutMs)
    window.addEventListener('message', onMessage)
    window.postMessage({ __dsh: 'req', op, id, ...extra }, '*')
  })

const boxOf = (el) => {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}

const visible = (el) => {
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return false
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05
}

// 京东用的是 React Native Web（满页 taro-view-core 这类自定义元素），
// 所以不能只查 div/span——一律扫全部元素再过滤。
const allVisible = () => [...document.querySelectorAll('*')].filter(visible)
const ownText = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()

const candidates = ({ text = '', selector = '', exact = false }) => {
  if (selector) return [...document.querySelectorAll(selector)].filter(visible)
  const wanted = String(text)
  // 京东是 RN-web（taro-view-core 这类自定义标签），所以查全部元素，不能只查 div/span
  return [...document.querySelectorAll('*')]
    .filter((el) => {
      if (!visible(el)) return false
      const own = (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim()
      if (!own) return false
      return exact ? own === wanted : own.includes(wanted)
    })
    .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)
}

/** 像人一样点：先滚到视野中间，鼠标分几步移过去，再按下抬起 */
async function humanClick(el) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await sleep(rand(220, 480))
  const r = el.getBoundingClientRect()
  const x = r.x + r.width * rand(0.3, 0.7)
  const y = r.y + r.height * rand(0.35, 0.65)
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0, buttons: 1 }
  const steps = 3 + Math.floor(Math.random() * 3)
  for (let i = 1; i <= steps; i += 1) {
    const mx = r.x + (x - r.x) * (i / steps) + rand(-6, 6)
    const my = r.y + (y - r.y) * (i / steps) + rand(-6, 6)
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: mx, clientY: my }))
    el.dispatchEvent(new MouseEvent('mousemove', { ...opts, clientX: mx, clientY: my }))
    await sleep(rand(18, 46))
  }
  el.dispatchEvent(new PointerEvent('pointerdown', opts))
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  await sleep(rand(55, 130))
  el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }))
  return { x: Math.round(x), y: Math.round(y) }
}

async function setInput(el, value) {
  el.focus()
  await sleep(rand(120, 260))
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter ? setter.call(el, value) : (el.value = value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await sleep(rand(80, 160))
  return el.value
}

async function waitFor({ selector = '', text = '', timeoutMs = 8000 }) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const hit = candidates({ selector, text })
    if (hit.length) return hit[0]
    await sleep(260)
  }
  return null
}

const handlers = {
  async ping() {
    return {
      ok: true,
      href: location.href,
      title: document.title,
      ready: Boolean(window[KEY]) || true,
      logged: !document.querySelector('input.iLoginComp-phone-num-input'),
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
    }
  },

  async frames({ x = null, y = null } = {}) {
    const nodes = [...document.querySelectorAll('iframe')]
    const list = nodes.map((el) => {
      const box = el.getBoundingClientRect()
      return {
        src: el.getAttribute('src') || '',
        id: el.id || '',
        cls: String(el.className || '').slice(0, 60),
        box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
      }
    })
    let atPoint = null
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const hit = document.elementFromPoint(x, y)
      const index = nodes.indexOf(hit)
      atPoint = {
        tag: hit?.tagName || '',
        cls: String(hit?.className || '').slice(0, 60),
        frameIndex: index,
        frameSrc: index >= 0 ? list[index].src : '',
      }
    }
    return { ok: true, count: list.length, frames: list, atPoint }
  },

  async text({ max = 400, full = false }) {
    const body = (document.body.innerText || '').replace(/\s+/g, ' ')
    return { ok: true, href: location.href, text: full ? body : body.slice(0, max) }
  },

  async drain() {
    const items = await mainWorld('drain')
    return { ok: true, count: Array.isArray(items) ? items.length : 0, items: items || [] }
  },

  async click({ text = '', selector = '', exact = false, index = 0, verifyMs = 600 }) {
    const list = candidates({ text, selector, exact })
    if (!list.length) return { ok: false, reason: `没找到「${text || selector}」` }
    const el = list[index]
    if (!el) return { ok: false, reason: `只有 ${list.length} 个候选，拿不到第 ${index} 个` }
    const where = await humanClick(el)
    await sleep(rand(verifyMs, verifyMs + 420))
    return { ok: true, clicked: where, label: (el.innerText || el.value || '').trim().slice(0, 30), candidates: list.length, href: location.href }
  },

  async type({ selector = '', value = '', text = '', submit = false }) {
    const el = document.querySelector(selector)
    if (!el) return { ok: false, reason: `没找到输入框 ${selector}` }
    const got = await setInput(el, value || text)
    if (submit) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
      await sleep(rand(600, 1100))
    }
    return { ok: true, value: got, href: location.href }
  },

  async scroll({ dy = 600, steps = 4 }) {
    const step = dy / Math.max(1, steps)
    for (let i = 0; i < steps; i += 1) {
      window.scrollBy(0, step + rand(-12, 12))
      await sleep(rand(160, 340))
    }
    return { ok: true, y: Math.round(window.scrollY) }
  },

  async waitFor({ selector = '', text = '', timeoutMs = 8000 }) {
    const el = await waitFor({ selector, text, timeoutMs })
    return el ? { ok: true, found: true, label: (el.innerText || '').trim().slice(0, 40), href: location.href } : { ok: false, reason: `等了 ${timeoutMs}ms 没等到` }
  },

  async rows({ selector = '', text = '', max = 40 } = {}) {
    let list = []
    if (selector) {
      list = [...document.querySelectorAll(selector)]
    } else if (text) {
      list = candidates({ text })
    } else {
      // 没给选择器：扫全部元素（含 taro-view-core 这类自定义标签），挑有文字、面积适中的
      list = allVisible()
    }
    const seen = new Set()
    const items = []
    for (const el of list.filter(visible)) {
      const t = ownText(el)
      if (!t || t.length > 160) continue
      if (seen.has(t)) continue
      seen.add(t)
      items.push({ text: t.slice(0, 160), box: boxOf(el), tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60) })
      if (items.length >= max) break
    }
    return { ok: true, count: items.length, items, href: location.href }
  },

  async links({ max = 30 } = {}) {
    const items = [...document.querySelectorAll('a[href]')]
      .filter(visible)
      .slice(0, 120)
      .map((el) => ({ text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40), href: String(el.getAttribute('href') || '').slice(0, 160) }))
      .filter((item, index, arr) => item.text && arr.findIndex((other) => other.href === item.href && other.text === item.text) === index)
      .slice(0, max)
    return { ok: true, count: items.length, items, href: location.href }
  },

  /**
   * 读写本页 localStorage / sessionStorage。
   * 用途：京东秒送的配送位置是前端自己存的（lat/lng/area），换地址只能改这里。
   */
  async store({ area = 'local', action = 'keys', key = '', value = '', match = '', max = 60 } = {}) {
    const box = area === 'session' ? window.sessionStorage : window.localStorage
    const keys = Object.keys(box)
    if (action === 'keys') {
      const list = keys
        .filter((name) => !match || new RegExp(match, 'i').test(name))
        .map((name) => {
          const raw = String(box.getItem(name) || '')
          return { key: name, size: raw.length, head: raw.slice(0, 120) }
        })
        .slice(0, max)
      return { ok: true, count: keys.length, items: list, href: location.href }
    }
    if (action === 'get') {
      const names = key ? [key] : keys.filter((name) => !match || new RegExp(match, 'i').test(name))
      const items = names
        .map((name) => ({ key: name, value: String(box.getItem(name) || '').slice(0, 4000) }))
        .filter((item) => item.value)
        .slice(0, max)
      return { ok: true, count: items.length, items, href: location.href }
    }
    if (action === 'set') {
      if (!key) return { ok: false, reason: 'set 需要 key' }
      box.setItem(key, String(value))
      return { ok: true, key, value: String(value).slice(0, 200), href: location.href }
    }
    if (action === 'remove') {
      if (!key) return { ok: false, reason: 'remove 需要 key' }
      box.removeItem(key)
      return { ok: true, removed: key }
    }
    return { ok: false, reason: `不认识的 store 动作：${action}` }
  },

  async evalJs({ expression = 'null' }) {
    // eslint-disable-next-line no-new-func
    const value = await Promise.resolve(new Function(`return (${expression})`).call(null))
    return { ok: true, value }
  },

  /** 找一个元素的位置（用来点「加号」这类没有文字的按钮） */
  async rect({ text = '', selector = '', exact = false, index = 0 } = {}) {
    const list = candidates({ text, selector, exact })
    const el = list[index]
    if (!el) return { ok: false, reason: `没找到「${text || selector}」`, count: list.length }
    return { ok: true, box: boxOf(el), label: (el.innerText || el.value || '').trim().slice(0, 40), count: list.length, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60) }
  },

  /** 视口坐标下这个点是哪个元素（点完想知道点到了啥） */
  async at({ x = 0, y = 0 } = {}) {
    const el = document.elementFromPoint(x, y)
    if (!el) return { ok: false, reason: '这个点没有元素' }
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 80),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      box: boxOf(el),
      href: location.href,
    }
  },

  /** 按视口坐标点一下（保留滚动位置，不做 scrollIntoView） */
  async clickPoint({ x = 0, y = 0, verifyMs = 700 } = {}) {
    const el = document.elementFromPoint(x, y)
    if (!el) return { ok: false, reason: '这个点没有元素' }
    const where = await humanClick(el)
    await sleep(rand(verifyMs, verifyMs + 420))
    return { ok: true, clicked: where, target: { tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), text: (el.innerText || '').trim().slice(0, 40) }, href: location.href }
  },

  /** 购物车/底栏状态：找含「去结算/起送/合计/¥」的底栏，读件数与金额 */
  async cart() {
    const nodes = allVisible()
    const bars = nodes
      .filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.height > 160 || r.width < 180) return false
        if (r.y < window.innerHeight * 0.5) return false
        const text = ownText(el)
        return Boolean(text) && /去结算|起送|购物车|合计|¥/.test(text) && text.length < 120
      })
      .map((el) => ({ box: boxOf(el), text: ownText(el).slice(0, 120) }))
      // 只要有信息量的那几层：去重后按高度从小到大，最里面那两条最有用
      .filter((item, index, arr) => arr.findIndex((other) => other.text === item.text) === index)
      .slice(0, 4)
    const checkout = nodes.find((el) => /^去结算$|^提交订单$|^去凑单|^还差/.test(ownText(el)))
    const badge = nodes
      .map((el) => ownText(el))
      .filter((text) => /^\d{1,2}$/.test(text))
      .slice(0, 6)
    return {
      ok: true,
      bars,
      badge,
      checkout: checkout ? { box: boxOf(checkout), text: ownText(checkout).slice(0, 20) } : null,
      href: location.href,
    }
  },

  /**
   * 在店铺页点一道菜。京东的菜卡是「名字 + 销量 + 价格 + 按钮」一整块，
   * 所以先按卡片定位（菜名所在的最近一个「够宽、含价格」的块），再在卡片里找加号/去抢购。
   */
  async addDish({ name = '', times = 1 } = {}) {
    if (!name) return { ok: false, reason: '缺菜名' }
    const steps = []
    const clicked = []
    const wanted = String(name).replace(/\s+/g, ' ').trim()

    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height }
    const boxArea = (r) => r.width * r.height

    const findName = () => {
      const nodes = allVisible()
      const exact = nodes.filter((el) => ownText(el) === wanted)
      const loose = nodes.filter((el) => ownText(el).includes(wanted))
      return (exact.length ? exact : loose).sort((a, b) => area(a) - area(b))[0] || null
    }

    // 菜名往上找到「菜卡」：宽度 > 60% 屏宽、高度 80~420、且里面有价格
    const findCard = (nameEl) => {
      const vw = window.innerWidth
      let node = nameEl
      for (let i = 0; i < 9; i += 1) {
        const parent = node.parentElement
        if (!parent) break
        const r = parent.getBoundingClientRect()
        if (r.width > vw * 0.55 && r.height >= 80 && r.height <= 460 && /[¥￥]/.test(ownText(parent))) return parent
        node = parent
      }
      return nameEl
    }

    const scoreButton = (el, card, nameEl) => {
      const r = el.getBoundingClientRect()
      const text = ownText(el)
      const cls = String(el.className || '')
      if (el === card || el === nameEl) return null
      if (r.width < 8 || r.height < 8) return null
      if (r.width > card.getBoundingClientRect().width * 0.8) return null
      let score = 0
      if (/^去抢购$|^加入购物车$|^选规格$|^抢购$/.test(text)) score += 6
      if (/^\+$|^加购$|^加$/.test(text)) score += 5
      if (!text && /add|plus|stepper|increase|cart/i.test(cls)) score += 4
      if (/add|plus|stepper|increase|cart/i.test(cls)) score += 1.5
      // 加号一般在卡片右侧、价位附近
      score += (r.x / Math.max(1, window.innerWidth)) * 2
      // 太高的多行文本块不是按钮
      if (r.height > 90) score -= 2
      if (text.length > 24) score -= 1.5
      return score
    }

    const findButton = (card, nameEl) => {
      const list = [...card.querySelectorAll('*')]
        .filter(visible)
        .map((el) => ({ el, score: scoreButton(el, card, nameEl) }))
        .filter((item) => item.score !== null && item.score > 0)
        .sort((a, b) => b.score - a.score)
      return list[0] || null
    }

    const barText = () => {
      const nodes = allVisible().filter((el) => {
        const r = el.getBoundingClientRect()
        return r.y > window.innerHeight * 0.45 && r.height < 180 && r.width > 180 && /去结算|起送|¥/.test(ownText(el))
      })
      return nodes.map((el) => ownText(el)).sort((a, b) => a.length - b.length)[0] || ''
    }

    for (let round = 0; round < Math.max(1, times); round += 1) {
      const nameEl = findName()
      if (!nameEl) return { ok: false, reason: '页面上没找到「' + name + '」', steps, clicked, bar: barText() }
      nameEl.scrollIntoView({ block: 'center' })
      await sleep(rand(500, 900))
      const card = findCard(nameEl)
      const before = barText()
      const button = findButton(card, nameEl)
      steps.push('卡片 ' + JSON.stringify(boxOf(card)) + ' 名字 ' + JSON.stringify(boxOf(nameEl)))
      if (!button) return { ok: false, reason: '「' + name + '」这张卡里没找到加号', steps, clicked, bar: before, card: ownText(card).slice(0, 90) }
      steps.push('点加号：' + (button.text || '(无文字)') + ' ' + JSON.stringify(button.box) + ' score=' + button.score.toFixed(2))
      const where = await humanClick(button.el)
      await sleep(rand(1000, 1600))

      // 一口价/多规格会弹面板：找面板里的「加入购物车」或「确定」
      let spec = null
      const specBtn = allVisible().find((el) => /^加入购物车$|^确定$|^加入购物车$/.test(ownText(el)))
      if (specBtn) {
        spec = { label: ownText(specBtn).slice(0, 12), box: boxOf(specBtn) }
        await humanClick(specBtn)
        await sleep(rand(1200, 1800))
        steps.push('弹了面板，点了' + spec.label)
      }
      const after = barText()
      clicked.push({ label: button.text, cls: String(button.cls || '').slice(0, 40), where, spec, before, after, round })
      if (after && after !== before) steps.push('底栏变了：' + before + ' → ' + after)
      else steps.push('底栏没变')
    }

    const dialog = allVisible()
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.y > window.innerHeight * 0.2 && r.height > 100 && r.height < window.innerHeight * 0.9 && /加入购物车|选规格|份量|规格/.test(ownText(el))
      })
      .map((el) => ownText(el).slice(0, 90))
      .slice(0, 2)
    return { ok: true, steps, clicked, bar: barText(), dialog, href: location.href }
  },

  /** 借页面自己的身份发一次请求：真 cookie、真签名，用来诊断是不是「身份」被挡 */
  async pageFetch({ url = '', credentials = 'include', method = 'GET', body = '', headers = null, full = false, maxChars = 400000 } = {}) {
    if (!url) return { ok: false, reason: '缺 url' }
    const args = { url, credentials, method, full, maxChars }
    if (body) args.body = body
    if (headers) args.headers = headers
    const res = await mainWorld('fetch', { args }, 30000)
    return { ok: Boolean(res && !res.error), ...(res || {}) }
  },
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.op]
  if (!handler) {
    sendResponse({ ok: false, reason: `不认识的操作：${message?.op}` })
    return false
  }
  Promise.resolve(handler(message))
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }))
  return true // 异步回复
})

// 让后台知道这一页就绪
chrome.runtime.sendMessage({ op: 'page-ready', href: location.href }).catch(() => {})
