// 美团外卖的「眼睛和手」：用本机 Edge/Chrome（移动端 UA）登录、翻商家、进店看菜。
// 数据不靠扒 DOM，而是直接读页面请求回来的 JSON（首页/搜索/菜单接口都带结构化字段）。
import fs from 'node:fs'
import { Browser, findBrowser } from './cdp.js'
import { addDish, cartState, clearCart, readCart } from './cart.js'
import { appDeepLink, webMenuLink } from './links.js'
import {
  chooseAddress,
  chooseTableware,
  goCheckout,
  openAddressPanel,
  readPreview,
  submitOrder,
  switchDeliveryAddress,
} from './order.js'
import { clip, num, sleep, uniqBy } from './util.js'

export const HOME = 'https://h5.waimai.meituan.com/waimai/mindex/home'
export const LOGIN = `https://h5.waimai.meituan.com/login?force=true&back_url=${encodeURIComponent(HOME)}`
const API_URL = /i\.waimai\.meituan\.com\//
const SCROLL_EXPR = `(() => {
  const scroller = document.scrollingElement || document.documentElement
  scroller.scrollTop = scroller.scrollHeight
  window.scrollTo(0, document.body.scrollHeight)
  for (const el of document.querySelectorAll('div,ul,section')) {
    if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 260) el.scrollTop = el.scrollHeight
  }
  return scroller.scrollTop
})()`

/**
 * 搜索必须是 searchresults 这条路由：`/waimai/mindex/search?keyword=` 只渲染「热门搜索」建议，
 * 不会发结果请求（实测点了也不会跳）。searchresults 带全参数才拉 /openh5/search/globalpage。
 */
export function searchUrl(keyword) {
  const kw = encodeURIComponent(keyword)
  return `https://h5.waimai.meituan.com/waimai/mindex/searchresults?queryType=11002&entranceId=0&keyword=${kw}&qwTypeId=11002&mode=1`
}

export function menuUrl(poiId) {
  return `https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=${encodeURIComponent(poiId)}`
}

/**
 * 美团的「附近」会混进药房、便利店、鲜花这些非餐饮店铺（首页 5 家里经常一大半是药房），
 * 不知道吃什么的时候这些只会干扰判断，默认滤掉；用户明确搜「药」「便利店」时再放行。
 */
const NON_FOOD =
  /药房|药店|大药房|快药|医药|医疗|口腔|诊所|便利店|超市|生鲜|果蔬|鲜花|绿植|宠物|五金|数码|手机|维修|洗衣|家政|搬家|快递|文具|母婴|眼镜|美发|洗浴|足疗|按摩|汽修/

/** 奶茶/咖啡/甜品这类店：默认挑「吃什么」时别让它们霸榜，但用户点名要就算正常候选 */
const DRINK_OR_SNACK =
  /奶茶|茶饮|果茶|柠檬茶|咖啡|饮品|果汁|糖水|冰淇淋|雪糕|冰室|甜品|蛋糕|烘焙|面包|不泡茶|茶百道|喜茶|奈雪|蜜雪|沪上阿姨|古茗|霸王茶姬|瑞幸|星巴克|库迪|挪瓦|幸运咖|酸奶|椰子/

const VERIFY_HINT =
  '美团弹了安全验证（拖滑块）。正常情况下插件会自动把浏览器窗口弹出来、等你拖完再继续；如果没弹出来（比如 150 秒没等到），去设置页「美团外卖」把「显示浏览器窗口」打开，亲手拖一次，过完再让我继续。'

/** 只有这些 cookie 才是「真的登录了」；匿名 uuid 类（_lxsdk / uuid / openh5_uuid）谁都有，不能算 */
const AUTH_RE = /^(token|wm_logintoken|wmlogintoken|wm_login_token|userid|wmuserid|wm_uid|wmUid|wmUidFlag)$/i

function verifyError(href) {
  if (href && /verify\.meituan\.com/.test(href)) return new Error(VERIFY_HINT)
  return null
}

/** 接口返回的 JSON 里套 JSON（data 是字符串），递归解出来并收集商家对象 */
function walkForShops(node, out, depth = 0) {
  if (node == null || depth > 14) return
  if (typeof node === 'string') {
    const text = node.trim()
    if (text.length > 2 && (text.startsWith('{') || text.startsWith('['))) {
      try {
        walkForShops(JSON.parse(text), out, depth + 1)
      } catch {
        /* 不是 JSON 就算了 */
      }
    }
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walkForShops(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  if (node.poi_id_str || (node.poi_name && (node.scheme || node.wm_poi_id))) {
    out.push(node)
    return
  }
  for (const value of Object.values(node)) walkForShops(value, out, depth + 1)
}

function shopsFromText(text) {
  if (!text || text.length < 20) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const out = []
  walkForShops(parsed, out, 0)
  return out
}

/** 搜索接口里每家店自带 3~5 个招牌菜（product_list），挑的时候比店名有用得多 */
function dishesOf(raw) {
  let list = raw.product_list || raw.poi_name_below_list || []
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = []
    }
  }
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.product_name || item.name || '').trim()
    if (!name || name.length > 44) continue
    out.push({ name, price: num(item.price ?? item.original_price), sales: num(item.month_sales) })
  }
  return uniqBy(out, (dish) => dish.name).slice(0, 6)
}

function normalizeShop(raw) {
  const tags = []
  for (const tag of raw.brightspot_tags || []) {
    if (tag?.text) tags.push(String(tag.text).replace(/^["“]|["”]$/g, ''))
  }
  if (raw.coupon_tag?.text) tags.push(String(raw.coupon_tag.text))
  if (raw.third_category) tags.unshift(String(raw.third_category))
  if (raw.status_desc) tags.push(String(raw.status_desc))
  const id = raw.poi_id_str || ''
  // 搜索接口的 scheme 是 meituanwaimai:// 唤起 App 的深链，用户点不开，只有 https 的才直接用
  const scheme = String(raw.scheme || '')
  return {
    id,
    name: String(raw.poi_name || raw.name || '').trim(),
    score: num(raw.wm_poi_score),
    minutes: num(raw.delivery_time_tip),
    distanceKm: num(raw.distance),
    distance: String(raw.distance || ''),
    minPrice: num(raw.min_price_tip),
    shippingFee: num(raw.shipping_fee_tip),
    avgPrice: num(raw.avg_price_tip || raw.average_price_tip),
    monthSales: num(raw.month_sales_tip),
    monthSalesText: String(raw.month_sales_tip || ''),
    deliveryTip: String(raw.delivery_time_tip || ''),
    tags: [...new Set(tags)].slice(0, 6),
    dishes: dishesOf(raw),
    pic: String(raw.poi_pic || raw.pic_url || ''),
    shareUrl: /^https?:/i.test(scheme) ? scheme : menuUrl(id),
    status: raw.status ?? null,
  }
}

/** 菜单接口里的菜品对象（不同接口字段名不一样，按特征认） */
const DISH_NAME_KEYS = ['name', 'dish_name', 'spu_name', 'food_name', 'skuname', 'sku_name']
const DISH_PRICE_KEYS = ['price', 'min_price', 'current_price', 'price_num', 'origin_price', 'activity_price']

function collectDishes(node, out, depth = 0) {
  if (node == null || depth > 14) return
  if (typeof node === 'string') {
    const text = node.trim()
    if (text.length > 2 && (text.startsWith('{') || text.startsWith('['))) {
      try {
        collectDishes(JSON.parse(text), out, depth + 1)
      } catch {
        /* ignore */
      }
    }
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectDishes(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object' || node.poi_id_str) return
  const nameKey = DISH_NAME_KEYS.find((key) => typeof node[key] === 'string' && node[key].trim().length > 1 && node[key].length < 40)
  const priceKey = DISH_PRICE_KEYS.find((key) => node[key] != null && num(node[key]) != null && num(node[key]) > 0)
  if (nameKey && priceKey && !/店$|餐厅$|食堂$/.test(node[nameKey])) {
    const spuRaw = node.id ?? node.spuId ?? node.spu_id ?? node.spuIdStr
    out.push({
      name: String(node[nameKey]).trim(),
      price: num(node[priceKey]),
      sales: num(node.month_saled_content || node.month_sales || node.sale_volume || node.saleVolume),
      desc: String(node.description || node.desc || '').slice(0, 60),
      spuId: /^\d{6,}$/.test(String(spuRaw ?? '')) ? Number(spuRaw) : 0,
    })
    return
  }
  for (const value of Object.values(node)) collectDishes(value, out, depth + 1)
}

export function dishesFromText(text) {
  if (!text || text.length < 20) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const out = []
  collectDishes(parsed, out, 0)
  return out
}

/** 按口味给店打分；理由/风险都留着，最后给模型和用户看 */
export function scoreShop(shop, taste, { keyword = '', budget = 0 } = {}) {
  const reasons = []
  const risks = []
  let score = 0

  score += (shop.score ?? 4) * 6
  score -= Math.min(shop.minutes ?? 40, 60) * 0.35
  score -= Math.min(shop.distanceKm ?? 6, 12) * 1.2
  score += Math.min((shop.monthSales ?? 0) / 500, 8)

  const dishHay = (shop.dishes || []).map((dish) => dish.name).join(' ')
  const hay = `${shop.name} ${dishHay} ${(shop.tags || []).join(' ')} ${shop.name}`
  const likes = Array.isArray(taste.likes) ? taste.likes : []
  const dislikes = Array.isArray(taste.dislikes) ? taste.dislikes : []

  for (const like of likes) {
    if (like && hay.includes(like)) {
      score += 7
      reasons.push(`有你常吃的「${like}」`)
    }
  }
  for (const bad of dislikes) {
    if (bad && hay.includes(bad)) {
      score -= 26
      risks.push(`踩到你不想要的「${bad}」`)
    }
  }
  if (keyword && hay.includes(keyword)) {
    score += 10
    reasons.push(`正好是「${keyword}」`)
  }
  if (shop.minutes && shop.minutes <= 30) {
    score += 3
    reasons.push(`${shop.minutes} 分钟就能到`)
  }
  const target = Number(budget) || Number(taste.budget) || 0
  if (target && shop.avgPrice) {
    if (shop.avgPrice <= target) {
      score += 5
      reasons.push(`人均 ¥${shop.avgPrice}，在你 ¥${target} 的预算里`)
    } else {
      score -= 9
      risks.push(`人均 ¥${shop.avgPrice}，超了 ¥${target}`)
    }
  }
  if (shop.status != null && shop.status !== 1) {
    score -= 14
    risks.push('现在可能打烊了')
  }
  if (taste.health) {
    if (/轻食|沙拉|健身|减脂|健康|蒸|汤/.test(hay)) {
      score += 5
      reasons.push('相对扛饿又不油')
    }
    if (/炸|烤|火锅|奶茶|蛋糕|烧烤/.test(hay)) risks.push('热量偏高（你在控卡）')
  }
  if (taste.spicy >= 3 && /川|湘|渝|麻辣|辣/.test(hay)) {
    score += 4
    reasons.push('够辣，对得上你的口味')
  }
  if (taste.spicy <= 0 && /川|湘|渝|麻辣|辣/.test(hay)) {
    score -= 6
    risks.push('偏辣（你说不太吃辣）')
  }

  return { score: Math.round(score * 10) / 10, reasons: reasons.slice(0, 4), risks: risks.slice(0, 3) }
}

function renderShop(shop, index, extra = {}) {
  const bits = []
  if (shop.score) bits.push(`${shop.score}分`)
  if (shop.deliveryTip) bits.push(shop.deliveryTip)
  if (shop.distance) bits.push(shop.distance)
  const priceBits = []
  if (shop.avgPrice) priceBits.push(`人均 ¥${shop.avgPrice}`)
  if (shop.minPrice) priceBits.push(`起送 ¥${shop.minPrice}`)
  if (shop.monthSalesText) priceBits.push(shop.monthSalesText)
  const lines = [`${index}. ${shop.name}  ${bits.join(' · ')}`]
  if (priceBits.length) lines.push(`   ${priceBits.join(' · ')}`)
  if (shop.tags.length) lines.push(`   标签：${shop.tags.join(' / ')}`)
  const dishes = (shop.dishes || []).slice(0, 4)
  if (dishes.length) {
    lines.push(`   招牌：${dishes.map((dish) => (dish.price ? `${dish.name} ¥${dish.price}` : dish.name)).join(' · ')}`)
  }
  const reasons = extra.reasons?.length ? extra.reasons : []
  if (reasons.length) lines.push(`   为什么：${reasons.join('；')}`)
  if (extra.risks?.length) lines.push(`   注意：${extra.risks.join('；')}`)
  if (shop.shareUrl) lines.push(`   ${shop.shareUrl}`)
  if (shop.id) lines.push(`   id：${shop.id}（加购物车要用这个）`)
  return lines.join('\n')
}

export class Meituan {
  constructor({ store, logger }) {
    this.store = store
    this.logger = logger
    this._browser = null
    this._sig = ''
    this._queue = Promise.resolve()
  }

  /** 所有动作排队执行：一个浏览器实例不能同时被两个工具调用抢 */
  run(task) {
    const next = this._queue.then(task, task)
    this._queue = next.catch(() => {})
    return next.finally(async () => {
      // 这一轮为了过滑块切成了可见窗口 → 收尾时切回无头，下次调用不弹窗
      if (!this._verifyRun) return
      this._verifyRun = false
      this.store.patchConfig({ headless: true })
      await this.stop().catch(() => {})
    })
  }

  async browser() {
    const cfg = this.store.getConfig()
    const exe = cfg.browserPath || findBrowser()
    if (!exe) throw new Error('没找到 Edge/Chrome：在设置页「美团外卖」里填浏览器路径，或装一个')
    const sig = `${exe}|${cfg.headless}|${this.store.profileDir}`
    if (this._browser && this._sig === sig && this._browser.running) return this._browser
    if (this._browser) await this._browser.stop().catch(() => {})
    this._browser = new Browser({ exe, profileDir: this.store.profileDir, headless: cfg.headless, logger: this.logger })
    this._sig = sig
    await this._browser.ensure()
    return this._browser
  }

  async stop() {
    if (this._browser) {
      await this._browser.stop().catch(() => {})
      this._browser = null
    }
  }

  /**
   * 美团风控（verify.meituan.com 拖滑块）：不报错，直接把可见窗口弹出来，
   * 等人拖完滑块再继续。过完这一轮自动恢复无头模式。
   */
  async _passVerify(rawHref) {
    const target = /verify\.meituan\.com/.test(String(rawHref || '')) ? String(rawHref) : ''
    const limit = Math.max(8, Math.min(900, Number(this.store.getConfig().verifyWaitSec) || 150))
    this._verifyRun = true
    this.store.patchConfig({ headless: false })
    this.logger?.warn?.('美团要安全验证：正在把窗口弹出来，等人拖完滑块')
    await this.stop()
    const browser = await this.browser()
    if (target) await browser.goto(target, { settleMs: 1200 }).catch(() => {})
    await browser.bringToFront().catch(() => {})
    for (let i = 1; i <= limit; i += 1) {
      await sleep(1000)
      const now = await browser.evaluate('location.href').catch(() => '')
      if (now && !/verify\.meituan\.com/.test(now)) {
        await sleep(1500)
        this.logger?.info?.(`安全验证已通过（等了 ${i} 秒），继续干活`)
        this._verifyNote = { at: new Date().toISOString(), waited: i }
        return { ok: true, waited: i, url: now }
      }
    }
    return { ok: false, reason: `等了 ${limit} 秒还没过滑块`, waited: limit }
  }

  /** 取走「刚刚弹过验证窗口」这条提示（没弹过就是空字符串） */
  takeVerifyNote() {
    if (!this._verifyNote) return ''
    const note = `（刚才美团弹了滑块验证，已经自动弹出窗口、你拖完后继续了，等了 ${this._verifyNote.waited} 秒）`
    this._verifyNote = null
    return note
  }

  /** 页面被风控拦了就地处理：能等到用户拖完就返回 null（调用方继续），否则返回错误 */
  async verifyGate(browser, href) {
    const blocked = verifyError(href)
    if (!blocked) return null
    const passed = await this._passVerify(href)
    return passed.ok ? null : blocked
  }

  /** 关掉开屏广告 / 授权提示这些挡路的浮层 */
  async dismissOverlays(browser) {
    return browser
      .evaluate(`(() => {
        const nodes = [...document.querySelectorAll('div,span,i,img')].filter((el) => {
          const cls = String(el.className || '')
          const rect = el.getBoundingClientRect()
          const size = rect.width * rect.height
          return /close|Close|icon-close|dismiss/i.test(cls) && size > 40 && size < 6400 && rect.width < 90 && rect.height < 90
        })
        if (!nodes.length) return false
        nodes[0].click()
        return true
      })()`)
      .catch(() => false)
  }

  _cookieNames(cookies) {
    return cookies.map((cookie) => cookie.name)
  }

  _looksLoggedIn(names) {
    // 只认真实登录态 cookie。历史坑：按 session.cookieNames 回填会把匿名 uuid 也当成登录凭证。
    const session = this.store.getSession()
    const marker = Array.isArray(session.cookieNames) ? session.cookieNames.filter((name) => AUTH_RE.test(name)) : []
    if (marker.length && marker.some((name) => names.includes(name))) return true
    return names.some((name) => AUTH_RE.test(name))
  }

  // ---------- 登录 ----------
  async _status({ deep = false } = {}) {
    const session = this.store.getSession()
    const running = Boolean(this._browser?.running)
    const cfg = this.store.getConfig()
    const base = {
      loggedIn: session.loggedIn,
      phone: session.phone || '',
      at: session.at || '',
      browserRunning: running,
      checked: false,
      browser: {
        exe: cfg.browserPath || findBrowser() || '',
        running,
        headless: cfg.headless,
        version: this._browser?.version || '',
      },
    }
    if (!running && !deep) return base
    try {
      const browser = await this.browser()
      const cookies = await browser.cookies()
      const names = this._cookieNames(cookies)
      base.loggedIn = this._looksLoggedIn(names)
      base.cookieHint = names.filter((name) => /token|login|uuid/i.test(name)).slice(0, 8)
      base.checked = true
      if (deep) {
        // 历史坑：不能拿「首页有没有跳到 /login」判断登录态——未登录时首页也照常打开，会误判成已登录。
        // 也不能主动跳走：用户可能正停在登录页手动登录。所以只重新读一遍 cookie。
        const href0 = await browser.evaluate('location.href').catch(() => '')
        const fresh = this._cookieNames(await browser.cookies())
        base.loggedIn = this._looksLoggedIn(fresh)
        base.cookieHint = fresh.filter((name) => AUTH_RE.test(name)).slice(0, 8)
        base.url = href0
      }
      this.store.setSession({ loggedIn: base.loggedIn })
      return base
    } catch (error) {
      base.error = clip(error?.message || error, 200)
      return base
    }
  }

  status(options) {
    return this.run(() => this._status(options))
  }

  async _loginStart(phone) {
    const digits = String(phone || '').replace(/\D/g, '')
    if (!/^1\d{10}$/.test(digits)) throw new Error(`手机号看着不对（收到「${phone || ''}」），要 11 位大陆手机号`)
    const browser = await this.browser()
    await browser.goto(LOGIN, { settleMs: 1500 })
    const hasInput = await browser.waitFor('input.iLoginComp-phone-num-input', { timeoutMs: 15000 })
    if (!hasInput) {
      const href = await browser.evaluate('location.href').catch(() => '')
      const blocked = await this.verifyGate(browser, href)
      if (blocked) throw blocked
      throw new Error(`没找到手机号输入框（当前页面 ${clip(href, 120)}），可能页面结构变了`)
    }
    const filled = await browser.evaluate(`(() => {
      const el = document.querySelector('input.iLoginComp-phone-num-input')
      if (!el) return { ok: false }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      el.focus()
      setter.call(el, ${JSON.stringify(digits)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: el.value }
    })()`)
    if (!filled?.ok) throw new Error('手机号填不进去，页面可能改了')
    await sleep(350)
    const clicked = await browser.evaluate(`(() => {
      const want = '发送验证码'
      const nodes = [...document.querySelectorAll('span,div,button,a')].filter((el) => (el.innerText || '').trim() === want)
      if (!nodes.length) return { ok: false, reason: '按钮没找到' }
      nodes.sort((a, b) => a.children.length - b.children.length)
      nodes[0].click()
      return { ok: true }
    })()`)
    await sleep(1500)
    const pageText = await browser.evaluate('document.body ? document.body.innerText.slice(0, 300) : ""').catch(() => '')
    this.store.setSession({ phone: digits, loggedIn: false })
    return {
      phone: digits,
      filled: filled.value,
      clicked: Boolean(clicked?.ok),
      pageText: clip(String(pageText).replace(/\s+/g, ' '), 160),
    }
  }

  loginStart(phone) {
    return this.run(() => this._loginStart(phone))
  }

  async _loginVerify(code) {
    const digits = String(code || '').replace(/\D/g, '')
    if (digits.length < 4) throw new Error('验证码不对，应该是 4~6 位数字')
    const browser = await this.browser()
    const before = new Set(this._cookieNames(await browser.cookies()))
    const agreed = await browser.evaluate(`(() => {
      const box = document.querySelector('input.checkbox') || document.querySelector('input[type=checkbox]')
      if (!box) return 'no-checkbox'
      if (!box.checked) box.click()
      return box.checked ? 'checked' : 'still-unchecked'
    })()`)
    const filled = await browser.evaluate(`(() => {
      const el = document.querySelector('input.iLoginComp-code-input')
      if (!el) return { ok: false }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      el.focus()
      setter.call(el, ${JSON.stringify(digits)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: el.value }
    })()`)
    if (!filled?.ok) throw new Error('验证码填不进去（可能不在登录页）：先调 meituan_login 的 send 发验证码')
    await sleep(300)
    const clicked = await browser
      .evaluate(`(() => {
        const btn = document.querySelector('button.iLoginComp-login-btn-wrapper') || document.querySelector('.iLoginComp-login-btn-wrapper')
        if (!btn) return { ok: false }
        btn.click()
        return { ok: true }
      })()`)
      .catch(() => ({ ok: false }))

    let href = ''
    for (let i = 0; i < 24; i += 1) {
      await sleep(600)
      href = await browser.evaluate('location.href').catch(() => '')
      if (href && !/\/login/.test(href)) break
    }
    const cookies = await browser.cookies()
    const names = this._cookieNames(cookies)
    const added = names.filter((name) => !before.has(name))
    const verified = Boolean(verifyError(href))
    const loggedIn = Boolean(href) && !/\/login/.test(href) && !verified
    if (loggedIn) {
      const authNames = names.filter((name) => AUTH_RE.test(name))
      this.store.setSession({ loggedIn: true, at: new Date().toISOString(), cookieNames: authNames })
    }
    return {
      ok: loggedIn,
      url: clip(href, 160),
      agreed,
      clicked: Boolean(clicked?.ok),
      newCookies: added.slice(0, 10),
      hint: loggedIn
        ? '登录成功，浏览器资料目录已保存，下次不用再登。'
        : verified
          ? VERIFY_HINT
          : '没登进去：可能验证码过期/被风控拦了。可以再发一次验证码，或把「显示浏览器窗口」打开手动看一眼。',
    }
  }

  loginVerify(code) {
    return this.run(() => this._loginVerify(code))
  }

  // 把浏览器切成可见窗口并停在登录页，让用户自己输手机号/验证码
  async openLogin() {
    return this.run(async () => {
      this.store.patchConfig({ headless: false })
      await this.stop()
      const browser = await this.browser()
      await browser.goto(LOGIN, { settleMs: 1200 })
      const hasInput = await browser.waitFor('input.iLoginComp-phone-num-input', { timeoutMs: 15000 }).catch(() => false)
      const href = await browser.evaluate('location.href').catch(() => '')
      return { ok: true, hasInput, url: clip(href, 160), config: this.store.getConfig() }
    })
  }

  async logout() {
    return this.run(async () => {
      await this.stop()
      try {
        fs.rmSync(this.store.profileDir, { recursive: true, force: true })
      } catch (error) {
        this.logger?.warn?.(`清浏览器资料失败：${error?.message || error}`)
      }
      this.store.clearSession()
      return { ok: true }
    })
  }

  // ---------- 送餐地点（地址簿） ----------
  /** 读美团地址簿，设置页用它做「送餐地点」下拉 */
  async _addresses() {
    const browser = await this.browser()
    const tap = await browser.tap(/openh5\/address\/list/, { limit: 5 })
    try {
      await browser.goto(HOME, { settleMs: 1500 })
      const deadline = Date.now() + 14000
      let list = []
      while (Date.now() < deadline) {
        await sleep(500)
        for (const item of tap.items) {
          if (!/address\/list/.test(item.url || '')) continue
          try {
            const parsed = JSON.parse(String(item.text || ''))
            const raw = parsed?.data?.list
            if (Array.isArray(raw) && raw.length) list = raw
          } catch {}
        }
        if (list.length) break
      }
      const href = await browser.evaluate('location.href').catch(() => '')
      if (!list.length) {
        const blocked = await this.verifyGate(browser, href)
        if (blocked) throw blocked
        if (!this.store.getSession().loggedIn) throw new Error('要先登录，才能读你自己在美团里的收货地址')
        if (this._blockedByRisk(tap.items)) throw new Error('美团这会儿没返回地址（接口被限流了），等 10~30 分钟再试')
        throw new Error('没读到地址簿：页面没发地址请求，可能还没登录或页面改版了')
      }
      const rows = list.map((row) => ({
        id: String(row.addressId ?? ''),
        name: String(row.poi || row.houseNumber || row.address || ''),
        detail: String(row.houseNumber || row.address || ''),
        phone: String(row.phone || ''),
        tag: row.isDefault ? '默认' : '',
        outOfRange: Boolean(row.isOutOfRange),
      }))
      const want = String(this.store.getConfig().address || '').trim()
      const current =
        rows.find((row) => want && (row.name.includes(want) || want.includes(row.name))) ||
        rows.find((row) => row.tag === '默认') ||
        null
      return { ok: true, count: rows.length, rows, address: want, current }
    } finally {
      tap.stop()
    }
  }

  listAddresses(options = {}) {
    return this.run(() => this._addresses(options))
  }

  /** 设置的「送餐地点」和当前商圈不一致时先切过去（同一个进程里只切一次，省时间也少惹风控） */
  async _ensureAoi(browser) {
    const want = String(this.store.getConfig().address || '').trim()
    if (!want || this._aoi === want) return null
    if (!this.store.getSession().loggedIn) return null
    const switched = await switchDeliveryAddress(browser, want).catch((error) => ({
      ok: false,
      reason: clip(error?.message || error, 160),
    }))
    if (switched?.ok) this._aoi = want
    return switched
  }

  // ---------- 商家列表 ----------
  async _listShops({ keyword = '', limit, scrolls } = {}) {
    const cfg = this.store.getConfig()
    const browser = await this.browser()
    // 设置里配了「送餐地点」就先切商圈，否则拉回来的是别处的店
    const switched = await this._ensureAoi(browser)
    const target = keyword ? searchUrl(keyword) : HOME
    const tap = await browser.tap(API_URL, { limit: 90 })
    try {
      await browser.goto(target, { settleMs: 600 })
      const deadline = Date.now() + 22000
      let href = ''
      let shops = []
      while (Date.now() < deadline) {
        await sleep(600)
        shops = this._shopsFromItems(tap.items, keyword)
        if (shops.length >= 3) break
        href = await browser.evaluate('location.href').catch(() => '')
        const blocked = await this.verifyGate(browser, href)
        if (blocked) throw blocked
        if (/\/login/.test(href)) throw new Error('美团要求登录：先用 meituan_login 发验证码登录，再让我挑')
      }
      await this.dismissOverlays(browser)
      if (shops.length < 3) {
        // 首页推荐每次刷新换一批，再刷一次常常能多拿几家（tap 里是累计的，不会丢前面的）
        await browser.goto(target, { settleMs: 2500 })
        await sleep(2000)
        const more = this._shopsFromItems(tap.items, keyword)
        if (more.length > shops.length) shops = more
      }
      const rounds = Number.isFinite(scrolls) ? scrolls : cfg.scrolls
      let previous = shops.length
      for (let i = 0; i < rounds; i += 1) {
        await browser.evaluate(SCROLL_EXPR).catch(() => {})
        await sleep(1600)
        const current = this._shopsFromItems(tap.items, keyword)
        const grew = current.length > previous
        shops = current
        if (!grew) break
        previous = current.length
      }
      shops = this._shopsFromItems(tap.items, keyword)
      href = await browser.evaluate('location.href').catch(() => '')
      const blocked = await this.verifyGate(browser, href)
      if (blocked) throw blocked
      if (!shops.length && /\/login/.test(href)) throw new Error('美团要求登录：先用 meituan_login 发验证码登录')
      if (!shops.length && this._blockedByRisk(tap.items)) {
        throw new Error(
          '美团把这个账号的数据接口临时挡了（接口 403，多半是自动化太频繁被限流）。这不是代码坏了：等 10~30 分钟别刷，再让我试；期间可以先用手机 App 正常下单。',
        )
      }
      const cap = Math.max(1, Math.min(40, Number(limit) || cfg.limit))
      return { shops: shops.slice(0, cap), total: shops.length, keyword, url: clip(href, 160), address: this._aoi || '', switched }
    } finally {
      tap.stop()
    }
  }

  /** 接口被风控挡了（403 / 直接回一句「网络不给力」）：遇到这种情况给用户一句人话，别说是「代码坏了」 */
  _blockedByRisk(items) {
    let sees403 = false
    for (const item of items || []) {
      if (Number(item?.status) === 403) sees403 = true
      const text = String(item?.text || '')
      if (/您的网络好像不太给力|出现点问题，请稍后再试/.test(text)) sees403 = true
    }
    return sees403
  }

  _shopsFromItems(items, keyword = '') {
    const raw = []
    for (const item of items) {
      if (!/json|text/i.test(item.mime || '')) continue
      raw.push(...shopsFromText(item.text))
    }
    let shops = uniqBy(raw.map(normalizeShop).filter((shop) => shop.id && shop.name), (shop) => shop.id)
    const minScore = Number(this.store.getConfig().minScore) || 0
    if (minScore) shops = shops.filter((shop) => (shop.score ?? 5) >= minScore)
    const hay = (shop) => `${shop.name} ${(shop.tags || []).join(' ')}`
    if (!NON_FOOD.test(keyword)) shops = shops.filter((shop) => !NON_FOOD.test(hay(shop)))
    // 只想要奶茶/甜品时不过滤，其余「吃什么」场景把饮品甜点店排掉
    if (!NON_FOOD.test(keyword) && !DRINK_OR_SNACK.test(keyword)) {
      shops = shops.filter((shop) => !DRINK_OR_SNACK.test(hay(shop)))
    }
    return shops
  }

  listShops(options) {
    return this.run(() => this._listShops(options))
  }

  // ---------- 按口味挑 ----------
  async _pick({ keyword = '', budget, count = 3, limit } = {}) {
    const taste = this.store.getTaste()
    const cfg = this.store.getConfig()
    const { shops, total, url } = await this._listShops({ keyword, limit: Math.max(Number(limit) || cfg.limit, 12) })
    if (!shops.length) throw new Error(keyword ? `搜「${keyword}」没搜到商家` : '附近没拿到商家：可能位置没定位到，或被要求登录')
    const scored = shops.map((shop) => ({ shop, ...scoreShop(shop, taste, { keyword, budget }) }))
    const wantCount = Math.max(1, Math.min(10, Number(count) || 3))
    const top = scored.sort((a, b) => b.score - a.score).slice(0, wantCount)
    const target = Number(budget) || taste.budget || 0
    const header = [
      keyword ? `搜的是「${keyword}」` : '按附近商家挑的',
      `候选 ${total} 家`,
      target ? `预算 ¥${target}/人` : '',
      taste.likes.length ? `记着你爱吃：${taste.likes.slice(0, 4).join('、')}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const lines = [header, '', ...top.map((item, index) => renderShop(item.shop, index + 1, item)), '']
    const loggedIn = this.store.getSession().loggedIn
    if (!loggedIn) {
      lines.push(
        '（还没登录美团：现在只能看到首页推荐的那几家，美团把药房/便利店也混在里面。登录之后我能按关键词搜——「川菜」「牛肉面」「减脂餐」——候选多得多。要登的话把手机号给我。）',
      )
    } else if (!keyword) {
      lines.push('（想看某个方向可以直说，「想吃面」「来个辣的」「凑合吃点轻食」，我按关键词再搜一轮。）')
    }
    const text = lines.join('\n')
    return {
      taste,
      keyword,
      budget: target,
      candidates: top.map((item) => ({ ...item.shop, reasons: item.reasons, risks: item.risks, scoreValue: item.score })),
      others: scored.slice(wantCount, wantCount + 5).map((item) => ({ name: item.shop.name, score: item.shop.score, id: item.shop.id })),
      text: text.trim(),
      url,
    }
  }

  pick(options) {
    return this.run(() => this._pick(options))
  }

  // ---------- 进店看菜单 ----------
  async _menu({ id, name } = {}) {
    let poiId = String(id || '').trim()
    let shopName = String(name || '').trim()
    if (!poiId) {
      if (!shopName) throw new Error('给我店名或 poi_id_str 才能看菜单')
      const { shops } = await this._listShops({ limit: 30 })
      const hit = shops.find((shop) => shop.name.includes(shopName)) || shops.find((shop) => shopName.includes(shop.name))
      if (!hit) throw new Error(`附近没找到「${shopName}」这家店`)
      poiId = hit.id
      shopName = hit.name
    }
    const browser = await this.browser()
    const tap = await browser.tap(API_URL, { limit: 120 })
    try {
      await browser.goto(menuUrl(poiId), { settleMs: 1500 })
      const deadline = Date.now() + 20000
      let dishes = []
      while (Date.now() < deadline) {
        await sleep(700)
        dishes = dishesFromText2(tap.items)
        if (dishes.length >= 5) break
        const href = await browser.evaluate('location.href').catch(() => '')
        const blocked = await this.verifyGate(browser, href)
        if (blocked) throw blocked
        if (/\/login/.test(href)) throw new Error('看菜单要登录：先用 meituan_login 登录')
      }
      await this.dismissOverlays(browser)
      for (let i = 0; i < 2; i += 1) {
        await browser.evaluate(SCROLL_EXPR).catch(() => {})
        await sleep(1200)
      }
      dishes = dishesFromText2(tap.items)
      const shopRaw = []
      for (const item of tap.items) shopRaw.push(...shopsFromText(item.text))
      const shop = shopRaw.map(normalizeShop).find((entry) => entry.id === poiId) || { id: poiId, name: shopName, shareUrl: menuUrl(poiId) }
      let pageText = ''
      if (!dishes.length) {
        pageText = await browser.evaluate('document.body ? document.body.innerText.slice(0, 2500) : ""').catch(() => '')
      }
      if (!dishes.length && this._blockedByRisk(tap.items)) {
        throw new Error(
          `美团把这个账号的数据接口临时挡了（菜单接口 403，自动化太频繁会被限流）。等 10~30 分钟别刷再试；店和菜名没变，不用重新挑。${pageText ? `\n页面原话：${clip(String(pageText).replace(/\s+/g, ' '), 120)}` : ''}`,
        )
      }
      return {
        shop,
        dishes: dishes.slice(0, 60),
        hasDishes: dishes.length > 0,
        pageText: pageText ? clip(String(pageText).replace(/\n{2,}/g, '\n'), 2500) : '',
        url: menuUrl(poiId),
      }
    } finally {
      tap.stop()
    }
  }

  menu(options) {
    return this.run(() => this._menu(options))
  }

  // ---------- 点菜方案：网页购物车只存在浏览器本地，这里给「直达 App 那道菜」的深链 ----------
  async _cart({ action = 'plan', shopId = '', shopName = '', dishes = [], qty = 1 } = {}) {
    const act = String(action || 'plan').toLowerCase()
    if (!['plan', 'view', 'clear'].includes(act)) throw new Error(`不认识的动作：${action}（现在只支持 plan / view / clear）`)
    let poiId = String(shopId || '').trim()
    let title = String(shopName || '').trim()
    if (!poiId) {
      if (!title) throw new Error('先给我一家店：poi_id_str（挑店结果里那个 id），或者店名')
      const want = normName(title)
      let shops = (await this._listShops({ keyword: title, limit: 20 })).shops
      if (!shops.length) shops = (await this._listShops({ limit: 30 })).shops
      const hit =
        shops.find((shop) => normName(shop.name) === want) ||
        shops.find((shop) => normName(shop.name).includes(want)) ||
        shops.find((shop) => want.includes(normName(shop.name)))
      if (!hit) throw new Error(`没找到「${title}」这家店，把 poi_id_str 直接给我更稳`)
      poiId = hit.id
      title = hit.name
    }

    const wanted = (Array.isArray(dishes) ? dishes : [dishes])
      .map((item) => (typeof item === 'string' ? { name: item, qty: 1 } : item))
      .filter((item) => item && item.name)
      .map((item) => ({ name: String(item.name), qty: Math.max(1, Math.min(99, Number(item.qty || qty) || 1)) }))

    const browser = await this.browser()

    if (act === 'plan') {
      const tap = await browser.tap(API_URL, { limit: 120 })
      try {
        await browser.goto(menuUrl(poiId), { settleMs: 1200 })
        const deadline = Date.now() + 25000
        let all = []
        while (Date.now() < deadline) {
          await sleep(700)
          all = uniqBy(dishesFromText2(tap.items), (dish) => dish.name)
          if (all.length >= 5) break
          const href = await browser.evaluate('location.href').catch(() => '')
          const blocked = await this.verifyGate(browser, href)
          if (blocked) throw blocked
          if (/\/login/.test(href)) throw new Error('看菜单要登录：先用 meituan_login 登录')
        }
        if (all.length < 30) {
          await browser.evaluate(SCROLL_EXPR).catch(() => {})
          await sleep(1600)
          all = uniqBy(dishesFromText2(tap.items), (dish) => dish.name)
        }
        const shop = { id: poiId, name: title || (await browser.evaluate('document.title').catch(() => '')) || poiId }
        if (!wanted.length) {
          return {
            action: act,
            shop,
            items: [],
            missing: [],
            total: 0,
            menu: all.slice(0, 40).map((dish) => ({ name: dish.name, price: dish.price, spuId: dish.spuId })),
            url: menuUrl(poiId),
            text: '',
          }
        }
        const used = new Set()
        const items = []
        const missing = []
        for (const want of wanted) {
          let best = null
          for (const dish of all) {
            if (used.has(dish.name)) continue
            const value = dishScore(want.name, dish.name)
            if (value >= 30 && (!best || value > best.score)) best = { dish, score: value }
          }
          if (!best) {
            missing.push(want.name)
            continue
          }
          used.add(best.dish.name)
          const price = best.dish.price
          items.push({
            want: want.name,
            name: best.dish.name,
            price: price ?? null,
            qty: want.qty,
            subtotal: price != null ? Math.round(price * want.qty * 100) / 100 : null,
            spuId: best.dish.spuId,
            score: best.score,
            appLink: appDeepLink(poiId, best.dish.spuId),
            webLink: webMenuLink(poiId, best.dish.spuId),
          })
        }
        const total = Math.round(items.reduce((sum, item) => sum + (item.subtotal || 0), 0) * 100) / 100
        return { action: act, shop, items, missing, total, menu: [], url: menuUrl(poiId), text: '' }
      } finally {
        tap.stop()
      }
    }

    // view / clear：只对「插件自己这个浏览器」里的购物车有效（App 看不到，仅自检用）
    await browser.goto(menuUrl(poiId), { settleMs: 1200 })
    const href = await browser.evaluate('location.href').catch(() => '')
    const blocked = await this.verifyGate(browser, href)
    if (blocked) throw blocked
    if (/\/login/.test(href)) throw new Error('要先登录：用 meituan_login 登录一次')
    await this.dismissOverlays(browser)
    for (let i = 0; i < 24; i += 1) {
      const ready = await browser.evaluate(`document.querySelectorAll('.sqt-menu-add-buttons').length > 0`).catch(() => false)
      if (ready) break
      await sleep(500)
    }
    const shop = {
      id: poiId,
      name: title || (await browser.evaluate('document.title').catch(() => '')) || poiId,
      url: menuUrl(poiId),
    }
    const empty = { items: [], missing: [], total: 0, url: menuUrl(poiId), text: '' }
    if (act === 'clear') {
      const cleared = await clearCart(browser)
      return { action: act, shop, cart: cleared.cart, before: cleared.before, ok: cleared.ok, ...empty }
    }
    return { action: act, shop, cart: await readCart(browser), ...empty }
  }

  cart(options) {
    return this.run(() => this._cart(options))
  }

  // ---------- 电脑下单：加菜 → 结算页 → 地址 → 提交（提交必须用户明确同意） ----------
  async _resolveShop({ shopId = '', shopName = '' } = {}) {
    const poiId = String(shopId || '').trim()
    const title = String(shopName || '').trim()
    if (poiId) return { poiId, title }
    if (!title) throw new Error('先给我一家店：poi_id_str（挑店结果里的那个 id），或者店名')
    const want = normName(title)
    let shops = (await this._listShops({ keyword: title, limit: 20 })).shops
    if (!shops.length) shops = (await this._listShops({ limit: 30 })).shops
    const hit =
      shops.find((shop) => normName(shop.name) === want) ||
      shops.find((shop) => normName(shop.name).includes(want)) ||
      shops.find((shop) => want.includes(normName(shop.name)))
    if (!hit) throw new Error(`没找到「${title}」这家店，把 poi_id_str 直接给我更稳`)
    return { poiId: hit.id, title: hit.name }
  }

  async _order({ action = 'prepare', shopId = '', shopName = '', dishes = [], qty = 1, address = '', confirm = false } = {}) {
    const act = String(action || 'prepare').toLowerCase()
    if (!['prepare', 'address', 'open', 'submit'].includes(act)) {
      throw new Error(`不认识的动作：${action}（支持 prepare / address / open / submit）`)
    }
    // 没传 address 就用设置页里配的「送餐地点」
    const where = String(address || this.store.getConfig().address || '').trim()

    // 只切配送地址（决定首页能看到哪一片的店）
    if (act === 'address') {
      const browser = await this.browser()
      if (!where) throw new Error('告诉我要切到哪个送餐地点（地址关键字，例如「公司」「家」），或者先去设置页把「送餐地点」填好')
      const switched = await switchDeliveryAddress(browser, where)
      if (switched?.ok) this._aoi = where
      return { action: act, address: where, ...switched }
    }

    const wanted = (Array.isArray(dishes) ? dishes : [dishes])
      .map((item) => (typeof item === 'string' ? { name: item, qty: 1 } : item))
      .filter((item) => item && item.name)
      .map((item) => ({ name: String(item.name), qty: Math.max(1, Math.min(20, Number(item.qty || qty) || 1)) }))
    if (!wanted.length) throw new Error('告诉我要点哪些菜，例如 dishes:["牛肉面","肉夹馍"]')

    // 先切配送地址（AOI）：不切的话首页那一片的店可能根本送不到你要的地址
    let switched = null
    if (where) {
      const first = await this.browser()
      switched = await switchDeliveryAddress(first, where).catch((error) => ({
        ok: false,
        reason: clip(error?.message || error, 160),
      }))
      if (switched?.ok) this._aoi = where
    }

    const { poiId, title } = await this._resolveShop({ shopId, shopName })
    let browser = await this.browser()
    const shop = { id: poiId, name: title || poiId, url: menuUrl(poiId) }

    const openMenu = async () => {
      await browser.goto(menuUrl(poiId), { settleMs: 1400 })
      const href = await browser.evaluate('location.href').catch(() => '')
      const blocked = await this.verifyGate(browser, href)
      if (blocked) throw blocked
      if (/\/login/.test(href)) throw new Error('看菜单要登录：先用 meituan_login 登录一次')
      await this.dismissOverlays(browser)
      for (let i = 0; i < 30; i += 1) {
        const ready = await browser.evaluate(`document.querySelectorAll('.sqt-menu-add-buttons').length > 0`).catch(() => false)
        if (ready) return true
        await sleep(500)
      }
      return false
    }

    if (!(await openMenu())) return { action: act, shop, added: [], failed: [], reason: '菜单没加载出来（可能没登录或被风控）' }

    // 先清空插件浏览器里的本地购物车，保证只下这次点的菜
    await clearCart(browser).catch(() => {})
    await openMenu()

    const added = []
    const failed = []
    // 先拿一份「接口里的菜单」：加不进去时可以用 spuId 直达那道菜再试
    let menuDishes = []
    try {
      const info = await this._menu({ id: poiId })
      menuDishes = info.dishes || []
      await openMenu()
    } catch {}
    const spuOf = (want) => {
      let best = null
      for (const dish of menuDishes) {
        const value = dishScore(want, dish.name)
        if (!best || value > best.value) best = { value, dish }
      }
      return best && best.value >= 55 ? best.dish : null
    }
    for (const want of wanted) {
      for (let n = 0; n < want.qty; n += 1) {
        let result = await addDish(browser, want.name).catch((error) => ({ ok: false, reason: clip(error?.message || error, 120) }))
        if (!result.ok) {
          // 页面上没渲染到 → 用 dishId 深链直达那道菜再试一次
          const dish = spuOf(want.name)
          if (dish?.spuId) {
            await browser.goto(`${menuUrl(poiId)}&dishId=${dish.spuId}`, { settleMs: 2200 }).catch(() => {})
            await this.dismissOverlays(browser).catch(() => {})
            await sleep(1200)
            result = await addDish(browser, want.name).catch((error) => ({ ok: false, reason: clip(error?.message || error, 120) }))
          }
        }
        if (!result.ok) {
          failed.push({
            name: want.name,
            reason: clip(result.reason || '没加成', 120),
            candidates: (result.candidates || [])
              .slice(0, 5)
              .map((item) => (typeof item === 'string' ? item : item?.name))
              .filter(Boolean),
          })
          break
        }
        added.push(result.name || want.name)
        // 连着点加号容易被美团风控，慢一点
        await sleep(900)
      }
    }
    if (!added.length) return { action: act, shop, added, failed, reason: '一道菜都没加进去，先看看菜名对不对' }

    let previewUrl = ''
    try {
      previewUrl = await goCheckout(browser)
    } catch (error) {
      const cart = await cartState(browser).catch(() => null)
      const cartText = String(cart?.text || '').replace(/\s+/g, ' ').trim()
      let reason = clip(error?.message || error, 240)
      if (/单点不配送/.test(cartText)) {
        reason = `这家店「单点不配送」：光加小吃/加料不行，得点一份正餐（主食/套餐）。现在车里是：${cartText}`
      } else if (/差\s*¥?\s*\d/.test(cartText) && /起送/.test(cartText)) {
        reason = `还没到起送价，再加一样就够了。现在车里是：${cartText}`
      }
      return {
        action: act,
        shop,
        added,
        failed,
        cart,
        notReady: true,
        reason,
      }
    }
    await sleep(1500)
    let preview = await readPreview(browser)

    // 结算页没地址 / 地址超范围 / 压根没算出来 → 顺手挑一个能送的
    const needAddress = (main) => !main.address || !main.hasSubmit || /超配送范围/.test(String(main.text || '').slice(0, 600))
    if (needAddress(preview)) {
      const opened = await openAddressPanel(browser)
      if (opened.ok) {
        const chosen = await chooseAddress(browser, String(address || '').trim())
        if (chosen.ok) {
          await sleep(1800)
          preview = await readPreview(browser)
        } else {
          preview.addressNote = chosen.reason
        }
      } else {
        preview.addressNote = opened.reason
      }
    }
    if (!preview.hasSubmit) {
      preview.warn = `这家店眼下没法给这个地址下单（${preview.addressNote || '所有保存的地址都超配送范围'}）；换一家店或换个配送地址再试`
    }

    const out = { action: act, shop, added, failed, preview, url: previewUrl, switched }
    // 「餐具数量」是必选项，不选就提交不了 → 默认选「不需要餐具」，省得卡在最后一步
    if (preview.needsTableware) {
      out.tableware = await chooseTableware(browser, '无需餐具').catch((error) => ({ ok: false, reason: clip(error?.message || error, 120) }))
      await sleep(1200)
      preview = await readPreview(browser)
      out.preview = preview
    }
    if (act === 'prepare') return out

    if (act === 'submit' && confirm !== true) {
      throw new Error('提交订单会真的下单花钱，得你明确同意：把 confirm 设成 true（或者用 action:"open" 切可见窗口自己点）')
    }
    if (act === 'open') {
      await this.store.patchConfig({ headless: false })
      await this.stop()
      browser = await this.browser()
      if (!(await openMenu())) return { ...out, reason: '切到可见窗口后菜单没加载出来' }
      await goCheckout(browser)
      await sleep(1800)
      await browser.bringToFront().catch(() => {})
      out.preview = await readPreview(browser)
      out.visible = true
      out.note = '已切到可见窗口、停在结算页：核对地址/餐具后你自己点「提交订单」并付款'
      return out
    }

    const submitted = await submitOrder(browser)
    out.submitted = true
    out.result = submitted
    return out
  }

  order(options) {
    return this.run(() => this._order(options))
  }
}

function normName(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[()（）【】[\]·,，.。:：、]/g, '')
    .toLowerCase()
}

/** 「大片牛腱子兰州牛肉面」对上「大片牛腱子兰州牛肉面(肉约6-8片)」：相等 100，包含 70/55，其余按字符命中率 */
function dishScore(target, name) {
  const a = normName(target)
  const b = normName(name)
  if (!a || !b) return 0
  if (a === b) return 100
  if (b.includes(a)) return 70
  if (a.includes(b)) return 55
  const chars = [...new Set(a)]
  let hit = 0
  for (const ch of chars) if (b.includes(ch)) hit += 1
  return Math.round((hit / chars.length) * 40)
}

function dishesFromText2(items) {
  const all = []
  for (const item of items) {
    if (!/json|text/i.test(item.mime || '')) continue
    all.push(...dishesFromText(item.text))
  }
  return uniqBy(all, (dish) => `${dish.name}|${dish.price}`)
}
