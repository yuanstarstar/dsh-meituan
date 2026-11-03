// 二维码：把一串文字（通常是 meituanwaimai:// 深链）变成 PNG，用户拿手机扫屏幕就能打开。
// 编码核心是 vendored 进来的 MIT 实现（vendor/qrcode，来自 qrcode@1.5.4 的 lib/core），
// 这样不依赖 DSH 安装路径、也不引入 npm 依赖；PNG 是自己写的（node:zlib，灰度 8bit）。
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
const qrCore = require('../vendor/qrcode/lib/core/qrcode.js')

/** 生成 0/1 矩阵（1 = 黑块）。level: L / M / Q / H */
export function qrMatrix(text, { level = 'M' } = {}) {
  const code = qrCore.create(String(text), { errorCorrectionLevel: level })
  const size = code.modules.size
  const data = code.modules.data
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = new Array(size)
    for (let x = 0; x < size; x += 1) row[x] = data[y * size + x] ? 1 : 0
    rows.push(row)
  }
  return { size, rows, version: code.version }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** 灰度 PNG：每格 scale 像素，外面留 margin 格白边（二维码规范要求至少 4） */
export function matrixToPng({ rows, size }, { scale = 6, margin = 4 } = {}) {
  const width = (size + margin * 2) * scale
  const raw = Buffer.alloc((width + 1) * width, 0xff)
  for (let y = 0; y < width; y += 1) {
    const lineStart = y * (width + 1)
    raw[lineStart] = 0 // filter: none
    const gy = Math.floor(y / scale) - margin
    for (let x = 0; x < width; x += 1) {
      const gx = Math.floor(x / scale) - margin
      const dark = gy >= 0 && gy < size && gx >= 0 && gx < size && rows[gy][gx]
      if (dark) raw[lineStart + 1 + x] = 0x00
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(width, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function qrPng(text, { level = 'M', scale = 6, margin = 4 } = {}) {
  return matrixToPng(qrMatrix(text, { level }), { scale, margin })
}

export function qrDataUrl(text, options = {}) {
  return `data:image/png;base64,${qrPng(text, options).toString('base64')}`
}
