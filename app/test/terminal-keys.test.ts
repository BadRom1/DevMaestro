import { describe, expect, it } from 'vitest'
import { keyOverride, NEWLINE_SEQUENCE, swallowedByOverride } from '../src/renderer/src/terminal/keys'

const key = (over: Partial<KeyboardEvent>) =>
  ({ type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...over }) as KeyboardEvent

describe('touches du terminal', () => {
  it('Maj+Entrée envoie ESC CR (retour à la ligne dans Claude Code)', () => {
    expect(NEWLINE_SEQUENCE).toBe('\x1b\r')
    expect(keyOverride(key({ shiftKey: true }))).toBe('\x1b\r')
  })

  it('Entrée seule et les autres combinaisons restent à xterm', () => {
    expect(keyOverride(key({}))).toBeNull()
    expect(keyOverride(key({ shiftKey: true, ctrlKey: true }))).toBeNull()
    expect(keyOverride(key({ shiftKey: true, altKey: true }))).toBeNull()
    expect(keyOverride(key({ shiftKey: true, metaKey: true }))).toBeNull()
    expect(keyOverride(key({ key: 'a', shiftKey: true }))).toBeNull()
  })

  it('pas de traduction pendant une composition (IME) ni hors keydown', () => {
    expect(keyOverride(key({ shiftKey: true, isComposing: true }))).toBeNull()
    expect(keyOverride(key({ shiftKey: true, type: 'keypress' }))).toBeNull()
  })

  it('le keypress et le keyup de Maj+Entrée sont avalés pour ne pas envoyer de CR', () => {
    expect(swallowedByOverride(key({ shiftKey: true, type: 'keypress' }))).toBe(true)
    expect(swallowedByOverride(key({ shiftKey: true, type: 'keyup' }))).toBe(true)
    expect(swallowedByOverride(key({ type: 'keypress' }))).toBe(false)
  })
})
