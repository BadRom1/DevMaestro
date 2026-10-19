/**
 * Terminal de la session affichée : un seul xterm.js pour toute l'app
 * (moteur WebGL, repli sur le moteur DOM), alimenté par le canal du terminal.
 *
 * Sa taille ne dépend que de la place disponible (les cartes de demande le
 * recouvrent sans le redimensionner), sauf quand le démon n'a pas pu prendre
 * notre taille (session arrêtée) : le terminal prend alors celle de
 * l'instantané jusqu'à la reprise.
 */
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { ackTerminal, api, call, onTerminalMessage, sendTerminalInput } from '../api'
import { describeError } from '../state/errors'
import { terminalTheme } from '../theme'
import { TerminalFeed } from './feed'

interface Live {
  term: Terminal
  fit: FitAddon
  feed: TerminalFeed
  refit: () => void
  dispose: () => void
}

const encoder = new TextEncoder()

/** Taille plausible (un conteneur en cours de mise en page donne 1 ligne). */
const usable = (cols: number, rows: number): boolean => cols >= 20 && rows >= 4

export function TerminalView({
  sessionId,
  alive,
  scheme,
  onSize,
  onLink,
  emptyText,
  hostRef,
}: {
  sessionId: string | null
  alive: boolean
  scheme: 'light' | 'dark'
  onSize?: (cols: number, rows: number) => void
  /** Lien OSC 8 activé dans le terminal (http/https seulement). */
  onLink?: (url: string) => void
  emptyText: string
  /** Élément qui porte le terminal (pour savoir s'il a le focus). */
  hostRef?: React.RefObject<HTMLDivElement | null>
}) {
  const ownHost = useRef<HTMLDivElement>(null)
  const host = hostRef ?? ownHost
  const live = useRef<Live | null>(null)
  const idRef = useRef<string | null>(sessionId)
  const pinned = useRef(false)
  const aliveRef = useRef(alive)
  aliveRef.current = alive
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize
  const onLinkRef = useRef(onLink)
  onLinkRef.current = onLink
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [catchingUp, setCatchingUp] = useState(false)

  // Création unique du terminal (après chargement de la police : l'atlas WebGL en dépend).
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        await document.fonts.load('13px "JetBrains Mono"')
      } catch {
        /* police de repli */
      }
      if (disposed || !host.current) return
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 13,
        lineHeight: 1.15,
        scrollback: 5000,
        cursorBlink: false,
        allowProposedApi: false,
        theme: terminalTheme(scheme),
        // Liens OSC 8 : jamais ouverts directement, confirmation dans l'app.
        linkHandler: {
          allowNonHttpProtocols: false,
          activate: (_e, uri) => {
            if (/^https?:\/\//i.test(uri)) onLinkRef.current?.(uri)
          },
        },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host.current)
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => {
          console.warn('[terminal] contexte WebGL perdu : passage au moteur DOM')
          gl.dispose()
        })
        term.loadAddon(gl)
        console.info('[terminal] moteur WebGL')
      } catch (e) {
        console.warn('[terminal] WebGL indisponible, moteur DOM :', e)
      }
      const feed = new TerminalFeed(term, {
        ack: ackTerminal,
        sizeMismatch: (cols, rows) => {
          const id = idRef.current
          if (aliveRef.current && id && usable(term.cols, term.rows)) {
            // Session vivante (un autre client a changé la taille) : on redemande la nôtre.
            call('sessions.resize', { id, cols: term.cols, rows: term.rows }).catch(() => {})
            return
          }
          // Le démon garde sa taille (session arrêtée) : on prend celle de l'écran.
          pinned.current = true
          term.resize(cols, rows)
        },
        paused: () => setCatchingUp(true),
      })
      const offPort = onTerminalMessage((m) => {
        if (feed.handle(m) && m.t === 'reset') {
          setError(null)
          setShown(true)
          setCatchingUp(false)
        }
      })
      const d1 = term.onData((s) => {
        const id = idRef.current
        if (id) sendTerminalInput(id, encoder.encode(s))
      })
      const d2 = term.onBinary((s) => {
        const id = idRef.current
        if (id) sendTerminalInput(id, Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff))
      })
      let resizeTimer: ReturnType<typeof setTimeout> | null = null
      const d3 = term.onResize(({ cols, rows }) => {
        // Taille transitoire, ou imposée par l'instantané : pas envoyée au démon.
        if (!usable(cols, rows) || pinned.current) return
        onSizeRef.current?.(cols, rows)
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          const id = idRef.current
          if (id) call('sessions.resize', { id, cols, rows }).catch(() => {})
        }, 80)
      })
      const refit = () => {
        if (pinned.current) return
        try {
          fit.fit()
        } catch {
          /* conteneur masqué */
        }
      }
      let raf = 0
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(refit)
      })
      ro.observe(host.current)
      refit()
      if (usable(term.cols, term.rows)) onSizeRef.current?.(term.cols, term.rows)
      live.current = {
        term,
        fit,
        feed,
        refit,
        dispose: () => {
          ro.disconnect()
          cancelAnimationFrame(raf)
          if (resizeTimer) clearTimeout(resizeTimer)
          offPort()
          d1.dispose()
          d2.dispose()
          d3.dispose()
          term.dispose()
        },
      }
      setReady(true)
    })()
    return () => {
      disposed = true
      live.current?.dispose()
      live.current = null
      setReady(false)
    }
    // Créé une seule fois ; le thème suit par l'effet dédié.
  }, [])

  // Changement de session affichée.
  useEffect(() => {
    const l = live.current
    if (!ready || !l) return
    idRef.current = sessionId
    l.feed.expect(sessionId)
    pinned.current = false
    setShown(false)
    setError(null)
    setCatchingUp(false)
    l.refit()
    const size = usable(l.term.cols, l.term.rows) ? { cols: l.term.cols, rows: l.term.rows } : {}
    void api.view({ id: sessionId, ...size }).then((r) => {
      if (!r.ok && idRef.current === sessionId) setError(describeError(r.error.code, r.error.message))
    })
  }, [sessionId, ready])

  // Session reprise : le terminal reprend la taille de la place disponible.
  useEffect(() => {
    const l = live.current
    if (!ready || !l || !alive || !pinned.current) return
    pinned.current = false
    l.refit()
    const id = idRef.current
    if (id && usable(l.term.cols, l.term.rows)) {
      onSizeRef.current?.(l.term.cols, l.term.rows)
      call('sessions.resize', { id, cols: l.term.cols, rows: l.term.rows }).catch(() => {})
    }
  }, [alive, ready])

  useEffect(() => {
    if (live.current) live.current.term.options.theme = terminalTheme(scheme)
  }, [scheme, ready])

  return (
    <div className="term">
      <div className="term-host" ref={host} role="region" aria-label="Terminal de la session" />
      {!sessionId && <div className="overlay">{emptyText}</div>}
      {sessionId && !shown && (
        <div className="overlay" role="status">
          {error ? `Terminal indisponible : ${error}` : 'Chargement de l’écran…'}
        </div>
      )}
      {catchingUp && (
        <div className="term-note" role="status">
          Affichage en retard : rattrapage…
        </div>
      )}
    </div>
  )
}
