/**
 * Terminal de la session affichée : un seul xterm.js pour les sessions
 * (moteur WebGL, repli sur le moteur DOM), alimenté par le canal du terminal.
 * L'onglet « Lancer » (lot 14a) en monte un second, le temps de l'onglet,
 * pour l'exécution de runner choisie (`stream` : autre canal, autres appels).
 *
 * Sa taille ne dépend que de la place disponible (la zone des demandes, au
 * bas du volet, la réduit : le terminal est réajusté quand elle apparaît,
 * disparaît ou se réduit), sauf quand le démon n'a pas pu prendre notre
 * taille (session arrêtée) : le terminal prend alors celle de l'instantané
 * jusqu'à la reprise.
 *
 * Taille de l'interface (zoom d'Electron) : la police garde sa taille CSS et
 * grossit avec la page. Le rapport de pixels (`devicePixelRatio`) change avec
 * le zoom : l'atlas des glyphes est alors recalculé pour rester net, puis les
 * colonnes réajustées (de même en changeant d'écran).
 */
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { api, call, sessionChannel, type TerminalChannel } from '../api'
import type { RpcFailure } from '../../../shared/bridge'
import { describeError } from '../state/errors'
import { TerminalFeed } from './feed'
import { keyOverride, swallowedByOverride } from './keys'

interface Live {
  term: Terminal
  fit: FitAddon
  feed: TerminalFeed
  refit: () => void
  dispose: () => void
}

const encoder = new TextEncoder()

/**
 * Ce que le terminal affiche : la session (par défaut), ou l'exécution d'un
 * runner (lot 14a), par un autre canal et d'autres appels.
 */
export interface TerminalStream {
  channel: TerminalChannel
  view(id: string | null, size: { cols?: number; rows?: number }): Promise<{ ok: true } | { ok: false; error: RpcFailure }>
  resize(id: string, cols: number, rows: number): void
  /** Libellé de la région (lecteurs d'écran). */
  label: string
}

export const SESSION_TERMINAL: TerminalStream = {
  channel: sessionChannel,
  view: (id, size) => api.view({ id, ...size }),
  resize: (id, cols, rows) => void call('sessions.resize', { id, cols, rows }).catch(() => {}),
  label: 'Terminal de la session',
}

/** Taille plausible (un conteneur en cours de mise en page donne 1 ligne). */
const usable = (cols: number, rows: number): boolean => cols >= 20 && rows >= 4

export function TerminalView({
  sessionId,
  alive,
  theme,
  onSize,
  onLink,
  emptyText,
  hostRef,
  stream = SESSION_TERMINAL,
}: {
  /** Flux affiché (session par défaut) ; fixé au montage. */
  stream?: TerminalStream
  sessionId: string | null
  alive: boolean
  /** Couleurs du terminal, calculées par l'app à partir des jetons du thème. */
  theme: ITheme
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
  const themeRef = useRef(theme)
  themeRef.current = theme
  aliveRef.current = alive
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize
  const onLinkRef = useRef(onLink)
  onLinkRef.current = onLink
  const streamRef = useRef(stream)
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
        theme: themeRef.current,
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
      const st = streamRef.current
      const feed = new TerminalFeed(term, {
        ack: (gen, bytes) => st.channel.ack(gen, bytes),
        sizeMismatch: (cols, rows) => {
          const id = idRef.current
          if (aliveRef.current && id && usable(term.cols, term.rows)) {
            // Session vivante (un autre client a changé la taille) : on redemande la nôtre.
            st.resize(id, term.cols, term.rows)
            return
          }
          // Le démon garde sa taille (session arrêtée) : on prend celle de l'écran.
          pinned.current = true
          term.resize(cols, rows)
        },
        paused: () => setCatchingUp(true),
      })
      const offPort = st.channel.onMessage((m) => {
        if (feed.handle(m) && m.t === 'reset') {
          setError(null)
          setShown(true)
          setCatchingUp(false)
        }
      })
      term.attachCustomKeyEventHandler((e) => {
        const seq = keyOverride(e)
        if (seq !== null) {
          const id = idRef.current
          if (id) st.channel.sendInput(id, encoder.encode(seq))
          e.preventDefault()
          return false
        }
        return !swallowedByOverride(e)
      })
      const d1 = term.onData((s) => {
        const id = idRef.current
        if (id) st.channel.sendInput(id, encoder.encode(s))
      })
      const d2 = term.onBinary((s) => {
        const id = idRef.current
        if (id) st.channel.sendInput(id, Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff))
      })
      let resizeTimer: ReturnType<typeof setTimeout> | null = null
      const d3 = term.onResize(({ cols, rows }) => {
        // Taille transitoire, ou imposée par l'instantané : pas envoyée au démon.
        if (!usable(cols, rows) || pinned.current) return
        onSizeRef.current?.(cols, rows)
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          const id = idRef.current
          if (id) st.resize(id, cols, rows)
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
      // Changement de rapport de pixels (zoom de l'interface, autre écran) : glyphes redessinés, colonnes réajustées.
      let dprQuery: MediaQueryList | null = null
      const onDpr = () => {
        watchDpr()
        try {
          term.clearTextureAtlas()
        } catch {
          // Moteur sans atlas (DOM, contexte WebGL perdu) : rien à vider, le rafraîchissement suffit.
        }
        refit()
        term.refresh(0, term.rows - 1)
      }
      const watchDpr = () => {
        dprQuery?.removeEventListener('change', onDpr)
        dprQuery = typeof window.matchMedia === 'function' ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`) : null
        dprQuery?.addEventListener('change', onDpr)
      }
      watchDpr()
      refit()
      if (usable(term.cols, term.rows)) onSizeRef.current?.(term.cols, term.rows)
      live.current = {
        term,
        fit,
        feed,
        refit,
        dispose: () => {
          ro.disconnect()
          dprQuery?.removeEventListener('change', onDpr)
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
    void streamRef.current.view(sessionId, size).then((r) => {
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
      streamRef.current.resize(id, l.term.cols, l.term.rows)
    }
  }, [alive, ready])

  useEffect(() => {
    if (live.current) live.current.term.options.theme = theme
  }, [theme, ready])

  return (
    <div className="term">
      <div className="term-host" ref={host} role="region" aria-label={stream.label} />
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
