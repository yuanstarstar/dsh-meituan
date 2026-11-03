/**
 * 京东外卖（京东小时达 / 秒送）数据层。
 *
 * 为什么走这条路：美团网页端被账号级 403 挡住，京东这边「真浏览器 + 扩展」完全通。
 * 做法跟 SnowLuma 一样——不伪造请求、不自己签名：
 *   扩展在用户的 Edge 里打开真实页面 → 页面自己发请求（带真 cookie / 真签名）
 *   → 扩展只把响应「旁听」下来 → 这里解析。
 *
 * 一次挑选 = 一次页面加载（跟人点一下频道一样），响应里有店、有菜、有价格、有分享链接。
 */
import fs from 'node:fs'
import path from 'node:path'

export const CHANNEL_URL =
  'https://hour.jd.com/aggregationChannel/home?channelType=wmSingleChannel&svcType=lbs&busiAppKey=jd_jddj&mtaChannelId=32763'

export const STORE_URL = (venderId, storeId) =>
  `https://hour.jd.com/msstore/index?venderId=${encodeURIComponent(venderId)}&storeId=${encodeURIComponent(storeId)}&svcType=lbs`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const money = (value) => {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'object') return money(value.price ?? value.value ?? 0)
  const number = Number(String(value).replace(/[^\d.]/g, ''))
  return Number.isFinite(number) ? number : 0
}

const text = (value, max = 80) => {
  const out = String(value ?? '').replace(/\s+/g, ' ').trim()
  return out.length > max ? out.slice(0, max) + '…' : out
}

const km = (value) => {
  const number = Number(String(value ?? '').replace(/[^\d.]/g, ''))
  return Number.isFinite(number) ? number : 0
}

/** 深扫一段 JSON，把「店」和「菜」都捞出来（京东的楼层结构每版都不一样，别写死路径） */
export function collectStores(payloads) {
  const shops = new Map()
  const visit = (node, parent, depth) => {
    if (!node || typeof node !== 'object' || depth > 14) return

    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent, depth + 1)
      return
    }

    const id = node.storeId ?? node.venderId_storeId
    if (id && (node.storeName || node.shopName)) {
      const key = String(id)
      const shop = shops.get(key) || { id: key, dishes: [] }
      shop.name = shop.name || text(node.storeName || node.shopName, 60)
      shop.venderId = shop.venderId || String(node.venderId || '')
      shop.distance = shop.distance || text(node.distance, 12)
      shop.pic = shop.pic || node.shopLogo || node.picUrl || ''
      shop.minPrice = shop.minPrice || money(node.initialDeliveryPrice)
      shop.freight = shop.freight || text(node.lineFreight || node.baseFreight, 16)
      shop.freightNumber = shop.freightNumber || money(node.distanceFreight || node.lineFreight)
      shop.eta = shop.eta || text((node.storeTagVOList || []).map((tag) => tag.tagText).filter(Boolean).join(' / '), 40)
      shop.tags = shop.tags || (node.labelList || []).map((label) => text(label.text, 16)).filter(Boolean)
      shop.coupons = shop.coupons || (node.couponVOList || []).map((coupon) => text(coupon.couponDesc, 20)).filter(Boolean).slice(0, 4)
      shop.url = shop.url || node.jumpLink || (shop.venderId ? STORE_URL(shop.venderId, key) : '')
      if (node.bizStartHours) shop.hours = `${node.bizStartHours}-${node.bizEndHours || ''}`

      // 带菜单的店卡（productBaseVOList）
      for (const dish of node.productBaseVOList || []) {
        if (!dish?.name) continue
        shop.dishes.push({ name: text(dish.name, 60), price: money(dish.majorPrice ?? dish.price ?? dish.minorPrice) })
      }
      shops.set(key, shop)
    }

    // 「商品卡」：店信息在 storeBaseVO，菜信息在外层
    if (node.storeBaseVO?.storeName && node.storeBaseVO?.storeId) {
      const base = node.storeBaseVO
      const key = String(base.storeId)
      const shop = shops.get(key) || { id: key, dishes: [] }
      shop.name = shop.name || text(base.storeName, 60)
      shop.venderId = shop.venderId || String(base.venderId || '')
      shop.distance = shop.distance || text(base.distance, 12)
      shop.pic = shop.pic || base.shopLogo || node.picUrl || ''
      shop.freightNumber = shop.freightNumber || money(base.distanceFreight)
      shop.url = shop.url || base.jumpLink || ''
      if (node.name && money(node.majorPrice ?? node.price) > 0) {
        shop.dishes.push({ name: text(node.name, 60), price: money(node.majorPrice ?? node.price) })
      }
      shops.set(key, shop)
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, node, depth + 1)
    }
  }

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') continue
    visit(payload, null, 0)
  }

  for (const shop of shops.values()) {
    const seen = new Set()
    shop.dishes = shop.dishes.filter((dish) => {
      const key = `${dish.name}¥${dish.price}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 24)
    if (!shop.minPrice) shop.minPrice = shop.minPrice || 0
  }
  return [...shops.values()].filter((shop) => shop.name)
}

/** 按口味打分（京东数据没有评分，所以看：关键词命中、爱吃/忌口、价位、距离） */
export function scoreShop(shop, taste = {}, { keyword = '', budget = 0 } = {}) {
  const why = []
  let score = 50
  const dishes = (shop.dishes || []).map((dish) => dish.name)
  const hay = `${shop.name} ${(shop.tags || []).join(' ')} ${dishes.join(' ')}`
  const word = String(keyword || '').trim()

  if (word) {
    if (shop.name.includes(word)) {
      score += 34
      why.push(`店名里有「${word}」`)
    } else if (dishes.some((name) => name.includes(word))) {
      score += 24
      why.push(`有「${word}」这道菜`)
    } else if (hay.includes(word)) {
      score += 12
      why.push('店里提到这个关键词')
    } else {
      score -= 26
    }
  }

  for (const like of taste.likes || []) {
    if (!like) continue
    if (hay.includes(like)) {
      score += 12
      why.push(`你爱吃「${like}」`)
    }
  }
  for (const dislike of taste.dislikes || []) {
    if (!dislike) continue
    if (hay.includes(dislike)) {
      score -= 45
      why.push(`你不吃「${dislike}」（避开）`)
    }
  }

  const spicy = Number(taste.spicy)
  if (Number.isFinite(spicy)) {
    const isSpicy = /辣|麻|川|湘|重庆|火爆|椒麻/.test(hay)
    if (spicy >= 3 && isSpicy) {
      score += 8
      why.push('口味偏辣，这家合适')
    }
    if (spicy <= 1 && isSpicy) {
      score -= 10
      why.push('你吃不了太辣')
    }
  }

  const prices = (shop.dishes || []).map((dish) => dish.price).filter((price) => price > 0)
  const cheapest = prices.length ? Math.min(...prices) : 0
  const limit = Number(budget || taste.budget || 0)
  if (limit > 0) {
    if (cheapest && cheapest <= limit) {
      score += 10
      why.push(`有 ¥${cheapest.toFixed(0)} 的菜，在预算内`)
    }
    if (cheapest && cheapest > limit * 1.8) {
      score -= 14
      why.push('偏贵')
    }
    if (shop.minPrice && shop.minPrice > limit * 2) score -= 8
  }

  const distance = km(shop.distance)
  if (distance > 0) {
    if (distance <= 1.5) score += 8
    else if (distance <= 3) score += 4
    else if (distance >= 6) score -= 6
  }

  return { score, why }
}

/** 这些字眼的按钮，插件永远不点：提交/付款只能由用户自己点 */
export const UNSAFE = /立即支付|提交订单|付款|支付|确认支付|去支付/

/** 把结算页的文字解析成结构化订单（只读，不点任何东西） */
export function parseCheckout(raw) {
  const source = String(raw || '')
  const flat = source.replace(/\s+/g, '')
  const pick = (re, index = 1) => {
    const matched = flat.match(re)
    return matched ? Number(matched[index]) : null
  }
  const goods = pick(/商品金额[￥¥]([\d.]+)/)
  const coupon = pick(/优惠券-?[￥¥]([\d.]+)/)
  let freight = null
  const freightMatch = flat.match(/运费(?:已减[\d.]+元)?[￥¥]([\d.]+)(?:[￥¥]([\d.]+))?/)
  if (freightMatch) freight = Number(freightMatch[2] || freightMatch[1])
  const total = pick(/合计[：:]?[￥¥]([\d.]+)/)
  const eta = (source.match(/大约\s*\d{1,2}:\d{2}\s*送达/) || [])[0] || ''
  const addressMatch = source.match(/(?:学校|家|公司)\s+([^\n]{4,60}?)\s+([\u4e00-\u9fa5]{1,5})\s+1\d{2}\*{4}\d{4}/)
  const shopMatch = source.match(/(?:^|\s)([\u4e00-\u9fa5A-Za-z0-9·（）()\-]{2,30}店)\s/)
  const end = source.indexOf('不支持7天无理由退货')
  const blockStart = Math.max(0, source.lastIndexOf('店 ', end) < 0 ? 0 : source.lastIndexOf('店 ', end) + 2)
  const itemBlock = end > 0 ? source.slice(blockStart, end).trim() : ''
  const tidy = (value) => String(value || '').replace(/(\d)\s+(\d)/g, '$1$2').replace(/(\d)\s*\.\s*(\d)/g, '$1.$2').replace(/\s+/g, ' ').trim()
  const items = []
  const itemRe = /([\u4e00-\u9fa5A-Za-z0-9+·（）()\-—*]{2,40}?)\s*(\d+)\s*份\s*(?:([\u4e00-\u9fa5A-Za-z]{1,8})\s*)?[¥￥]\s*([\d.]+)/g
  const itemSource = tidy(itemBlock)
  let matchedItem
  while ((matchedItem = itemRe.exec(itemSource)) && items.length < 6) {
    items.push({ name: matchedItem[1].trim(), qty: Number(matchedItem[2]), spec: matchedItem[3] || '', price: Number(matchedItem[4]) })
  }
  return {
    address: addressMatch ? addressMatch[1].trim() : '',
    receiver: addressMatch ? addressMatch[2] : '',
    shop: shopMatch ? shopMatch[1] : '',
    eta,
    goods,
    freight,
    coupon,
    total,
    items,
    itemsText: tidy(itemBlock).slice(0, 160),
    payButton: /立即支付/.test(source),
  }
}

export class Jd {
  constructor({ store, bridge, logger } = {}) {
    this.store = store
    this.bridge = bridge
    this.logger = logger
    this.cacheFile = store ? path.join(store.dir, 'jd-cache.json') : ''
    this.cache = this._readCache()
    this.busy = false
  }

  _readCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))
      return raw && Array.isArray(raw.shops) ? raw : { at: 0, shops: [] }
    } catch {
      return { at: 0, shops: [] }
    }
  }

  _writeCache(shops) {
    this.cache = { at: Date.now(), shops }
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2))
    } catch (error) {
      this.logger?.warn?.(`京东缓存写不进去：${error?.message || error}`)
    }
  }

  status() {
    const bridge = this.bridge?.status?.() || {}
    return {
      connected: Boolean(bridge.connected),
      bridge,
      cachedShops: this.cache.shops.length,
      cachedAt: this.cache.at ? new Date(this.cache.at).toISOString() : '',
      stale: !this.cache.at || Date.now() - this.cache.at > 5 * 60 * 1000,
    }
  }

  /** 走扩展开一次频道页，把页面自己发的响应收回来 */
  async refresh({ timeoutMs = 60_000 } = {}) {
    const status = this.status()
    if (!status.connected) {
      throw new Error('京东扩展没连上：Edge 里「DSH 点餐桥」要开着且是启用状态（浏览器重启后它会自动连回来）')
    }
    if (this.busy) throw new Error('上一次还在读京东，等我一会儿')
    this.busy = true
    try {
      await this.bridge.call('drain', {}, { timeoutMs: 20_000 }).catch(() => null) // 清空旧缓冲
      const url = `${CHANNEL_URL}&_=${Date.now()}`
      const opened = await this.bridge.call('open', { url, active: false }, { timeoutMs: timeoutMs + 30_000 })
      const href = String(opened?.href || '')
      if (/plogin\.m\.jd\.com/.test(href)) {
        throw new Error('京东让我登录：请在 Edge 里登录一次京东（我不会替你登），登完再让我试')
      }
      await sleep(9000)
      const drained = await this.bridge.call('drain', {}, { timeoutMs: 30_000 })
      const items = Array.isArray(drained?.items) ? drained.items : []
      const payloads = []
      const raw = []
      for (const item of items) {
        if (!/functionId=|hour\.jd\.com/i.test(String(item?.url || ''))) continue
        const body = String(item?.text || '')
        if (body.length < 200) continue
        try {
          payloads.push(JSON.parse(body))
          raw.push({ url: item.url, status: item.status, size: body.length })
        } catch {
          /* 不是 JSON 就不要 */
        }
      }
      const shops = collectStores(payloads)
      if (!shops.length) {
        throw new Error(
          `京东页面没给出商家（收到 ${items.length} 条响应，其中可用 JSON ${payloads.length} 条）。` +
            '可能是页面还在加载、或者被要求验证/登录。等十几秒再让我试，别连着刷。',
        )
      }
      this._writeCache(shops)
      return { shops, raw, href }
    } finally {
      this.busy = false
    }
  }

  async shops({ force = false } = {}) {
    const fresh = this.cache.at && Date.now() - this.cache.at < 5 * 60 * 1000
    if (force || !fresh || !this.cache.shops.length) {
      const result = await this.refresh()
      return { shops: result.shops, cached: false, at: Date.now() }
    }
    return { shops: this.cache.shops, cached: true, at: this.cache.at }
  }

  /** 核心：按口味挑几家 + 每家的推荐菜 + 可直接打开的链接 */
  async pick({ count = 3, keyword = '', limit = 12, budget = 0, taste = {}, fresh = false } = {}) {
    const { shops, cached, at } = await this.shops({ force: fresh })
    const blacklist = /奶茶|茶饮|果茶|柠檬茶|咖啡|饮品|果汁|甜品|蛋糕|烘焙|面包|冰淇淋|雪糕|药|超市|便利店|水果|鲜花/
    const named = String(keyword || '')
    const pool = shops
      .filter((shop) => (named && blacklist.test(named) ? true : !blacklist.test(shop.name)))
      .map((shop) => {
        const { score: value, why } = scoreShop(shop, taste, { keyword: named, budget })
        const priced = (shop.dishes || []).filter((dish) => dish.price > 0)
        const suggestions = priced
          .slice()
          .sort((a, b) => Number(Boolean(taste.budget && Math.abs(a.price - taste.budget) < Math.abs(b.price - taste.budget))) ? -1 : 0)
          .slice(0, 6)
        return { ...shop, score: value, why, suggestions }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 12)))

    return {
      total: shops.length,
      picked: pool.slice(0, Math.max(1, Math.min(10, Number(count) || 3))),
      candidates: pool,
      cached,
      at,
    }
  }

  /** 某家店的菜单（优先用缓存的菜；缓存里没有就打开店铺页读一次） */
  async menu({ storeId = '', name = '', fresh = false } = {}) {
    const { shops } = await this.shops({ force: false })
    const key = String(storeId || '')
    let shop = shops.find((item) => item.id === key) || (name ? shops.find((item) => item.name.includes(name)) : null)
    if (shop && shop.dishes.length >= 5 && !fresh) return { shop, from: 'cache' }

    const target = shop || null
    if (!target?.url) {
      throw new Error('没有这家店：先用 jd_pick 挑一次（或者给我完整的 storeId）')
    }
    const status = this.status()
    if (!status.connected) throw new Error('京东扩展没连上：Edge 里「DSH 点餐桥」要开着')
    await this.bridge.call('drain', {}, { timeoutMs: 20_000 }).catch(() => null)
    await this.bridge.call('open', { url: target.url, active: false }, { timeoutMs: 60_000 })
    await sleep(8000)
    const drained = await this.bridge.call('drain', {}, { timeoutMs: 30_000 })
    const items = Array.isArray(drained?.items) ? drained.items : []
    const dishes = []
    for (const item of items) {
      const body = String(item?.text || '')
      if (body.length < 200) continue
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        continue
      }
      const visit = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 12) return
        if (Array.isArray(node)) {
          for (const entry of node) visit(entry, depth + 1)
          return
        }
        const dishName = node.skuName || node.wname || (node.skuId && node.name ? node.name : '')
        if (dishName && !node.storeName) {
          const price = money(node.majorPrice ?? node.price ?? node.jdPrice ?? node.pPrice)
          if (price > 0) dishes.push({ name: text(dishName, 60), price })
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') visit(value, depth + 1)
        }
      }
      visit(parsed, 0)
    }
    const seen = new Set()
    const unique = dishes.filter((dish) => {
      const dedupe = `${dish.name}¥${dish.price}`
      if (seen.has(dedupe)) return false
      seen.add(dedupe)
      return true
    })
    if (unique.length) {
      target.dishes = unique.slice(0, 60)
      this._writeCache(shops)
      return { shop: target, from: 'page' }
    }
    if (target.dishes.length) return { shop: target, from: 'cache', note: '店铺页没抓到新菜单，用的是列表里的菜' }
    throw new Error('没能读到这家店的菜单：京东可能要你验证一下，或者页面结构变了')
  }

  // ---------------- 点菜 / 购物车 / 结算 ----------------
  //
  // 边界（重要）：只「加菜」和「打开结算页」，绝不自己点提交订单、绝不碰付款。
  // 所有动作都发生在用户自己的 Edge 里（扩展现场用真实事件点），请求由页面自己发、自己签名。

  _ensureBridge() {
    if (!this.status().connected) {
      throw new Error('京东扩展没连上：Edge 里「DSH 点餐桥」要开着（浏览器重启后它会自动连回来）')
    }
  }

  async _op(op, args = {}, timeoutMs = 90_000) {
    this._ensureBridge()
    return this.bridge.call(op, args, { timeoutMs })
  }

  _findShop(storeId = '', name = '') {
    const key = String(storeId || '')
    const shops = this.cache.shops || []
    const shop = shops.find((item) => item.id === key) || (name ? shops.find((item) => item.name.includes(name)) : null)
    if (!shop) throw new Error('没有这家店：先用 jd_pick 挑一次（或者给我完整 storeId）')
    return shop
  }

  /** 点一下就「真点」：优先 chrome.debugger 的真鼠标，失败退回合成指针序列 */
  async _tapText(wanted, { exact = false, max = 6, label = wanted } = {}) {
    if (UNSAFE.test(String(label || ''))) throw new Error(`拒绝点击「${label}」：提交订单和付款必须由你自己点`)
    const rect = await this._op('rect', { text: wanted, max, exact }, 45_000)
    const box = rect?.items?.[0]?.box || rect?.box
    if (!box) return null
    const point = { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) }
    const clicked = await this._op('realClick', point, 60_000).catch(async (error) => {
      this.logger?.warn?.(`真鼠标点击失败，改用合成点击：${error?.message || error}`)
      return this._op('clickPoint', { ...point, verifyMs: 900 }, 60_000)
    })
    await sleep(2600)
    return { label, box, point, clicked }
  }

  /** 读当前页面上的订单信息（只读） */
  async readOrder() {
    const text = await this._op('text', { max: 5000 }, 30_000)
    const ping = await this._op('ping', {}, 20_000).catch(() => null)
    const raw = String(text?.text || '')
    return { ...parseCheckout(raw), href: String(ping?.href || text?.href || ''), title: String(ping?.title || ''), raw }
  }

  /**
   * 把一份餐点到「提交订单」页，然后停下等用户自己付款。
   * 只点「去抢购 / 份数 / 确定」；UNSAFE 里的按钮一律拒绝。
   */
  async start({ storeId = '', name = '', dish = '', dishes = [], portion = 1, active = true } = {}) {
    const shop = this._findShop(storeId, name)
    const wanted = dish
      ? [String(dish)]
      : (Array.isArray(dishes) ? dishes : String(dishes || '').split(/[,，、;；\n]/)).map((item) => String(item || '').trim()).filter(Boolean)
    if (!wanted.length) throw new Error('要点哪道菜？把菜名给我（比如「香辣大鸡排+单根烤肠」）')

    const steps = []
    await this._op('drain', {}, 20_000).catch(() => null)
    await this._op('open', { url: `${shop.url}${shop.url.includes('?') ? '&' : '?'}_=${Date.now()}`, active }, 70_000)
    await sleep(9000)
    await this._op('inject', {}, 20_000).catch(() => null)
    await this._op('activate', {}, 20_000).catch(() => null)
    await sleep(1200)

    const ping = await this._op('ping', {}, 20_000)
    if (/plogin\.m\.jd\.com/.test(String(ping?.href || ''))) {
      throw new Error('京东让我登录：请在你自己的 Edge 里登录一次京东（登录页已经打开），登录完告诉我再点')
    }

    // 1) 找到这道菜，必要时滚进视口
    let card = await this._op('rect', { text: wanted[0], max: 8 }, 40_000).catch(() => null)
    let box = card?.items?.[0]?.box || card?.box
    if (!box) throw new Error(`这家店的页面上没找到「${wanted[0]}」`)
    if (box.y > 900) {
      await this._op('scroll', { dy: Math.max(0, box.y - 500), steps: 3 }, 30_000).catch(() => null)
      await sleep(1800)
      card = await this._op('rect', { text: wanted[0], max: 8 }, 30_000).catch(() => card)
      box = card?.items?.[0]?.box || card?.box || box
    }
    steps.push(`找到「${wanted[0]}」：${JSON.stringify(box)}`)

    // 2) 点这道菜的「去抢购」
    const buy = await this._op('rect', { text: '去抢购', max: 12 }, 40_000).catch(() => null)
    const buys = (buy?.items || (buy?.box ? [buy] : []))
      .filter((item) => item?.box)
      .sort((a, b) => Math.abs(a.box.y - box.y) - Math.abs(b.box.y - box.y))
    if (!buys.length) throw new Error('页面上没有「去抢购」（可能这家店只支持加购物车，或者不在营业时间）')
    const target = buys[0].box
    const point = { x: Math.round(target.x + target.w / 2), y: Math.round(target.y + target.h / 2) }
    const opened = await this._op('realClick', point, 60_000).catch((error) => ({ ok: false, reason: error?.message || String(error) }))
    steps.push(`点「去抢购」@${point.x},${point.y}：${opened?.ok ? 'ok' : opened?.reason || '失败'}`)
    await sleep(3500)
    await this._op('inject', {}, 15_000).catch(() => null)

    // 3) 份数（弹层里的 chip）
    if (Number(portion) > 1) {
      const chip = await this._tapText(`${Number(portion)}份`, { max: 4, label: `${portion}份` }).catch(() => null)
      steps.push(chip ? `选了 ${portion} 份` : `没找到「${portion}份」，按默认份数`)
    }

    // 4) 确定 / 加入购物车（弹层底部）
    let confirmed = await this._tapText('确定', { max: 4, label: '确定' }).catch(() => null)
    if (!confirmed) confirmed = await this._tapText('确认', { max: 4, label: '确认' }).catch(() => null)
    if (!confirmed) confirmed = await this._tapText('加入购物车', { max: 4, label: '加入购物车' }).catch(() => null)
    if (!confirmed) {
      // 兜底：弹层确认按钮固定在右下那一带
      const fallback = { x: 246, y: 822 }
      await this._op('realClick', fallback, 60_000).catch(() => null)
      steps.push(`没找到确定按钮，按兜底坐标点了一下 @${fallback.x},${fallback.y}`)
    } else {
      steps.push('点的「确定/加入购物车」')
    }
    await sleep(6000)
    await this._op('inject', {}, 15_000).catch(() => null)
    await sleep(1500)

    const order = await this.readOrder()
    const onCheckout = /mspay|order/i.test(order.href) || /立即支付/.test(order.raw)
    return {
      shop,
      steps,
      order,
      onCheckout,
      note: onCheckout
        ? '已经停在「提交订单」页。付款和提交我都不点——你自己确认后点「立即支付」。'
        : '还没到结算页：可能弹层没点开或这家店需要加购物车。你在页面里点一下「去抢购/加入购物车」，我再来读结算页。',
    }
  }

  /** 兼容旧名字：老调用点还在用 prepare */
  async prepare(options = {}) {
    return this.start(options)
  }

  /** 看购物车（京东的购物车在服务端，App 里也能看到） */
  async cart() {
    const state = await this._op('cart', {}, 30_000)
    return state
  }

  /** 打开结算页（停在提交订单前面，等用户自己点提交/付款） */
  async checkout({ storeId = '', name = '', active = true } = {}) {
    const shop = this._findShop(storeId, name)
    await this._op('open', { url: shop.url, active, timeoutMs: 60_000 })
    await sleep(6000)
    const before = await this._op('cart', {}, 30_000)
    let clicked = null
    if (before?.checkout?.box) {
      const box = before.checkout.box
      clicked = await this._op('clickPoint', { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) }, 60_000)
    } else {
      clicked = await this._op('click', { text: '去结算', timeoutMs: 6000 }, 60_000)
    }
    await sleep(4000)
    const after = await this._op('cart', {}, 30_000)
    const text = await this._op('text', { max: 600 }, 20_000)
    return { shop, clicked, before, after, href: after?.href || '', text: String(text?.text || '').slice(0, 600) }
  }
}
