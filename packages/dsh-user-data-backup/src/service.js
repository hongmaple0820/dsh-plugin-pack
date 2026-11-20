/** A preview binds selected archive bytes, current file hashes and live settings revisions. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createArchive, readArchive } from './archive.js'
import { collectFiles, selection, PROFILE_FILES } from './collect.js'
import { createRestoreManager } from './restore.js'
import { prepareSettings, verifySettings, applySettings } from './settings.js'
import { uniqueArchivePaths } from './paths.js'
import { prepareProfileFile } from './profile.js'

/** The adapter supplies active profile facts and session admission; requests cannot choose filesystem roots. */
export async function createDataManager({ profile, settings, sessionFormatVersion, isSessionActive, isSessionRetained,
  ttlMs = 300000, maxPlans = 8 }) {
  const recoveryDirectory = join(profile.home, 'user-data-recovery')
  const sessionRoot = join(profile.home, 'sessions')
  await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 })
  await mkdir(sessionRoot, { recursive: true })
  const restore = await createRestoreManager({ roots: { profile: profile.dir, sessions: sessionRoot, credentials: profile.home },
    recoveryDirectory, isSessionActive: isSessionRetained, prepareFile: prepareProfileFile, ttlMs, maxPlans })
  const plans = new Map()
  let disposed = false
  let applying = false
  let preparing = false
  async function prepare(task) {
    assertActive()
    if (preparing || applying) throw new Error('Another data operation is running')
    preparing = true
    try { return await task() } finally { preparing = false }
  }
  const assertActive = () => { if (disposed) throw new Error('Data management is unavailable') }
  const expire = () => { for (const [id, plan] of plans) if (plan.expiresAt <= Date.now()) plans.delete(id) }
  function selected(options = {}) {
    const components = selection(options.components ?? ['profile', 'settings'])
    if (components.includes('credentials') && options.credentialsConfirmed !== true) throw new Error('Credentials require explicit confirmation: exported bytes are not encrypted')
    if (components.includes('sessions') && !Number.isSafeInteger(sessionFormatVersion)) throw new Error('Session format is unavailable')
    return components
  }
  return {
    context() { assertActive(); return { profile: profile.name, components: ['profile', ...(settings === undefined ? [] : ['settings']), 'sessions', 'credentials'], recoveryDirectory } },
    export(options) { return prepare(async () => {
      const components = selected(options)
      const files = await collectFiles({ profile, settings, components, isSessionActive })
      assertActive()
      return createArchive(files, { profile: profile.name, ...(components.includes('sessions') ? { sessionFormatVersion } : {}) })
    }) },
    preview(bytes, options) { return prepare(async () => {
      expire()
      if (plans.size >= maxPlans) throw new Error('Too many pending restore previews')
      const components = selected(options)
      const archive = await readArchive(bytes)
      const entries = uniqueArchivePaths(archive.files.map(file => file.name))
      const files = archive.files.filter((_file, index) => components.includes(entries[index].component))
      if (files.length === 0) throw new Error('Backup contains none of the selected components')
      let settingsPlan = []
      const restoredFiles = []
      for (const file of files) {
        const entry = uniqueArchivePaths([file.name])[0]
        if (entry.component === 'settings') {
          if (entry.relative !== 'sections.json' || settings === undefined) throw new Error('Settings snapshot is unsupported')
          settingsPlan = prepareSettings(settings, JSON.parse(Buffer.from(file.bytes).toString('utf8')))
        } else {
          if (entry.component === 'profile' && !PROFILE_FILES.includes(entry.relative)) throw new Error('Profile file is not allowed')
          if (entry.component === 'credentials' && entry.relative !== '.credentials.yaml') throw new Error('Credential file is not allowed')
          if (entry.component === 'sessions' && archive.manifest.sessionFormatVersion !== sessionFormatVersion) throw new Error('Session format differs from this Host')
          restoredFiles.push(file)
        }
      }
      const filePlan = restoredFiles.length === 0 ? null : await restore.preview(restoredFiles)
      assertActive()
      const planId = randomUUID()
      const expiresAt = Math.min(Date.now() + ttlMs, filePlan?.expiresAt ?? Infinity)
      plans.set(planId, { filePlan, settingsPlan, expiresAt, archiveDigest: archive.digest })
      return { planId, expiresAt, archiveDigest: archive.digest, files: filePlan?.files ?? [],
        settings: settingsPlan.map(item => ({ namespace: item.ns, revision: item.revision })),
        warningCodes: ['warningPartial',
          ...(restoredFiles.some(file => file.name.startsWith('profile/')) ? ['warningExecutable', 'warningProfileSecrets'] : []),
          ...(restoredFiles.some(file => file.name.startsWith('credentials/')) ? ['warningCredentials'] : [])],
        warnings: ['Restore preserves a private recovery copy and may report partial completion.',
          ...(restoredFiles.some(file => file.name.startsWith('profile/')) ? ['Profile configuration is applied on the next restart; review executable configuration before importing.', 'Masked profile values preserve current target values; sequences containing masked values remain unchanged. Missing target values prevent preview.'] : []),
          ...(restoredFiles.some(file => file.name.startsWith('credentials/')) ? ['Credentials in this backup and recovery copy are not encrypted.'] : [])] }
    }) },
    async apply(planId) {
      assertActive()
      expire()
      if (applying || preparing) throw new Error('Another data operation is running')
      const plan = plans.get(planId)
      if (plan === undefined) throw new Error('Restore preview has expired')
      plans.delete(planId)
      applying = true
      try {
        if (plan.settingsPlan.length > 0) verifySettings(settings, plan.settingsPlan)
        const fileResult = plan.filePlan === null ? { complete: true, results: [] } : await restore.apply(plan.filePlan.planId)
        const restartRequired = fileResult.results.length > 0
        if (!fileResult.complete) return { complete: false, files: fileResult, settings: { complete: false, results: [], skipped: true }, restartRequired }
        assertActive()
        const settingsResult = await applySettings(settings, plan.settingsPlan, restore.checkRecoveryDirectory)
        return { complete: settingsResult.complete, files: fileResult, settings: settingsResult, restartRequired }
      } finally { applying = false }
    },
    dispose() { disposed = true; plans.clear(); restore.dispose() },
  }
}
