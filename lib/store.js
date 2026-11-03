import fs from 'node:fs'
import path from 'node:path'
import { nowIso } from './util.js'

const CONFIG_DEFAULTS = {
  headless: true, // 默认后台跑，不抢你窗口；想看它翻页可以在设置里关掉
  browserPath: '', // 留空自动找 Edge/Chrome
  limit: 12, // 一次给模型看多少家店
  scrolls: 1, // 进页面后往下滚几次，尽量多加载几家
  minScore: 0, // 低于这么多分的店直接过滤掉，0 = 不过滤
  verifyWaitSec: 150, // 遇到美团滑块验证时最多等多久（秒），期间会弹出可见窗口
  address: '', // 默认送餐地点（地址关键字，挑店/下单都按它切商圈）
}

const TASTE_DEFAULTS = {
  likes: [], // ["川菜","面条","清淡"]
  dislikes: [], // ["香菜","太油"]
  spicy: 2, // 0 不吃辣 → 3 无辣不欢
  budget: 30, // 一顿想花多少钱（人均）
  health: false, // 要不要减脂
  note: '', // 自由补充
  updatedAt: '',
}

const SESSION_DEFAULTS = {
  loggedIn: false,
  phone: '',
  at: '',
  cookieNames: [],
}

function read(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return { ...fallback }
  } catch {
    return { ...fallback }
  }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

export class Store {
  constructor(root) {
    this.root = root
    this.dir = path.join(root, 'data')
    this.configFile = path.join(this.dir, 'config.json')
    this.tasteFile = path.join(this.dir, 'taste.json')
    this.sessionFile = path.join(this.dir, 'session.json')
    this.profileDir = path.join(this.dir, 'browser-profile')
    fs.mkdirSync(this.dir, { recursive: true })
  }

  getConfig() {
    const cfg = { ...CONFIG_DEFAULTS, ...read(this.configFile, CONFIG_DEFAULTS) }
    cfg.limit = Math.max(3, Math.min(40, Number(cfg.limit) || CONFIG_DEFAULTS.limit))
    cfg.scrolls = Math.max(0, Math.min(6, Number(cfg.scrolls) ?? CONFIG_DEFAULTS.scrolls))
    cfg.minScore = Math.max(0, Math.min(5, Number(cfg.minScore) || 0))
    cfg.headless = cfg.headless !== false
    return cfg
  }

  patchConfig(patch) {
    const next = { ...this.getConfig(), ...(patch || {}) }
    write(this.configFile, next)
    return this.getConfig()
  }

  getTaste() {
    const taste = { ...TASTE_DEFAULTS, ...read(this.tasteFile, TASTE_DEFAULTS) }
    taste.likes = Array.isArray(taste.likes) ? taste.likes.map(String).filter(Boolean).slice(0, 20) : []
    taste.dislikes = Array.isArray(taste.dislikes) ? taste.dislikes.map(String).filter(Boolean).slice(0, 20) : []
    taste.spicy = Math.max(0, Math.min(3, Number(taste.spicy) || 0))
    taste.budget = Math.max(0, Number(taste.budget) || 0)
    taste.health = Boolean(taste.health)
    taste.note = String(taste.note || '')
    return taste
  }

  setTaste(patch) {
    const next = { ...this.getTaste(), ...(patch || {}), updatedAt: nowIso() }
    write(this.tasteFile, next)
    return this.getTaste()
  }

  getSession() {
    return { ...SESSION_DEFAULTS, ...read(this.sessionFile, SESSION_DEFAULTS) }
  }

  setSession(patch) {
    const next = { ...this.getSession(), ...(patch || {}) }
    write(this.sessionFile, next)
    return next
  }

  clearSession() {
    write(this.sessionFile, { ...SESSION_DEFAULTS })
    return this.getSession()
  }
}
