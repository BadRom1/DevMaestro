/**
 * Grille de 1 à 4 zones d'onglets (lot 16). Tous les volets sont rendus côte
 * à côte dans un même conteneur, dans un ordre et avec des clés fixes, et
 * placés en absolu dans le rectangle de leur zone : déplacer un onglet ne
 * change que sa position, jamais son parent React (le terminal n'est ni
 * recréé ni vidé). Les barres d'onglets, les séparateurs et les cibles de
 * dépôt sont eux aussi des éléments du conteneur.
 *
 * Glisser-déposer HTML5 natif ; alternative clavier : menu « ⋯ » de chaque
 * zone (aussi Maj+F10, touche Menu ou clic droit sur un onglet).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'

import {
  applyDrop,
  canSplit,
  clampRatio,
  dropRegion,
  isTabId,
  layoutRects,
  MAX_RATIO,
  MIN_RATIO,
  moveTab,
  RATIO_KEY_STEP,
  removeTabs,
  setRatio,
  splitZone,
  TAB_IDS,
  TAB_LABELS,
  zoneOfTab,
  type DropRegion,
  type Layout,
  type Rect,
  type SplitRect,
  type TabId,
  type Zone,
} from '../state/layout'

const DRAG_TYPE = 'application/x-devmaestro-tab'

export interface ZoneTab {
  id: TabId
  /** Pastilles après le libellé (compteurs, demandes en attente). */
  extra?: ReactNode
}

const NO_TABS: readonly TabId[] = []

const pct = (v: number) => `${Math.round(v * 100000) / 1000}%`

function barStyle(r: Rect): CSSProperties {
  return { left: pct(r.x), top: pct(r.y), width: pct(r.w) }
}

function bodyStyle(r: Rect): CSSProperties {
  return { left: pct(r.x), top: `calc(${pct(r.y)} + var(--zt-h))`, width: pct(r.w), height: `calc(${pct(r.h)} - var(--zt-h))` }
}

const DROP_TEXT: Record<DropRegion, string> = {
  right: 'Scinder à droite',
  bottom: 'Scinder en bas',
  center: 'Déplacer ici',
}

export function ZoneGrid({
  layout,
  unavailable = NO_TABS,
  tabs,
  focused,
  idPrefix,
  onFocusZone,
  onActivate,
  onChange,
  onReset,
  renderPanel,
}: {
  /**
   * Disposition complète (retenue) : toutes les opérations s'y appliquent ;
   * les onglets `unavailable` sont seulement retirés de l'affichage.
   */
  layout: Layout
  /** Onglets indisponibles (« Lancer » sans runners) : masqués, leur place gardée. */
  unavailable?: readonly TabId[]
  /** Onglets proposés, avec leurs pastilles. */
  tabs: readonly ZoneTab[]
  /** Zone courante (celle qui a eu le focus en dernier). */
  focused: string | null
  /** Préfixe des identifiants : `${idPrefix}-${onglet}` (onglet), `…-panel` (volet). */
  idPrefix: string
  onFocusZone: (zoneId: string) => void
  onActivate: (tab: TabId) => void
  /**
   * Nouvelle disposition complète. `focusTab` : onglet déplacé, qui reçoit le
   * focus une fois le changement fait (jamais s'il est retenu par une
   * confirmation refusée) ; `persist` à `false` pendant le glisser d'un
   * séparateur (enregistrée au relâcher).
   */
  onChange: (next: Layout, opts?: { focusTab?: TabId; persist?: boolean }) => void
  /** « Réinitialiser la disposition » ; `focusTab` : onglet qui reçoit le focus ensuite. */
  onReset: (focusTab: TabId) => void
  renderPanel: (tab: TabId, visible: boolean) => ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  /** Disposition affichée. */
  const view = useMemo(() => (unavailable.length ? removeTabs(layout, unavailable) : layout), [layout, unavailable])
  const { zones, splits } = layoutRects(view)
  const multi = zones.length > 1
  const extras = new Map(tabs.map((t) => [t.id, t.extra]))
  const [dragTab, setDragTab] = useState<TabId | null>(null)
  /** Glisser en cours (avant même que `dragTab` soit posé) : un `dragend` précoce l'annule. */
  const dragging = useRef<TabId | null>(null)
  const [hover, setHover] = useState<{ zone: string; region: DropRegion } | null>(null)
  /** Menu ouvert : zone et onglet visé (l'onglet du clic droit, sinon l'onglet actif de la zone). */
  const [menuFor, setMenuFor] = useState<{ zone: string; tab: TabId } | null>(null)

  function endDrag() {
    dragging.current = null
    setDragTab(null)
    setHover(null)
  }

  // Le bouton source peut disparaître pendant le glisser (son `dragend` est alors perdu) : fin écoutée sur le document.
  useEffect(() => {
    if (!dragTab) return
    const end = () => endDrag()
    document.addEventListener('dragend', end, true)
    document.addEventListener('drop', end)
    return () => {
      document.removeEventListener('dragend', end, true)
      document.removeEventListener('drop', end)
    }
  }, [dragTab])

  function change(next: Layout, focusTab?: TabId) {
    if (next === layout) return
    onChange(next, { focusTab })
  }

  /** Dépôt permis de `tab` dans `zone` selon la région ? (limite de zones comptée sur la disposition complète) */
  function dropAllowed(tab: TabId, zone: Zone, region: DropRegion): boolean {
    if (region === 'center') return !zone.tabs.includes(tab)
    return canSplit(layout, tab, zone.id)
  }

  /** Glisser d'un onglet de la grille (type propre), jamais un fichier ou du texte venu d'ailleurs. */
  const ours = (e: DragEvent<HTMLElement>) => dragTab !== null && [...(e.dataTransfer?.types ?? [])].includes(DRAG_TYPE)

  function onBodyDragOver(e: DragEvent<HTMLDivElement>, zone: Zone) {
    if (!ours(e)) return
    const r = e.currentTarget.getBoundingClientRect()
    const region = dropRegion(e.clientX - r.left, e.clientY - r.top, r.width, r.height)
    if (!dropAllowed(dragTab!, zone, region)) {
      if (hover) setHover(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (hover?.zone !== zone.id || hover.region !== region) setHover({ zone: zone.id, region })
  }

  function onBarDragOver(e: DragEvent<HTMLElement>, zone: Zone) {
    if (!ours(e) || !dropAllowed(dragTab!, zone, 'center')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (hover?.zone !== zone.id || hover.region !== 'center') setHover({ zone: zone.id, region: 'center' })
  }

  function onDrop(e: DragEvent<HTMLElement>, zone: Zone, region: DropRegion) {
    if (!ours(e)) return
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    const tab = isTabId(raw) ? raw : null
    endDrag()
    if (!tab || !dropAllowed(tab, zone, region)) return
    e.preventDefault()
    change(applyDrop(layout, tab, zone.id, region), tab)
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, zone: Zone, tab: TabId) {
    const i = zone.tabs.indexOf(tab)
    let next: TabId | undefined
    if (e.key === 'ArrowRight') next = zone.tabs[(i + 1) % zone.tabs.length]
    else if (e.key === 'ArrowLeft') next = zone.tabs[(i + zone.tabs.length - 1) % zone.tabs.length]
    else if (e.key === 'Home') next = zone.tabs[0]
    else if (e.key === 'End') next = zone.tabs[zone.tabs.length - 1]
    else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      setMenuFor({ zone: zone.id, tab })
      return
    }
    if (!next) return
    e.preventDefault()
    onActivate(next)
    document.getElementById(`${idPrefix}-${next}`)?.focus()
  }

  return (
    <div className={`zones${multi ? ' multi' : ''}${dragTab ? ' dragging' : ''}`} ref={box}>
      {zones.map((r, i) => {
        const zone = r.zone
        const cur = multi && focused === zone.id
        const menuTab = menuFor?.zone === zone.id ? menuFor.tab : zone.active
        return (
          <div
            key={`bar-${zone.id}`}
            className={`ztabs${cur ? ' cur' : ''}${hover?.zone === zone.id && hover.region === 'center' ? ' drop' : ''}`}
            style={barStyle(r)}
            data-zone={zone.id}
            onFocusCapture={() => onFocusZone(zone.id)}
            onPointerDownCapture={() => onFocusZone(zone.id)}
            onDragOver={(e) => onBarDragOver(e, zone)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && hover?.zone === zone.id) setHover(null)
            }}
            onDrop={(e) => onDrop(e, zone, 'center')}
          >
            <div
              className="tabs"
              role="tablist"
              aria-label={multi ? `Zone ${i + 1} sur ${zones.length}${cur ? ' (zone courante)' : ''}` : 'Vues de la session'}
            >
              {zone.tabs.map((k) => (
                <button
                  key={k}
                  role="tab"
                  id={`${idPrefix}-${k}`}
                  aria-selected={zone.active === k}
                  aria-controls={`${idPrefix}-${k}-panel`}
                  tabIndex={zone.active === k ? 0 : -1}
                  draggable
                  onClick={() => onActivate(k)}
                  onKeyDown={(e) => onTabKey(e, zone, k)}
                  onContextMenu={(e) => {
                    // Le menu vise l'onglet cliqué, même si son activation attend une confirmation.
                    e.preventDefault()
                    setMenuFor({ zone: zone.id, tab: k })
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, k)
                    e.dataTransfer.effectAllowed = 'move'
                    dragging.current = k
                    // Après le départ du glisser : changer le DOM pendant `dragstart` peut l'annuler.
                    setTimeout(() => dragging.current === k && setDragTab(k), 0)
                  }}
                  onDragEnd={endDrag}
                >
                  <span className="tlabel">{TAB_LABELS[k]}</span>
                  {extras.get(k)}
                </button>
              ))}
            </div>
            {hover?.zone === zone.id && hover.region === 'center' && (
              <span className="zdrop-label in-bar" aria-hidden="true">
                {DROP_TEXT.center}
              </span>
            )}
            <ZoneMenu
              layout={layout}
              zone={zone}
              tab={menuTab}
              index={i}
              count={zones.length}
              zones={zones.map((z) => z.zone)}
              open={menuFor?.zone === zone.id}
              onOpen={() => setMenuFor({ zone: zone.id, tab: zone.active })}
              onClose={(refocus) => {
                setMenuFor(null)
                if (refocus) document.getElementById(`${idPrefix}-${zone.id}-menu`)?.focus()
              }}
              buttonId={`${idPrefix}-${zone.id}-menu`}
              onSplit={(side) => change(splitZone(layout, menuTab, zone.id, side), menuTab)}
              onMove={(target) => change(moveTab(layout, menuTab, target), menuTab)}
              onReset={() => onReset(menuTab)}
            />
          </div>
        )
      })}
      {TAB_IDS.map((tab) => {
        const r = zones.find((z) => z.zone.tabs.includes(tab))
        if (!r) return null
        const visible = r.zone.active === tab
        const terminal = tab === 'terminal'
        return (
          <div
            key={tab}
            className={`zpanel ${terminal ? 'term-wrap' : 'diff-layer'}${tab === 'conversation' ? ' conv-layer' : ''}`}
            role="tabpanel"
            id={`${idPrefix}-${tab}-panel`}
            aria-labelledby={`${idPrefix}-${tab}`}
            data-zone={r.zone.id}
            style={bodyStyle(r)}
            // Le terminal reste rendu (couvert par l'onglet actif de sa zone) : il garde sa taille et son contenu.
            hidden={!visible && !terminal}
            inert={!visible}
            onFocusCapture={() => onFocusZone(r.zone.id)}
            onPointerDownCapture={() => onFocusZone(r.zone.id)}
          >
            {renderPanel(tab, visible)}
          </div>
        )
      })}
      {dragTab &&
        zones.map((r) => (
          <div
            key={`drop-${r.zone.id}`}
            className="zdrop"
            data-zone={r.zone.id}
            style={bodyStyle(r)}
            onDragOver={(e) => onBodyDragOver(e, r.zone)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && hover?.zone === r.zone.id) setHover(null)
            }}
            onDrop={(e) => hover?.zone === r.zone.id && onDrop(e, r.zone, hover.region)}
          >
            {hover?.zone === r.zone.id && (
              <div className={`zdrop-hint ${hover.region}`}>
                <span className="zdrop-label">{DROP_TEXT[hover.region]}</span>
              </div>
            )}
          </div>
        ))}
      {splits.map((s) => (
        <ZoneSeparator key={s.split.id} rect={s} box={box} layout={layout} onChange={onChange} />
      ))}
    </div>
  )
}

function ZoneSeparator({
  rect,
  box,
  layout,
  onChange,
}: {
  rect: SplitRect
  box: React.RefObject<HTMLDivElement | null>
  layout: Layout
  onChange: (next: Layout, opts?: { persist?: boolean }) => void
}) {
  const s = rect.split
  const row = s.dir === 'row'
  const drag = useRef<{ last: Layout | null } | null>(null)
  const latest = useRef(layout)
  latest.current = layout

  const style: CSSProperties = row
    ? { left: `calc(${pct(rect.x + rect.w * s.ratio)} - 3px)`, top: pct(rect.y), height: pct(rect.h) }
    : { top: `calc(${pct(rect.y + rect.h * s.ratio)} - 3px)`, left: pct(rect.x), width: pct(rect.w) }

  function ratioAt(e: PointerEvent<HTMLDivElement>): number | null {
    const b = box.current?.getBoundingClientRect()
    if (!b || b.width <= 0 || b.height <= 0) return null
    return row
      ? (e.clientX - b.left - rect.x * b.width) / (rect.w * b.width)
      : (e.clientY - b.top - rect.y * b.height) / (rect.h * b.height)
  }

  function commit(r: number) {
    onChange(setRatio(latest.current, s.id, r))
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const back = row ? 'ArrowLeft' : 'ArrowUp'
    const fwd = row ? 'ArrowRight' : 'ArrowDown'
    let next: number | undefined
    if (e.key === back) next = s.ratio - RATIO_KEY_STEP
    else if (e.key === fwd) next = s.ratio + RATIO_KEY_STEP
    else if (e.key === 'Home') next = MIN_RATIO
    else if (e.key === 'End') next = MAX_RATIO
    else if (e.key === 'Enter') next = 0.5
    if (next === undefined) return
    e.preventDefault()
    commit(clampRatio(Math.round(next * 100) / 100))
  }

  const value = Math.round(s.ratio * 100)
  return (
    <div
      className={`zsep ${row ? 'v' : 'h'}`}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={row ? 'Largeur des zones (flèches gauche et droite ; Entrée : moitié)' : 'Hauteur des zones (flèches haut et bas ; Entrée : moitié)'}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RATIO * 100)}
      aria-valuenow={value}
      aria-valuetext={`${value} % pour la zone ${row ? 'de gauche' : 'du haut'}`}
      tabIndex={0}
      style={style}
      title="Glisser pour redimensionner ; double-clic : moitié"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        drag.current = { last: null }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const r = ratioAt(e)
        if (r === null) return
        drag.current.last = setRatio(latest.current, s.id, r)
        onChange(drag.current.last, { persist: false })
      }}
      onPointerUp={(e) => {
        const d = drag.current
        if (!d) return
        drag.current = null
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        if (d.last) onChange(d.last)
      }}
      onPointerCancel={(e) => {
        // Comme la poignée des colonnes : la dernière position calculée est enregistrée.
        const d = drag.current
        if (!d) return
        drag.current = null
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        if (d.last) onChange(d.last)
      }}
      onDoubleClick={() => commit(0.5)}
      onKeyDown={onKey}
    />
  )
}

function ZoneMenu({
  layout,
  zone,
  tab,
  index,
  count,
  zones,
  open,
  onOpen,
  onClose,
  buttonId,
  onSplit,
  onMove,
  onReset,
}: {
  layout: Layout
  zone: Zone
  /** Onglet visé par le menu. */
  tab: TabId
  index: number
  count: number
  zones: Zone[]
  open: boolean
  onOpen: () => void
  onClose: (refocus: boolean) => void
  buttonId: string
  onSplit: (side: 'right' | 'bottom') => void
  onMove: (target: string) => void
  onReset: () => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const splittable = canSplit(layout, tab, zone.id)
  const items: { key: string; label: string; disabled?: boolean; run: () => void }[] = [
    { key: 'right', label: 'Scinder à droite', disabled: !splittable, run: () => onSplit('right') },
    { key: 'bottom', label: 'Scinder en bas', disabled: !splittable, run: () => onSplit('bottom') },
    ...zones
      .map((z, j) => ({ z, j }))
      .filter(({ z }) => z.id !== zone.id)
      .map(({ z, j }) => ({ key: `move-${z.id}`, label: `Déplacer vers la zone ${j + 1}`, run: () => onMove(z.id) })),
    { key: 'reset', label: 'Réinitialiser la disposition', run: onReset },
  ]

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
    const onDown = (e: Event) => {
      if (!(e.target instanceof Node)) return
      if (menu.current?.contains(e.target) || document.getElementById(buttonId)?.contains(e.target)) return
      onClose(false)
    }
    // `pointerdown` : un séparateur annule `mousedown` (preventDefault) mais pas l'événement de pointeur.
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    } else if (e.key === 'Tab') {
      onClose(false)
    }
  }

  return (
    <div className="zmenu">
      <button
        type="button"
        id={buttonId}
        className="btn ghost sm zmenu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Disposition de l’onglet ${TAB_LABELS[tab]}${count > 1 ? ` (zone ${index + 1} sur ${count})` : ''}`}
        title="Disposition : scinder, déplacer vers une autre zone, réinitialiser"
        onClick={() => (open ? onClose(false) : onOpen())}
      >
        ⋯
      </button>
      {open && (
        <div className="zmenu-pop" role="menu" aria-label={`Disposition de l’onglet ${TAB_LABELS[tab]}`} ref={menu} onKeyDown={onKey}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={it.disabled || undefined}
              className={it.key === 'reset' ? 'sep' : undefined}
              title={it.disabled ? (zone.tabs.length === 1 && zone.tabs[0] === tab ? 'Dernier onglet de la zone' : 'Quatre zones au plus') : undefined}
              onClick={() => {
                if (it.disabled) return
                onClose(false)
                it.run()
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Zone qui contient `tab` dans `layout` (identifiant), ou `null`. */
export function zoneIdOf(layout: Layout, tab: TabId): string | null {
  return zoneOfTab(layout, tab)?.id ?? null
}
