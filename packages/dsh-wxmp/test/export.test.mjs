import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../lib/store.js'
import { exportAccount } from '../lib/export.js'
import { inflateRawSync } from 'node:zlib'

const NOW = Math.floor(Date.now() / 1000)
const FETCH_OK = async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) })

async function makeStore(n = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'wxmp-export-'))
  const store = openStore(dir)
  store.addSubscription({ fakeid: 'F1', nickname: '测试号', alias: 'test' })
  const rows = []
  for (let i = 0; i < n; i++) {
    rows.push({
      title: `文章${i + 1}`, link: `https://mp.weixin.qq.com/s/x${i + 1}`, author: '作者', digest: `d${i + 1}`,
      cover: '', publishTime: NOW - 100 * (i + 1),
      content: `<h2>标题${i + 1}</h2><p>段落 <b>加粗</b></p><img data-src="https://mmbiz.qpic.cn/img${i + 1}.jpg"/>`,
    })
  }
  store.saveArticles('F1', rows)
  return { store, dir }
}

function isZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7)
}

// find EOCD and central directory entries, return entry names
function zipEntries(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const count = buf.readUInt16LE(i + 10)
      const cdOff = buf.readUInt32LE(i + 16)
      const names = []
      let p = cdOff
      for (let k = 0; k < count; k++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break
        const nameLen = buf.readUInt16LE(p + 28)
        names.push(buf.slice(p + 46, p + 46 + nameLen).toString('utf8'))
        p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
      }
      return names
    }
  }
  return null
}

function zipRead(buf, name) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const count = buf.readUInt16LE(i + 10)
      const cdOff = buf.readUInt32LE(i + 16)
      let p = cdOff
      for (let k = 0; k < count; k++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break
        const nameLen = buf.readUInt16LE(p + 28)
        const n = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
        const method = buf.readUInt16LE(p + 10)
        const csize = buf.readUInt32LE(p + 20)
        const lfhOff = buf.readUInt32LE(p + 42)
        if (n === name) {
          const lfhNameLen = buf.readUInt16LE(lfhOff + 26)
          const dataStart = lfhOff + 30 + lfhNameLen + buf.readUInt16LE(lfhOff + 28)
          const raw = buf.slice(dataStart, dataStart + csize)
          if (method === 8) return inflateRawSync(raw)
          return raw
        }
        p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
      }
      return null
    }
  }
  return null
}

const ctxs = []
async function withStore(n, fn) {
  const { store, dir } = await makeStore(n)
  ctxs.push(dir)
  try { return await fn(store) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('md 导出为 zip 合集且每篇带 YAML frontmatter', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'md', { fetchImpl: FETCH_OK })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.count, 3)
    assert.ok(isZip(r.buf), 'md 应为 zip')
    const names = zipEntries(r.buf)
    assert.ok(names.includes('INDEX.md'), '应含 INDEX.md')
    const md = zipRead(r.buf, 'md/001_' + encodeURIComponent('文章1') + '.md')
    // 名字可能经 safeFileName 处理，直接找第一个 md/ 条目
    const first = names.find(n => n.startsWith('md/') && n.endsWith('.md'))
    const content = zipRead(r.buf, first).toString('utf8')
    assert.ok(content.startsWith('---'), 'frontmatter 应以 --- 开头')
    assert.ok(content.includes('title:'), 'frontmatter 应含 title')
  })
})

test('json 可解析且为 3 篇数组', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'json', {})
    assert.equal(r.ok, true, r.reason)
    const arr = JSON.parse(r.buf.toString('utf8'))
    assert.ok(Array.isArray(arr))
    assert.equal(arr.length, 3)
    assert.equal(arr[0].title, '文章1')
  })
})

test('html 单文件含 TOC 与标题', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'html', {})
    assert.equal(r.ok, true, r.reason)
    const html = r.buf.toString('utf8')
    assert.ok(html.toLowerCase().includes('<!doctype html'))
    assert.ok(html.includes('文章1'))
    assert.ok(html.includes('prefers-color-scheme'), '暗色适配')
  })
})

test('range since 过滤生效', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'json', { range: { since: NOW - 250 } })
    assert.equal(r.ok, true, r.reason)
    const arr = JSON.parse(r.buf.toString('utf8'))
    assert.equal(arr.length, 2, 'since=NOW-250 应只剩 2 篇')
  })
})

test('range days:N 过滤生效', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'json', { range: 'days:1' })
    assert.equal(r.ok, true, r.reason)
    const arr = JSON.parse(r.buf.toString('utf8'))
    assert.equal(arr.length, 3, '100~300 秒前都算 1 天内')
  })
})

test('上限截断 truncated 标记', async () => {
  await withStore(5, async (store) => {
    const r = await exportAccount(store, 'F1', 'pdf', { range: { since: NOW - 1000 }, fetchImpl: FETCH_OK })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.count, 5)
    assert.equal(r.truncated, false)
  })
})

test('xlsx 为合法 zip（OOXML）', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'xlsx', {})
    assert.equal(r.ok, true, r.reason)
    assert.ok(isZip(r.buf), 'xlsx 应为 zip')
    const names = zipEntries(r.buf)
    assert.ok(names.includes('[Content_Types].xml'))
    assert.ok(names.includes('xl/worksheets/sheet1.xml'))
  })
})

test('docx 为合法 zip 且含 document.xml', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'docx', { fetchImpl: FETCH_OK })
    assert.equal(r.ok, true, r.reason)
    assert.ok(isZip(r.buf), 'docx 应为 zip')
    const names = zipEntries(r.buf)
    assert.ok(names.includes('word/document.xml'))
  })
})

test('epub 为合法 zip 且 mimetype 首条目', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'epub', { fetchImpl: FETCH_OK })
    assert.equal(r.ok, true, r.reason)
    assert.ok(isZip(r.buf), 'epub 应为 zip')
    const names = zipEntries(r.buf)
    assert.equal(names[0], 'mimetype')
    const mt = zipRead(r.buf, 'mimetype').toString('utf8')
    assert.equal(mt, 'application/epub+zip')
  })
})

test('pdf 以 %PDF- 开头', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'pdf', {})
    assert.equal(r.ok, true, r.reason)
    assert.ok(r.buf.toString('latin1').startsWith('%PDF-1.4'))
  })
})

test('未知格式返回明确错误', async () => {
  await withStore(3, async (store) => {
    const r = await exportAccount(store, 'F1', 'txt', {})
    assert.equal(r.ok, false)
    assert.ok(r.reason)
  })
})
