import { describe, expect, it } from 'vitest'

import { socketPath } from '../src/main/daemon/paths'
import { resolveOrchdBin } from '../src/main/daemon/spawn'

const env = (o: Record<string, string>) => (k: string) => o[k]

describe('chemin du socket (comme paths.rs)', () => {
  it('XDG_RUNTIME_DIR absolu', () => {
    expect(socketPath(env({ XDG_RUNTIME_DIR: '/run/user/1000' }), 1000)).toBe('/run/user/1000/devmaestro/orchd.sock')
  })
  it('XDG_RUNTIME_DIR relatif ignoré, repli sur TMPDIR', () => {
    expect(socketPath(env({ XDG_RUNTIME_DIR: 'run', TMPDIR: '/var/tmp' }), 42)).toBe('/var/tmp/devmaestro-42/orchd.sock')
  })
  it('sans variable : /tmp/devmaestro-<uid>', () => {
    expect(socketPath(env({}), 7)).toBe('/tmp/devmaestro-7/orchd.sock')
    expect(socketPath(env({ TMPDIR: 'relatif' }), 7)).toBe('/tmp/devmaestro-7/orchd.sock')
  })
})

describe('binaire orchd', () => {
  it('DEVMAESTRO_ORCHD_BIN d’abord', () => {
    expect(resolveOrchdBin({ env: { DEVMAESTRO_ORCHD_BIN: '/opt/orchd' }, appPath: '/x/app', packaged: false })).toBe('/opt/orchd')
  })
  it('en développement : ../target/debug/orchd s’il existe', () => {
    const exists = (p: string) => p === '/x/target/debug/orchd'
    expect(resolveOrchdBin({ env: {}, appPath: '/x/app', packaged: false, exists })).toBe('/x/target/debug/orchd')
    expect(resolveOrchdBin({ env: {}, appPath: '/y/app', packaged: false, exists })).toBe('orchd')
  })
  it('empaqueté : seulement le binaire livré, ni PATH ni variable', () => {
    expect(
      resolveOrchdBin({
        env: { DEVMAESTRO_ORCHD_BIN: '/tmp/faux' },
        appPath: '/opt/app/resources/app.asar',
        packaged: true,
        resourcesPath: '/opt/app/resources',
        exists: () => true,
      }),
    ).toBe('/opt/app/resources/bin/orchd')
  })
  it('disposition /opt/devmaestro (paquet .deb)', () => {
    expect(
      resolveOrchdBin({
        env: {},
        appPath: '/opt/devmaestro/resources/app',
        packaged: true,
        resourcesPath: '/opt/devmaestro/resources',
      }),
    ).toBe('/opt/devmaestro/resources/bin/orchd')
  })
  it('empaqueté sans dossier des ressources : erreur, pas de repli sur le PATH', () => {
    expect(() => resolveOrchdBin({ env: {}, appPath: '/opt/devmaestro/resources/app', packaged: true })).toThrow()
  })
})
