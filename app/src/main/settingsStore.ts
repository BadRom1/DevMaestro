/**
 * Réglages de l'app sur disque : `settings.json` dans `userData`, lisible par
 * l'utilisateur seul (0600), écrit de façon atomique (fichier temporaire
 * 0600, `fsync`, `rename`). Sans Electron : testable avec un dossier temporaire.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  applyPatch,
  defaultSettings,
  normalizeSettings,
  validatePatch,
  type AppSettings,
} from '../shared/settings'

export const SETTINGS_FILE = 'settings.json'

export class SettingsStore {
  private current: AppSettings = defaultSettings()
  /** Le fichier n'existait pas (premier lancement) ou était illisible. */
  fresh = true
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly log: (m: string) => void = () => undefined,
  ) {}

  get file(): string {
    return path.join(this.dir, SETTINGS_FILE)
  }

  get settings(): AppSettings {
    return this.current
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      this.current = normalizeSettings(JSON.parse(raw))
      this.fresh = false
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.log(`réglages illisibles (${(e as Error).message}) : valeurs par défaut`)
      this.current = defaultSettings()
      this.fresh = true
    }
    return this.current
  }

  /** Écritures lancées et pas encore terminées. */
  private inFlight = 0

  /**
   * Valide la modification (exception `SettingsError` sinon), l'applique en
   * mémoire tout de suite et l'écrit. Un échec d'écriture est renvoyé à
   * l'appelant (la valeur reste en mémoire) sans bloquer les écritures suivantes.
   */
  async update(rawPatch: unknown): Promise<AppSettings> {
    const patch = validatePatch(rawPatch)
    this.current = applyPatch(this.current, patch)
    const snapshot = this.current
    this.inFlight++
    // Écritures en série : la dernière l'emporte toujours sur disque.
    const done = this.writing.then(() => this.write(snapshot))
    this.writing = done
      .catch((e: unknown) => {
        this.log(`écriture des réglages impossible : ${(e as Error).message}`)
      })
      .finally(() => {
        this.inFlight--
      })
    await done
    this.fresh = false
    return this.current
  }

  /** Une écriture est-elle en cours ? */
  get pending(): boolean {
    return this.inFlight > 0
  }

  /** Attend la fin des écritures en cours (sans jamais échouer). */
  async flush(): Promise<void> {
    await this.writing
  }

  private async write(s: AppSettings): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    const fh = await fs.open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(JSON.stringify(s, null, 2) + '\n', 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    try {
      await fs.rename(tmp, this.file)
    } catch (e) {
      await fs.rm(tmp, { force: true })
      throw e
    }
    // Un fichier créé autrement (copie, ancienne version) retrouve 0600.
    await fs.chmod(this.file, 0o600)
  }
}
