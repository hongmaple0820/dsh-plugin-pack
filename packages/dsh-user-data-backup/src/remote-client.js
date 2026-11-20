/** Remote settings keep secret inputs ephemeral and use the same preview-first restore flow. */
import React, { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

export const remoteCopy = {
  en: {
    destination: 'Destination settings',
    remote: 'Remote backups', remoteIntro: 'Save a WebDAV or S3-compatible destination. Secrets are stored in the host credential provider. Automatic backups exclude credentials.',
    kind: 'Storage type', endpoint: 'HTTPS endpoint', prefix: 'Backup directory', bucket: 'Bucket', region: 'Region', pathStyle: 'Use path-style S3 URLs',
    username: 'Username', password: 'Password', accessKey: 'Access key', secretKey: 'Secret key', sessionToken: 'Session token (optional)',
    secretHint: 'Leave secret fields empty to keep their saved values.', keep: 'Backups to keep', interval: 'Automatic backup interval (minutes; 0 turns it off)',
    saveRemote: 'Save destination', testRemote: 'Test saved destination', pushRemote: 'Back up now', listRemote: 'Refresh backups',
    downloadRemote: 'Download', previewRemote: 'Preview restore', deleteRemote: 'Delete', confirmDeleteRemote: 'Confirm deletion', cancelRemote: 'Cancel',
    noBackups: 'No remote backups found.', remoteSaved: 'Destination saved.', remotePassed: 'Destination is reachable.', remotePushed: 'Backup uploaded and verified.',
    remoteDeleted: 'Backup deleted.', remoteBusy: 'A remote operation is running.', remoteNever: 'No backup has run yet.',
    remoteLast: 'Last backup', remoteNext: 'Next automatic backup', remoteFailed: 'Remote operation failed. Check destination access and saved credentials.',
    remoteRetentionFailed: 'The new backup was verified, but old backups could not all be removed.',
    remoteComponents: 'Components for remote backups', remoteUnconfigured: 'Save a destination before using remote backups.',
  },
  zh: {
    destination: '目标设置',
    remote: '远程备份', remoteIntro: '保存 WebDAV 或兼容 S3 的目标。密钥保存在宿主凭据服务中，自动备份不包含凭据。',
    kind: '存储类型', endpoint: 'HTTPS 地址', prefix: '备份目录', bucket: '存储桶', region: '区域', pathStyle: '使用 S3 路径形式地址',
    username: '用户名', password: '密码', accessKey: '访问密钥标识', secretKey: '访问密钥', sessionToken: '临时令牌（可选）',
    secretHint: '密钥输入留空时保留已保存的值。', keep: '保留备份数量', interval: '自动备份间隔（分钟，0 表示关闭）',
    saveRemote: '保存目标', testRemote: '测试已保存目标', pushRemote: '立即备份', listRemote: '刷新备份列表',
    downloadRemote: '下载', previewRemote: '预览恢复', deleteRemote: '删除', confirmDeleteRemote: '确认删除', cancelRemote: '取消',
    noBackups: '远端暂无备份。', remoteSaved: '目标已保存。', remotePassed: '目标可以访问。', remotePushed: '备份已上传并通过回读校验。',
    remoteDeleted: '备份已删除。', remoteBusy: '正在执行远程操作。', remoteNever: '尚未执行过备份。',
    remoteLast: '最近备份', remoteNext: '下次自动备份', remoteFailed: '远程操作失败。请检查目标访问权限和保存的凭据。',
    remoteRetentionFailed: '新备份已通过校验，但未能清理全部过期备份。',
    remoteComponents: '远程备份内容', remoteUnconfigured: '请先保存目标再使用远程备份。',
  },
}
const API = '/api/local-user-data.remote.'
const h = React.createElement

export function RemoteSection({ t, disabled, parameters, onPreview, onBusy }) {
  const [status, setStatus] = useState(null)
  const [config, setConfig] = useState({ kind: 'webdav', endpoint: '', prefix: 'dsh-backups', bucket: '', region: 'us-east-1', keep: 20, intervalMs: 0, components: ['profile', 'settings'] })
  const [secrets, setSecrets] = useState({})
  const [items, setItems] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const controller = useRef(null)
  const download = useRef(null)
  const call = async (action, signal, body) => {
    const response = await fetch(API + action, { signal, credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    if (response.headers.get('content-type')?.startsWith('application/zip') && response.ok) return response.blob()
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
    return result
  }
  useEffect(() => {
    const abort = new AbortController()
    void call('status', abort.signal).then(value => {
      if (abort.signal.aborted) return
      setStatus(value)
      if (value.config !== null) setConfig(value.config)
    }).catch(failure => { if (!abort.signal.aborted) setError(failure.message) })
    return () => { abort.abort(); controller.current?.abort(); if (download.current) URL.revokeObjectURL(download.current) }
  }, [])
  const run = async task => {
    if (controller.current !== null || disabled) return
    const abort = new AbortController()
    controller.current = abort
    setBusy(true); onBusy(true); setError(null); setMessage(null)
    try {
      await task(abort.signal)
      const value = await call('status', abort.signal)
      if (!abort.signal.aborted) setStatus(value)
    } catch (failure) { if (!abort.signal.aborted) setError(failure.message) }
    finally { controller.current = null; if (!abort.signal.aborted) { setBusy(false); onBusy(false) } }
  }
  const field = (key, type = 'text', secret = false) => h('label', { key, className: 'local-user-data-field' }, t(key), ' ',
    h('input', { type, autoComplete: secret ? 'new-password' : 'off', value: secret ? secrets[key] ?? '' : config[key] ?? '',
      onChange: event => secret ? setSecrets({ ...secrets, [key]: event.target.value }) : setConfig({ ...config, [key]: type === 'number' ? Number(event.target.value) : event.target.value }) }))
  const action = (key, task, needsSaved = true) => h(Button, { disabled: disabled || busy || (needsSaved && !status?.config), onClick: () => void run(task) }, t(key))
  return h('section', { 'aria-label': t('remote'), 'aria-busy': busy },
    h('h3', null, t('remote')), h('p', null, t('remoteIntro')),
    h('details', { className: 'local-user-data-destination' }, h('summary', null, t('destination')),
    h('fieldset', { disabled: disabled || busy },
      h('label', { className: 'local-user-data-field' }, t('kind'), ' ', h('select', { 'aria-label': t('kind'), value: config.kind, onChange: event => setConfig({ ...config, kind: event.target.value }) }, h('option', { value: 'webdav' }, 'WebDAV'), h('option', { value: 's3' }, 'S3'))),
      field('endpoint', 'url'), field('prefix'),
      config.kind === 'webdav' ? h(React.Fragment, null, field('username', 'text', true), field('password', 'password', true))
        : h(React.Fragment, null, field('bucket'), field('region'), field('accessKey', 'password', true), field('secretKey', 'password', true), field('sessionToken', 'password', true),
          h('label', { className: 'local-user-data-check' }, h('input', { type: 'checkbox', checked: config.forcePathStyle === true, onChange: event => setConfig({ ...config, forcePathStyle: event.target.checked }) }), ' ', t('pathStyle'))),
      h('p', null, t('secretHint')), field('keep', 'number'),
      h('label', { className: 'local-user-data-field' }, t('interval'), ' ', h('input', { type: 'number', min: 0, max: 43200, value: config.intervalMs / 60000,
        onChange: event => setConfig({ ...config, intervalMs: Number(event.target.value) * 60000 }) })),
      h('fieldset', { className: 'local-user-data-checks' }, h('legend', null, t('remoteComponents')), ...['profile', 'settings', 'sessions'].map(component => h('label', { key: component, className: 'local-user-data-check' },
        h('input', { type: 'checkbox', checked: config.components.includes(component), onChange: event => setConfig({ ...config, components: event.target.checked ? [...config.components, component] : config.components.filter(value => value !== component) }) }), ' ', t(component))))),
    h('p', null, action('saveRemote', async signal => {
      const value = await call('save', signal, { config, secrets })
      if (!signal.aborted) { setConfig(value.config); setSecrets({}); setItems(null); setMessage('remoteSaved') }
    }, false))),
    h('p', { className: 'local-user-data-actions' }, action('testRemote', async signal => { await call('run', signal, { action: 'test' }); if (!signal.aborted) setMessage('remotePassed') }), ' ',
      action('pushRemote', async signal => { await call('run', signal, { action: 'push' }); if (!signal.aborted) { setItems(null); setMessage('remotePushed') } }), ' ',
      action('listRemote', async signal => { const value = await call('run', signal, { action: 'list' }); if (!signal.aborted) setItems(value) })),
    status?.config ? h('p', null, status.last === null ? t('remoteNever') : `${t('remoteLast')}: ${new Date(status.last.at).toLocaleString()}${status.last.success ? '' : ` · ${t('remoteFailed')}`}`,
      status.nextAt === null ? null : ` · ${t('remoteNext')}: ${new Date(status.nextAt).toLocaleString()}`) : h('p', null, t('remoteUnconfigured')),
    status?.last?.retentionFailed ? h('p', { role: 'status' }, t('remoteRetentionFailed')) : null,
    busy ? h('p', { role: 'status' }, t('remoteBusy')) : null,
    message ? h('p', { role: 'status' }, t(message)) : null,
    error ? h('p', { role: 'alert' }, `${t('failed')}: ${error}`) : null,
    items?.length === 0 ? h('p', null, t('noBackups')) : null,
    items === null ? null : h('ul', { className: 'local-user-data-remote-list' }, ...items.map(item => h('li', { key: item.name, className: 'local-user-data-remote-item' },
      h('span', { className: 'local-user-data-remote-name' }, item.name, ` (${item.bytes.toLocaleString()} B)`), ' ',
      action('downloadRemote', async signal => {
        const blob = await call('run', signal, { action: 'download', name: item.name })
        if (signal.aborted) return
        if (download.current) URL.revokeObjectURL(download.current)
        download.current = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = download.current; link.download = item.name; document.body.append(link); link.click(); link.remove()
      }), ' ', action('previewRemote', async signal => {
        const value = await call('run?' + parameters(), signal, { action: 'preview', name: item.name })
        if (!signal.aborted) onPreview(value)
      }), ' ', deleting === item.name ? h(React.Fragment, null,
        action('confirmDeleteRemote', async signal => { await call('run', signal, { action: 'delete', name: item.name }); if (!signal.aborted) { setDeleting(null); setItems(items.filter(value => value.name !== item.name)); setMessage('remoteDeleted') } }), ' ',
        h(Button, { disabled: disabled || busy, onClick: () => setDeleting(null) }, t('cancelRemote')))
        : h(Button, { disabled: disabled || busy, onClick: () => setDeleting(item.name) }, t('deleteRemote'))))))
}
