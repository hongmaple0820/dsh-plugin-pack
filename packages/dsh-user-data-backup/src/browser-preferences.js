/** Portable preferences are limited to the theme's two session-sidebar keys. */
const VIEW = 'dsh-claude-style.session-browser-view'
const PROJECTS = 'dsh-claude-style.session-browser-projects'
export const preferenceFileLimit = 256 * 1024

export function validatePreferences(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data) ||
    Object.keys(data).length !== 3 || data.version !== 1 ||
    !['attention', 'projects', 'all'].includes(data.view) || !Array.isArray(data.projects) || data.projects.length > 256 ||
    data.projects.some(id => typeof id !== 'string' || id.length === 0 || id.length > 200) ||
    new Set(data.projects).size !== data.projects.length) throw new Error('Invalid sidebar preferences')
  return { version: 1, view: data.view, projects: [...data.projects] }
}

function snapshot(storage) { return [storage.getItem(VIEW), storage.getItem(PROJECTS)] }

export function exportPreferences(storage) {
  const [view, projects] = snapshot(storage)
  return validatePreferences({ version: 1, view: view ?? 'attention', projects: JSON.parse(projects ?? '[]') })
}

/** Bind a preview to this browser's current values, not to the host profile. */
export function previewPreferences(storage, data) {
  const next = validatePreferences(data)
  const before = snapshot(storage)
  let used = false
  return {
    view: next.view, count: next.projects.length,
    apply() {
      if (used) throw new Error('Sidebar preference preview has expired')
      used = true
      if (snapshot(storage).some((value, index) => value !== before[index])) throw new Error('Sidebar preferences changed after preview')
      // Write projects first: their longer value is the one most likely to exceed storage quota.
      storage.setItem(PROJECTS, JSON.stringify(next.projects))
      try { storage.setItem(VIEW, next.view) }
      catch (error) {
        try {
          if (before[1] === null) storage.removeItem(PROJECTS)
          else storage.setItem(PROJECTS, before[1])
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], 'Sidebar preferences may have been partially restored')
        }
        throw error
      }
    },
  }
}
