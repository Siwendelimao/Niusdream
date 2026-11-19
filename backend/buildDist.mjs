import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
/** Verify generated assets before touching the current live directory. */
export function validateDist(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m => m[1]).filter(x => x.startsWith('/assets/') || x.startsWith('./assets/'))
  if (!refs.length) throw Error('Build has no asset references')
  for (const ref of refs) if (!fs.statSync(path.join(dir, ref.replace(/^\.?\//, ''))).size) throw Error('Empty asset: ' + ref)
}
function inventory(dir, prefix = '', result = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes:true })) {
    const rel = prefix + e.name, full = path.join(dir,e.name)
    if (e.isSymbolicLink()) throw Error('Linked build artifact: '+rel)
    if (e.isDirectory()) inventory(full,rel+'/',result)
    else result[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  }
  return result
}
export function promoteDist(staged, live) {
  validateDist(staged)
  const backup = live + '.bak-' + Date.now()
  let moved = false
  try {
    if (fs.existsSync(live)) { fs.renameSync(live,backup); moved = true }
    fs.renameSync(staged,live)
    validateDist(live)
    // Keep the previous working build as a recovery point, never delete it before success.
    return backup
  } catch(e) {
    if (moved) {
      if (fs.existsSync(live)) fs.renameSync(live,live+'.failed-'+Date.now())
      fs.renameSync(backup,live)
    }
    throw e
  }
}
export function copyDist(source, staged) {
  fs.cpSync(source,staged,{recursive:true})
  if (JSON.stringify(inventory(source)) !== JSON.stringify(inventory(staged))) throw Error('Build copy hash mismatch')
  validateDist(staged)
}
