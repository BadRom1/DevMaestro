/**
 * Dossier personnel de l'utilisateur, tel que le processus principal le
 * transmet à la page (`os.homedir()`) : chemin absolu sans caractère nul ni
 * barre oblique finale, sinon `null`.
 */
export function validHome(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/') || v.length > 4096 || v.includes('\0')) return null
  return v.replace(/\/+$/, '') || '/'
}
