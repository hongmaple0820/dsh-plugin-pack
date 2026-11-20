/** Exact Fetch routes inherit the Connection carrier's owner-only authentication. */
import { DEFAULT_LIMITS } from './archive.js'

export const API = '/api/local-user-data.'
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Streaming reads enforce limits even when the sender omits Content-Length. */
export async function requestBytes(request, maximum) {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('Request exceeds size limit')
  if (request.body === null) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > maximum) throw new Error('Request exceeds size limit')
      chunks.push(Buffer.from(next.value))
    }
  } finally { await reader.cancel().catch(error => { /* A disconnected request already owns its transport error. */ }); reader.releaseLock() }
  return Buffer.concat(chunks)
}
const optionsOf = request => {
  const url = new URL(request.url)
  const components = url.searchParams.get('components')
  return { ...(components === null ? {} : { components: components.split(',') }), credentialsConfirmed: url.searchParams.get('credentialsConfirmed') === 'true' }
}

/** Stop admission, remove registrations and drain requests before disposing their manager. */
export function registerDataRoutes(connection, manager, remote) {
  const pending = new Set()
  const disposers = []
  let closing = false
  const register = (name, methods, maximum, handle) => {
    disposers.push(connection.fetch.register({ path: API + name, methods, requestBody: methods.includes('POST') ? 'streaming' : 'buffered', fetch: request => {
      if (closing) return Promise.resolve(json({ code: 'DATA_UNAVAILABLE', error: 'Data management is stopping' }, 503))
      const operation = (async () => {
        try { return await handle(request, maximum) }
        catch (error) { return json({ code: 'DATA_OPERATION_FAILED', error: error.message }, 400) }
      })()
      pending.add(operation)
      void operation.finally(() => pending.delete(operation))
      return operation
    } }))
  }
  try {
    register('context', ['GET'], 0, async () => json(manager.context()))
    register('export', ['GET'], 0, async request => {
      const archive = await manager.export(optionsOf(request))
      return new Response(archive.bytes, { headers: { 'content-type': 'application/zip', 'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="dsh-user-data-' + new Date().toISOString().replaceAll(':', '-') + '.zip"' } })
    })
    register('preview', ['POST'], DEFAULT_LIMITS.archiveBytes, async (request, maximum) =>
      json(await manager.preview(await requestBytes(request, maximum), optionsOf(request))))
    if (remote) {
      register('remote.status', ['GET'], 0, async () => json(remote.status()))
      register('remote.save', ['POST'], 65536, async (request, maximum) => {
        const value = JSON.parse((await requestBytes(request, maximum)).toString('utf8'))
        if (value === null || typeof value !== 'object' || value.config === null || typeof value.config !== 'object'
          || (value.secrets !== undefined && (value.secrets === null || typeof value.secrets !== 'object' || Array.isArray(value.secrets)))) throw new Error('Invalid remote configuration')
        return json(await remote.save(value.config, value.secrets))
      })
      register('remote.run', ['POST'], 4096, async (request, maximum) => {
        const value = JSON.parse((await requestBytes(request, maximum)).toString('utf8'))
        if (value === null || typeof value !== 'object' || !['list', 'test', 'push', 'delete', 'download', 'preview'].includes(value.action)) throw new Error('Invalid remote action')
        const result = await remote.run(value.action === 'preview' ? 'download' : value.action, value.name)
        if (value.action === 'preview') return json(await manager.preview(result, optionsOf(request)))
        if (value.action === 'download') return new Response(result, { headers: { 'content-type': 'application/zip', 'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${value.name}"` } })
        return json(result)
      })
    }
    register('apply', ['POST'], 4096, async (request, maximum) => {
      const value = JSON.parse((await requestBytes(request, maximum)).toString('utf8'))
      if (value === null || typeof value !== 'object' || typeof value.planId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.planId)) throw new Error('Invalid restore plan')
      const result = await manager.apply(value.planId)
      return json(result, result.complete ? 200 : 409)
    })
  } catch (error) {
    closing = true
    void Promise.allSettled(disposers.map(dispose => dispose())).then(async () => { await remote?.dispose(); manager.dispose() })
    throw error
  }
  return async () => {
    closing = true
    await Promise.allSettled(disposers.map(dispose => dispose()))
    await Promise.allSettled([...pending])
    await remote?.dispose()
    manager.dispose()
  }
}
