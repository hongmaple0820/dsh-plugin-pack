/** Verify a packed plugin with the installed DSH and browser, in a new private home. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import webdav from 'webdav-server'
const { values } = parseArgs({ options: { archive: { type: 'string' }, cli: { type: 'string' }, chrome: { type: 'string' } } })
for (const key of ['archive', 'cli', 'chrome']) if (!values[key]) throw new Error(`Missing --${key}`)
const home = path.resolve('.debug', 'install-verification-' + randomUUID())
fs.mkdirSync(home, { recursive: true, mode: 0o700 })
const env = { ...process.env, DSH_HOME: home }
function launch(args, synchronous = false) {
  const cli = path.resolve(values.cli)
  let command = cli
  let argv = args
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) {
    const all = [cli, ...args]
    if (all.some(value => /["%\r\n&|<>^!]/.test(value))) throw new Error('Unsupported command path character')
    command = process.env.ComSpec ?? 'cmd.exe'
    argv = ['/d', '/s', '/c', '"' + all.map(value => `"${value}"`).join(' ') + '"']
  }
  const options = { cwd: home, env, windowsHide: true, windowsVerbatimArguments: command !== cli }
  return synchronous ? spawnSync(command, argv, { ...options, encoding: 'utf8' }) : spawn(command, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
}
const installed = launch(['plugin', '--profile', 'web', 'add', path.resolve(values.archive)], true)
if (installed.status !== 0) throw new Error(installed.stdout + installed.stderr)
const profile = path.join(home, 'profiles/web')
const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
assert.equal(Object.hasOwn(manifest.dependencies, 'dsh-claude-style'), false)
const local = path.join(profile, 'node_modules/@local/dsh-user-data-backup')
assert.ok(fs.realpathSync(local).startsWith(fs.realpathSync(home) + path.sep))
const packed = fs.readFileSync(path.join(local, 'package.json'), 'utf8')
assert.equal(packed.includes('file:'), false)
assert.equal(JSON.parse(packed).main, './lib/host.js')
assert.deepEqual(JSON.parse(packed).dependencies ?? {}, {})
const child = launch(['--profile', 'web', '--port', '0', '--no-open'])
const stop = () => {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}
process.on('exit', stop)
let browser
let dav
let http
try {
  const url = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error('Verification host did not start')), 60000)
    const watch = chunk => {
      output += chunk
      const match = output.match(/dsh web: (http\S+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Host exited ${code}`)) })
  })
  const directory = path.join(home, 'dav')
  fs.mkdirSync(directory)
  const username = randomUUID()
  const password = randomUUID()
  const users = new webdav.v2.SimpleUserManager()
  const user = users.addUser(username, password, false)
  const privileges = new webdav.v2.SimplePathPrivilegeManager()
  privileges.setRights(user, '/', ['all'])
  dav = new webdav.v2.WebDAVServer({ httpAuthentication: new webdav.v2.HTTPBasicAuthentication(users), privilegeManager: privileges })
  await new Promise((resolve, reject) => dav.setFileSystem('/', new webdav.v2.PhysicalFileSystem(directory), success => success ? resolve() : reject(new Error('DAV filesystem unavailable'))))
  let denyDeletes = false
  dav.beforeRequest((ctx, next) => {
    if (denyDeletes && ctx.request.method === 'DELETE') { ctx.setCode(403); ctx.exit(); return }
    next()
  })
  http = await new Promise(resolve => dav.start(0, resolve))
  browser = await chromium.launch({ executablePath: path.resolve(values.chrome), headless: true })
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(async () => (await fetch('/api/local-user-data.context')).ok)
  // Answer first-run notices through their own controls; Escape is ignored by the account wizard.
  const layers = page.locator('[role="dialog"]:not([data-shortcut-modal="sidebar"]):visible, [role="presentation"]:visible')
  const attempted = new Map()
  const deadline = Date.now() + 20_000
  let quietSince = Date.now()
  while (Date.now() < deadline && Date.now() - quietSince < 2_000) {
    if (await layers.count() !== 0) {
      quietSince = Date.now()
      const layer = layers.last()
      const text = await layer.innerText()
      const buttons = layer.getByRole('button')
      const later = layer.getByRole('button', { name: /稍后|以后|not now|later|skip/i })
      const index = attempted.get(text) ?? 0
      if (await later.count() === 1 && index === 0) await later.click({ timeout: 2_000 })
      else if (index < await buttons.count()) await buttons.nth(index).click({ timeout: 2_000 })
      attempted.set(text, index + 1)
    }
    await page.waitForTimeout(250)
  }
  assert.equal(await layers.count(), 0, 'First-run dialogs did not close')
  await page.getByRole('button', { name: '账号菜单', exact: true }).click()
  await page.getByText('设置', { exact: true }).first().click()
  await page.getByText('数据管理', { exact: true }).first().click()
  await page.getByRole('heading', { name: '远程备份', exact: true }).waitFor()
  const sidebarPrefs = { version: 1, view: 'all', projects: ['verification-project'] }
  await page.evaluate(() => localStorage.setItem('unrelated-verification-key', 'untouched'))
  await page.getByLabel('选择侧栏偏好 JSON 文件', { exact: true }).setInputFiles({
    name: 'sidebar.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sidebarPrefs)),
  })
  await page.getByRole('button', { name: '恢复侧栏偏好', exact: true }).click()
  await page.getByText('侧栏偏好已恢复。刷新此页面后生效。', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('unrelated-verification-key')), 'untouched')
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载侧栏偏好', exact: true }).click()
  const downloaded = await downloading
  assert.deepEqual(JSON.parse(fs.readFileSync(await downloaded.path(), 'utf8')), sidebarPrefs)
  const prefsInput = page.getByLabel('选择侧栏偏好 JSON 文件', { exact: true })
  const uploadPrefs = value => prefsInput.setInputFiles({
    name: 'sidebar.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
  })
  await uploadPrefs({ ...sidebarPrefs, unrelated: 'not allowed' })
  await page.getByText('无法读取或验证侧栏偏好文件。', { exact: true }).waitFor()
  await uploadPrefs(sidebarPrefs)
  const applyPreferences = page.getByRole('button', { name: '恢复侧栏偏好', exact: true })
  await applyPreferences.waitFor()
  await page.evaluate(() => localStorage.setItem('dsh-claude-style.session-browser-view', 'projects'))
  await applyPreferences.click()
  await page.getByText('无法恢复侧栏偏好，请检查当前存储并重新预览。', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('dsh-claude-style.session-browser-view')), 'projects')
  const destination = page.locator('.local-user-data-destination > summary')
  assert.equal(await page.getByLabel('HTTPS 地址', { exact: true }).isVisible(), false)
  await destination.press('Enter')
  await page.getByLabel('HTTPS 地址', { exact: true }).fill(`http://127.0.0.1:${http.address().port}`)
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('保留备份数量', { exact: true }).fill('1')
  await page.getByRole('button', { name: '保存目标', exact: true }).click()
  await page.getByText('目标已保存。', { exact: true }).waitFor()
  const configuration = fs.readFileSync(path.join(home, 'local-user-data/remote.json'), 'utf8')
  assert.equal(configuration.includes(username), false)
  assert.equal(configuration.includes(password), false)
  await page.getByRole('button', { name: '立即备份', exact: true }).click()
  await page.getByText('备份已上传并通过回读校验。', { exact: true }).waitFor({ timeout: 20000 })
  assert.equal(fs.readdirSync(path.join(directory, 'dsh-backups')).length, 1)
  denyDeletes = true
  await page.getByRole('button', { name: '立即备份', exact: true }).click()
  await page.getByText('新备份已通过校验，但未能清理全部过期备份。', { exact: true }).waitFor({ timeout: 20000 })
  assert.equal(fs.readdirSync(path.join(directory, 'dsh-backups')).length, 2)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ tarballInstalled: true, noSourceLink: true, noThemeDependency: true, authenticatedDavUi: true, credentialsNotInConfig: true, retentionWarning: true, errors }))
} finally {
  await browser?.close()
  stop()
  process.off('exit', stop)
  http?.closeAllConnections?.()
  if (dav) await new Promise(resolve => dav.stop(resolve))
}
