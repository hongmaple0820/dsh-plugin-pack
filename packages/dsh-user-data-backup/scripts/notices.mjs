/** Record licenses of packages actually included in the Node bundle. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Emit package license and notice files beside the distributed bundle. */
export async function writeBundledNotices(root, metafile) {
  const packages = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) continue
    let directory = dirname(resolve(root, input))
    while (directory !== dirname(directory)) {
      let source
      try { source = await readFile(join(directory, 'package.json'), 'utf8') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (source !== undefined) {
        const manifest = JSON.parse(source)
        if (manifest.name && manifest.version) { packages.set(directory, manifest); break }
      }
      directory = dirname(directory)
    }
  }
  const sections = ['Third-party software included in lib/host.js. Source packages retain their respective licenses.']
  for (const [directory, manifest] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)).sort()
    const texts = []
    for (const name of names) texts.push(`${name}\n${await readFile(join(directory, name), 'utf8')}`)
    sections.push(`${manifest.name}@${manifest.version}\nLicense: ${typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? 'See package source')}\n${texts.join('\n\n')}`)
  }
  await writeFile(join(root, 'lib', 'THIRD_PARTY_NOTICES.txt'), sections.join('\n\n--------------------\n\n') + '\n')
}
