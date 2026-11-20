/** Browser preferences stay on this origin and are never sent to the Host. */
import React, { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { exportPreferences, preferenceFileLimit, previewPreferences } from './browser-preferences.js'

export const browserCopy = {
  en: {
    browserPreferences: 'Browser sidebar preferences',
    browserScope: 'This separate JSON file contains only the sidebar view and selected project identifiers. It does not include other browser storage or go to a remote destination.',
    browserExport: 'Download sidebar preferences', browserFile: 'Choose sidebar preferences JSON',
    browserApply: 'Restore sidebar preferences', browserRestored: 'Sidebar preferences restored. Reload this page to use them.',
    browserInvalid: 'Could not read or validate the sidebar preferences file.', browserChanged: 'Could not restore the preferences. Check current storage and preview again.',
    browserSaveFailed: 'Could not export the current sidebar preferences.', browserProjects: 'Selected projects',
    browserAttention: 'Attention', browserAll: 'All', browserProjectsView: 'Projects',
  },
  zh: {
    browserPreferences: '浏览器侧栏偏好',
    browserScope: '此独立 JSON 文件只包含侧栏视图和所选项目标识，不包含其他浏览器数据，也不会上传到远程位置。',
    browserExport: '下载侧栏偏好', browserFile: '选择侧栏偏好 JSON 文件',
    browserApply: '恢复侧栏偏好', browserRestored: '侧栏偏好已恢复。刷新此页面后生效。',
    browserInvalid: '无法读取或验证侧栏偏好文件。', browserChanged: '无法恢复侧栏偏好，请检查当前存储并重新预览。',
    browserSaveFailed: '无法导出当前侧栏偏好。', browserProjects: '所选项目数',
    browserAttention: '关注', browserAll: '全部', browserProjectsView: '项目',
  },
}
const viewCopy = { attention: 'browserAttention', all: 'browserAll', projects: 'browserProjectsView' }

export function BrowserPreferencesSection({ t }) {
  const [plan, setPlan] = useState(null)
  const [notice, setNotice] = useState(null)
  const generation = useRef(0)
  const h = React.createElement
  const download = () => {
    try {
      const bytes = JSON.stringify(exportPreferences(localStorage), null, 2)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }))
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = 'dsh-sidebar-preferences.json'
        link.click()
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 0) }
      setNotice(null)
    } catch { setNotice('browserSaveFailed') }
  }
  const choose = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    const reading = ++generation.current
    setPlan(null)
    setNotice(null)
    if (file === undefined) return
    try {
      if (file.size > preferenceFileLimit) throw new Error('Sidebar preference file exceeds the size limit')
      const data = JSON.parse(await file.text())
      if (reading === generation.current) setPlan(previewPreferences(localStorage, data))
    } catch { if (reading === generation.current) setNotice('browserInvalid') }
  }
  return h('section', { 'aria-label': t('browserPreferences') },
    h('h3', null, t('browserPreferences')), h('p', null, t('browserScope')),
    h('p', null, h(Button, { onClick: download }, t('browserExport'))),
    h('label', null, t('browserFile'), ' ', h('input', { type: 'file', accept: '.json,application/json', onChange: choose })),
    plan === null ? null : h('div', null,
      h('p', null, t(viewCopy[plan.view]), ' · ', t('browserProjects'), ': ', plan.count.toLocaleString()),
      h(Button, { onClick: () => {
        setPlan(null)
        try { plan.apply(); setNotice('browserRestored') }
        catch { setNotice('browserChanged') }
      } }, t('browserApply'))),
    notice === null ? null : h('p', { role: notice === 'browserRestored' ? 'status' : 'alert' }, t(notice)))
}
