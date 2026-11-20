/** Settings UI uses the live authenticated Host API and never stores archive bytes in preferences. */
import React, { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './client.css'
import { RemoteSection, remoteCopy } from './remote-client.js'
import { BrowserPreferencesSection, browserCopy } from './browser-preferences-client.js'

const API = '/api/local-user-data.'
const copy = {
  en: {
    backup: 'Create a backup', restore: 'Restore from a backup', selection: 'Backup and restore contents', restoreIntro: 'Choose a ZIP file, review the changes, then apply the preview.',
    nav: 'Data management', intro: 'Export this profile or preview a restore before writing changes. Backups can contain personal data.',
    profile: 'Profile configuration', settings: 'Settings', sessions: 'Sessions', credentials: 'Credentials (not encrypted)',
    credentialWarning: 'I understand that exported credentials and recovery copies are not encrypted.',
    export: 'Download backup', file: 'Choose a ZIP backup', preview: 'Preview restore', apply: 'Apply this preview',
    changes: 'Restore preview', complete: 'Restore completed. Keep the recovery directory until you have checked the result.',
    partial: 'Restore did not complete. Review the per-file results and recovery directory before continuing.',
    restartRequired: 'Restart the host to reload the files that were restored.',
    failed: 'Operation failed', working: 'Working…', unavailable: 'The data management service is unavailable.',
    review: 'Review the listed files, settings namespaces and warnings before applying. Profile changes require a restart.',
    result: 'Operation results', empty: 'No archive selected', tooLarge: 'ZIP backup exceeds 64 MiB.',
    fileName: 'File', action: 'Change', bytes: 'Bytes', namespace: 'Settings section', recovery: 'Recovery directory',
    written: 'Restored', failedItem: 'Failed', skipped: 'Skipped', create: 'Create', replace: 'Replace',
    planExpiry: 'This preview expires at', settingsChanged: 'Settings to restore', noChanges: 'No changes selected.',
    warningPartial: 'Original values are saved privately before replacement. A restore can complete only in part.',
    warningExecutable: 'Profile configuration can execute code after a restart. Import only backups you trust.',
    warningCredentials: 'This archive and its recovery copy contain credentials without encryption.',
    warningProfileSecrets: 'Masked profile values keep their current target values. Sequences with masked values are kept as a whole. Missing target values prevent this preview.',
    ...browserCopy.en,
    ...remoteCopy.en,
  },
  zh: {
    backup: '创建备份', restore: '从备份恢复', selection: '备份与恢复内容', restoreIntro: '选择 ZIP 文件，检查变更后再应用预览。',
    nav: '数据管理', intro: '导出当前资料，或先预览恢复内容再写入。备份可能包含个人数据。',
    profile: '配置文件', settings: '设置', sessions: '会话', credentials: '凭据（未加密）',
    credentialWarning: '我理解导出的凭据和恢复副本均未加密。',
    export: '下载备份', file: '选择 ZIP 备份', preview: '预览恢复', apply: '应用此次预览',
    changes: '恢复预览', complete: '恢复完成。检查结果前请保留恢复目录。',
    partial: '恢复未完成。请先检查逐项结果和恢复目录，再进行其他操作。',
    restartRequired: '请重启宿主，以重新加载已恢复的文件。',
    failed: '操作失败', working: '正在处理…', unavailable: '数据管理服务当前不可用。',
    review: '请核对文件、设置命名空间和警告后再应用。配置文件变更需要重启生效。',
    result: '操作结果', empty: '尚未选择归档', tooLarge: 'ZIP 备份超过 64 MiB。',
    fileName: '文件', action: '变更', bytes: '字节数', namespace: '设置分区', recovery: '恢复目录',
    written: '已恢复', failedItem: '失败', skipped: '已跳过', create: '新建', replace: '替换',
    planExpiry: '此次预览失效时间', settingsChanged: '待恢复设置', noChanges: '未选择变更。',
    warningPartial: '替换前会保存私有恢复副本；恢复可能只完成部分内容。',
    warningExecutable: '配置文件可以在重启后执行代码。请仅导入信任的备份。',
    warningCredentials: '此次归档及其恢复副本包含未经加密的凭据。',
    warningProfileSecrets: '脱敏配置值保留目标机器的当前值；含脱敏值的数组整体保留。目标缺少相应值时无法生成此次预览。',
    ...browserCopy.zh,
    ...remoteCopy.zh,
  },
}
export const inject = ['slots', 'locale']

async function responseOf(response) {
  const result = await response.json()
  if (!response.ok && result.complete === undefined) throw new Error(result.error ?? `HTTP ${response.status}`)
  return result
}
const request = (action, options) => fetch(API + action, { credentials: 'same-origin', ...options }).then(responseOf)

/** All requests are cancelled on unmount; previews become invalid when their selection changes. */
function DataSection({ t }) {
  const [components, setComponents] = useState(['profile', 'settings'])
  const [confirmed, setConfirmed] = useState(false)
  const [file, setFile] = useState(null)
  const [plan, setPlan] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [context, setContext] = useState(null)
  const controller = useRef(null)
  const mounted = useRef(true)
  const download = useRef(null)
  useEffect(() => {
    const abort = new AbortController()
    mounted.current = true
    void request('context', { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setContext(value) })
      .catch(failure => { if (!abort.signal.aborted) setError(failure.message) })
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); if (download.current !== null) URL.revokeObjectURL(download.current) }
  }, [])
  const run = async task => {
    if (controller.current !== null || remoteBusy) return
    const abort = new AbortController()
    controller.current = abort
    setBusy(true); setError(null); setResult(null)
    try { await task(abort.signal) }
    catch (failure) { if (mounted.current && !abort.signal.aborted) setError(failure.message) }
    finally { controller.current = null; if (mounted.current) setBusy(false) }
  }
  const parameters = () => new URLSearchParams({ components: components.join(','), credentialsConfirmed: String(confirmed) }).toString()
  const disabled = busy || remoteBusy || context === null || components.length === 0 || (components.includes('credentials') && !confirmed)
  const h = React.createElement
  const choose = value => { setPlan(null); setResult(null); setComponents(value) }
  return h('section', { className: 'local-user-data', 'aria-busy': busy },
    h('header', { className: 'local-user-data-head' }, h('h2', null, t('nav')), h('p', { className: 'local-user-data-intro' }, t('intro'))),
    h('section', null, h('h3', null, t('selection')),
    h('fieldset', { disabled: busy || remoteBusy },
      ...['profile', 'settings', 'sessions', 'credentials'].map(component => h('label', { key: component, className: 'local-user-data-option' },
        h('input', { type: 'checkbox', checked: components.includes(component), disabled: context !== null && !context.components.includes(component),
          onChange: event => choose(event.target.checked ? [...components, component] : components.filter(value => value !== component)) }), ' ', t(component))),
      components.includes('credentials') ? h('label', { className: 'local-user-data-option local-user-data-option-wide' },
        h('input', { type: 'checkbox', checked: confirmed, onChange: event => { setConfirmed(event.target.checked); setPlan(null) } }), ' ', t('credentialWarning')) : null)),
    h('section', null, h('h3', null, t('backup')),
    h('p', { className: 'local-user-data-actions' }, h(Button, { disabled, onClick: () => void run(async signal => {
      const response = await fetch(API + 'export?' + parameters(), { signal, credentials: 'same-origin' })
      if (!response.ok) { await responseOf(response); return }
      const blob = await response.blob()
      if (signal.aborted) return
      if (download.current !== null) URL.revokeObjectURL(download.current)
      const url = URL.createObjectURL(blob)
      download.current = url
      const link = document.createElement('a')
      link.href = url; link.download = 'dsh-user-data-' + new Date().toISOString().replaceAll(':', '-') + '.zip'
      document.body.append(link); link.click(); link.remove()
    }) }, t('export')))),
    h('section', null, h('h3', null, t('restore')), h('p', null, t('restoreIntro')),
    h('label', { className: 'local-user-data-file' }, t('file'), h('input', { type: 'file', accept: '.zip,application/zip', disabled: busy || remoteBusy,
      onChange: event => { setFile(event.target.files?.[0] ?? null); setPlan(null); setResult(null) } })),
    h('p', null, h(Button, { disabled: disabled || file === null, onClick: () => void run(async signal => {
      setPlan(null)
      if (file.size > 64 * 1024 * 1024) throw new Error(t('tooLarge'))
      const bytes = await file.arrayBuffer()
      if (signal.aborted) return
      const value = await request('preview?' + parameters(), { method: 'POST', body: bytes, signal, headers: { 'content-type': 'application/zip' } })
      if (!signal.aborted) setPlan(value)
    }) }, t('preview')))),
    context === null && error === null ? h('p', { role: 'status' }, t('working')) : null,
    error === null ? null : h('p', { role: 'alert' }, t('failed') + ': ' + error),
    plan === null ? null : h('section', { 'aria-label': t('changes') }, h('h3', null, t('changes')), h('p', null, t('review')),
      h('ul', null, ...(plan.warningCodes ?? []).map(key => h('li', { key }, t(key)))),
      h('p', null, t('planExpiry') + ': ' + new Date(plan.expiresAt).toLocaleString()),
      plan.files.length === 0 ? null : h('div', { className: 'local-user-data-scroll' },
        h('table', { className: 'local-user-data-table' },
          h('thead', null, h('tr', null, ...['fileName', 'action', 'bytes'].map(key => h('th', { key, scope: 'col' }, t(key))))),
          h('tbody', null, ...plan.files.map(item => h('tr', { key: item.name }, h('td', null, item.name), h('td', null, t(item.action)), h('td', null, item.bytes.toLocaleString())))))),
      plan.settings.length === 0 ? null : h('div', null, h('h4', null, t('settingsChanged')), h('ul', null, ...plan.settings.map(item => h('li', { key: item.namespace }, item.namespace)))),
      h(Button, { disabled, onClick: () => void run(async signal => {
        const id = plan.planId
        setPlan(null)
        const value = await request('apply', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: id }) })
        if (!signal.aborted) setResult(value)
      }) }, t('apply'))),
    result === null ? null : h('section', { 'aria-label': t('result') }, h('p', { role: 'status' }, t(result.complete ? 'complete' : 'partial')),
      result.restartRequired ? h('p', null, t('restartRequired')) : null,
      ...[result.files, result.settings].map((group, index) => h('div', { key: index },
        group.recovery ? h('p', { className: 'local-user-data-path' }, t('recovery') + ': ' + group.recovery) : null,
        group.error ? h('p', { role: 'alert' }, group.error) : null,
        group.skipped ? h('p', null, t('skipped')) : null,
        h('ul', null, ...group.results.map((item, itemIndex) => h('li', { key: itemIndex },
          item.name ?? item.namespace, ': ', t(item.status === 'written' ? 'written' : 'failedItem'), item.error ? ` · ${item.error}` : '')))))),
    h(BrowserPreferencesSection, { t }),
    h(RemoteSection, { t, disabled: busy || context === null, parameters, onBusy: setRemoteBusy,
      onPreview: value => { setPlan(value); setResult(null); setError(null) } }))
}

/** A locale-owned settings contribution; unloading restores the host settings registry. */
export function apply(ctx) {
  const locale = 'local.userData'
  const t = ctx.locale.bind(locale)
  ctx.effect(() => {
    const element = document.createElement('style')
    element.textContent = styles
    document.head.append(element)
    return () => element.remove()
  })
  ctx.effect(() => ctx.locale.register(locale, copy))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'local-user-data',
    order: 42, label: () => t('nav'), locale }, DataSection))
}
