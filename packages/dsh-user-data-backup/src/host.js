/** Independent data management for the active profile, using published Cordis services. */
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import { createDataManager } from './service.js'
import { registerDataRoutes } from './routes.js'
import { createRemoteManager } from './remote-manager.js'

export const name = 'local-user-data-backup'
export const inject = ['connection', 'settings', 'agents']

/** File identifiers are resolved only for admission checks, never used to choose roots. */
const sessionId = relative => relative.split('/')[0].replace(/\.(?:jsonl|json)$/, '')

/** Registers authenticated routes and drains their requests on plugin disposal. */
export async function apply(ctx) {
  const profile = ctx.get('profileContext')
  if (typeof profile?.home !== 'string' || typeof profile.dir !== 'string' || typeof profile.name !== 'string') throw new Error('The active profile context is unavailable')
  const manager = await createDataManager({ profile, settings: ctx.settings, sessionFormatVersion: SESSION_FORMAT_VERSION,
    isSessionActive: relative => ctx.agents.get(sessionId(relative))?.status === 'running',
    isSessionRetained: relative => ctx.agents.get(sessionId(relative)) !== undefined })
  let remote
  try {
    remote = await createRemoteManager({ home: profile.home, data: manager, credentials: ctx.get('credentials') })
    ctx.effect(() => registerDataRoutes(ctx.connection, manager, remote))
  } catch (error) { await remote?.dispose(); manager.dispose(); throw error }
}
