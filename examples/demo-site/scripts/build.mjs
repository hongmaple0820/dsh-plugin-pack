// 构建步骤示意：把 source/index.html 渲染成 dist/index.html
// 运行环境是 plugin 所在的机器（这里就是本机 Windows / Node 22）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = process.cwd()
const releaseId = process.env.RELEASE_ID || 'dev'
const commit = process.env.COMMIT || 'local'
const startedAt = new Date().toISOString()

const template = readFileSync(join(root, 'source', 'index.html'), 'utf8')
const html = template
  .replaceAll('{{RELEASE_ID}}', releaseId)
  .replaceAll('{{COMMIT}}', commit)
  .replaceAll('{{BUILT_AT}}', startedAt)

mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist', 'index.html'), html)
console.log(`rendered dist/index.html for ${releaseId} (${commit}) at ${startedAt}`)