/**
 * Revue assistée par IA (v0.3, lot 19) : session Claude en lecture seule
 * (mode `plan`) ouverte depuis une demande de fusion, le diff d'une session
 * ou un commit. Calculs purs (nom, branche jetable, dossier, contexte collé
 * et ses bornes) et registre local des sessions de revue (stockage injecté :
 * testable sans DOM).
 *
 * ADR 0006 : la consigne **tapée** ne porte que des valeurs sûres (numéro,
 * sha court, branche réduite) ; titre, description, message de commit et
 * diff sont **collés** en *bracketed paste* (`initial.pasted`).
 */
import type { CommitInfo, DiffFile, DiffStatus, FileDiff, PullDetail, Session, WorktreeInfo } from '../../../shared/protocol'
import { MAX_PROMPT_CHARS, renderPrompt, safeValue, type PromptId, type PromptVars } from '../../../shared/prompts'
import { getLocale, numberFormat, t as tr, type Locale } from '../../../shared/i18n'
import { worktreeSlug } from '../../../shared/worktrees'
import type { KeyValueStorage } from './collapse'
import { cleanForgeText, oneLine } from './forge'

/** Contenu collé : 64 Kio au plus (UTF-8, après nettoyage) ; le démon en accepte 256. */
export const MAX_REVIEW_PASTED_BYTES = 64 * 1024
/** Fichiers dont le diff est lu au plus (un appel au démon chacun). */
export const MAX_REVIEW_FILES_READ = 80
/** Lignes de la liste des fichiers au plus. */
export const MAX_REVIEW_FILE_LIST = 500
/** Description d'une demande de fusion collée au plus (octets UTF-8). */
export const MAX_REVIEW_BODY_BYTES = 16 * 1024
/** Message de commit collé au plus (octets UTF-8). */
export const MAX_REVIEW_MESSAGE_BYTES = 4 * 1024
/** Nom de session (comme `sessions.update`). */
export const MAX_REVIEW_NAME = 80

/** Ce qu'on relit. `files` : liste connue (diff, commit, demande). */
export type ReviewTarget = (
  | { kind: 'pull'; root: string; pull: PullDetail; files: readonly DiffFile[] }
  | { kind: 'diff'; session: Session; files: readonly DiffFile[] }
  | { kind: 'commit'; session: Session; commit: CommitInfo; files: readonly DiffFile[] }
) & {
  /** Liste des fichiers coupée par le démon ou la forge. */
  listTruncated?: boolean
  /** Fichiers ignorés par le démon (contenu non UTF-8). */
  skipped?: number
}

export type ReviewKind = ReviewTarget['kind']

/** Sha valide (40 ou 64 chiffres hexadécimaux), en minuscules, ou `null`. */
function fullSha(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.toLowerCase()
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s) ? s : null
}

export function short(sha: string): string {
  return sha.slice(0, 7)
}

/** Sha relu : tête de la demande ou commit choisi ; `null` pour un diff de session. */
export function targetSha(t: ReviewTarget): string | null {
  if (t.kind === 'pull') return fullSha(t.pull.head?.sha)
  if (t.kind === 'commit') return fullSha(t.commit.sha)
  return null
}

/** Racine du dépôt où créer le worktree (ou lancer). */
export function targetRoot(t: ReviewTarget): string {
  return t.kind === 'pull' ? t.root : (t.session.project_root ?? t.session.cwd)
}

/** Branche affichée et passée à `{branche}` (réduite au rendu de la consigne). */
export function targetBranch(t: ReviewTarget): string | null {
  if (t.kind === 'pull') return t.pull.head?.branch ?? null
  return t.session.branch ?? null
}

function cut(s: string, max: number): string {
  const c = [...s]
  return c.length <= max ? s : `${c.slice(0, max - 1).join('')}…`
}

/** Ce qu'on relit, en bref : « PR #42 », « abc1234 », « du diff <branche> » (dans la langue de l'interface). */
export function reviewSubject(t: ReviewTarget): string {
  if (t.kind === 'pull') return `PR #${t.pull.number}`
  if (t.kind === 'commit') return short(fullSha(t.commit.sha) ?? t.commit.sha.replace(/[^0-9a-f]/gi, ''))
  const b = t.session.branch ? safeValue(t.session.branch) : ''
  // Borné comme le nom de session (« Revue » et une espace en moins).
  return cut(b ? tr('forge.review.subject.diffBranch', { branch: b }) : tr('forge.review.subject.diff'), MAX_REVIEW_NAME - 6)
}

/** Nom court de la session : « Revue PR #42 », « Revue abc1234 », « Revue du diff <branche> ». */
export function reviewSessionName(t: ReviewTarget): string {
  return cut(tr('forge.review.sessionName', { subject: reviewSubject(t) }), MAX_REVIEW_NAME)
}

/** Libellé accessible du bouton (« Revue assistée de la demande #42 »…). */
export function reviewButtonLabel(t: Pick<ReviewTarget, 'kind'> & { number?: number; sha?: string }): string {
  if (t.kind === 'pull') return tr('forge.review.buttonLabel.pull', { number: t.number ?? '?' })
  if (t.kind === 'commit') return tr('forge.review.buttonLabel.commit', { sha: t.sha ? short(t.sha) : '' }).trimEnd()
  return tr('forge.review.buttonLabel.diff')
}

/** Branche jetable de revue (`null` : pas de worktree, diff d'une session). */
export function reviewBranch(t: ReviewTarget): string | null {
  const sha = targetSha(t)
  if (!sha) return null
  if (t.kind === 'pull') return `revue/pr-${t.pull.number}-${short(sha)}`
  if (t.kind === 'commit') return `revue/${short(sha)}`
  return null
}

/** Où lancer la session. */
export type ReviewLocation =
  /** Nouveau worktree jetable (`sessions.launch {cwd: root, worktree}`). */
  | { kind: 'worktree'; root: string; branch: string; base: string; slug: string }
  /** Worktree déjà sur la branche de revue : réutilisé. */
  | { kind: 'reuse'; cwd: string; branch: string }
  /** Dossier existant (diff d'une session ; « Lancer sans worktree » d'une PR). */
  | { kind: 'folder'; cwd: string }

/**
 * Dossier de la session de revue. Demande de fusion et commit : worktree
 * jetable sur le sha (réutilisé s'il existe déjà) ; diff : dossier de la
 * session. `noWorktree` : « Lancer sans worktree » (dossier du projet, rien
 * extrait). `null` : sha invalide (rien à lancer).
 */
export function reviewLocation(
  t: ReviewTarget,
  worktrees: readonly WorktreeInfo[] | undefined,
  noWorktree = false,
): ReviewLocation | null {
  if (t.kind === 'diff') return { kind: 'folder', cwd: t.session.cwd }
  const root = targetRoot(t)
  if (noWorktree) return { kind: 'folder', cwd: root }
  const sha = targetSha(t)
  const branch = reviewBranch(t)
  if (!sha || !branch) return null
  const existing = (worktrees ?? []).find((w) => isReviewWorktree(w, branch, sha) && w.exists !== false)
  if (existing) return { kind: 'reuse', cwd: existing.path, branch }
  return { kind: 'worktree', root, branch, base: sha, slug: worktreeSlug(branch) }
}

/**
 * Worktree créé par l'app pour cette revue : géré par DevMaestro, pas le
 * principal, sur la branche de revue attendue et, si sa tête est connue,
 * encore sur le sha relu (aucun commit ajouté). Un worktree de l'utilisateur
 * nommé de même n'est ni réutilisé ni proposé au nettoyage.
 */
export function isReviewWorktree(w: WorktreeInfo, branch: string, sha: string): boolean {
  if (w.main || w.managed_by !== 'devmaestro' || w.branch !== branch) return false
  return !w.head || w.head.toLowerCase() === sha
}

/** Branche de revue attendue pour une marque (même calcul qu'au lancement). */
export function markBranch(m: Pick<ReviewMark, 'kind' | 'pr' | 'sha'>): string | null {
  if (!m.sha) return null
  if (m.kind === 'pull') return m.pr ? `revue/pr-${m.pr}-${short(m.sha)}` : null
  if (m.kind === 'commit') return `revue/${short(m.sha)}`
  return null
}

/* ---------- Consigne tapée ---------- */

export function reviewPromptId(t: ReviewTarget): PromptId {
  return t.kind === 'pull' ? 'aiReviewPr' : t.kind === 'commit' ? 'aiReviewCommit' : 'aiReviewDiff'
}

/** Valeurs sûres seulement : numéro, sha, branche (réduite au rendu). */
export function reviewVars(t: ReviewTarget): PromptVars {
  return {
    branch: targetBranch(t),
    ...(t.kind === 'pull' ? { pr: t.pull.number } : {}),
    ...(t.kind === 'commit' ? { commit: targetSha(t) } : {}),
  }
}

/**
 * Ajouté à la consigne (texte de l'app) quand la revue tourne hors de la
 * branche relue, dans la langue de l'interface comme `defaultPrompt` (lot 20).
 */
export function noWorktreeNote(locale: Locale = getLocale()): string {
  return locale === 'en'
    ? // i18n-exempt: texte envoyé à Claude
      'Warning: your working folder is not on the reviewed branch, rely on the pasted diff.'
    : // i18n-exempt: texte envoyé à Claude
      'Attention : ton dossier de travail n’est pas sur la branche relue, fie-toi au diff collé.'
}

/**
 * Consigne tapée, rendue du modèle (lève une erreur si le modèle est
 * invalide). `noWorktree` : la note ci-dessus est ajoutée si elle tient.
 */
export function reviewInstruction(t: ReviewTarget, template: string, noWorktree = false): string {
  const text = renderPrompt(reviewPromptId(t), template, reviewVars(t))
  if (!noWorktree) return text
  const withNote = `${text} ${noWorktreeNote()}`
  return [...withNote].length <= MAX_PROMPT_CHARS ? withNote : text
}

/* ---------- Contenu collé ---------- */

const encoder = new TextEncoder()

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

/** Coupe à `max` octets UTF-8 sans couper un caractère ; `cut` : coupé ou non. */
export function cutBytes(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max / 4 || utf8Bytes(s) <= max) return { text: s, cut: false }
  let used = 0
  let out = ''
  for (const c of s) {
    const n = utf8Bytes(c)
    if (used + n > max) break
    used += n
    out += c
  }
  return { text: out, cut: true }
}

// i18n-exempt: texte envoyé à Claude
const STATUS_WORDS: Record<DiffStatus, string> = { A: 'ajouté', M: 'modifié', D: 'supprimé', R: 'renommé', '?': 'non suivi' }

function counts(f: Pick<DiffFile, 'additions' | 'deletions'>): string {
  const n = (v: number | null) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '?')
  return `+${n(f.additions)} −${n(f.deletions)}`
}

/** Une ligne de la liste des fichiers. */
export function fileLine(f: DiffFile): string {
  const name = f.old_path && f.old_path !== f.path ? `${f.old_path} → ${f.path}` : f.path
  return `${f.status} ${name} (${STATUS_WORDS[f.status] ?? f.status}, ${counts(f)})`
}

/** Diff d'un fichier au format unifié, reconstruit depuis ses hunks. */
export function unifiedFile(f: DiffFile, d: FileDiff): string {
  const oldName = f.status === 'A' || f.status === '?' ? '/dev/null' : `a/${f.old_path || f.path}`
  const newName = f.status === 'D' ? '/dev/null' : `b/${f.path}`
  const head = `diff --git a/${f.old_path || f.path} b/${f.path}\n--- ${oldName}\n+++ ${newName}\n`
  // i18n-exempt: texte envoyé à Claude
  if (d.binary) return `${head}(fichier binaire : pas de diff ligne à ligne)\n`
  // i18n-exempt: texte envoyé à Claude
  if (d.too_large) return `${head}(diff trop volumineux : non inclus, à lire dans le dépôt)\n`
  let out = head
  for (const h of d.hunks ?? []) {
    out += `${h.header}\n`
    for (const l of h.lines ?? []) out += `${l.kind}${l.text}\n`
  }
  return out
}

/** Résultat de la lecture d'un fichier : son diff, ou l'erreur du démon. */
export type FileRead = { ok: true; diff: FileDiff } | { ok: false; error: string }

export interface ReviewContext {
  /** Texte collé, nettoyé. */
  pasted: string
  bytes: number
  /** Fichiers dont le diff est inclus en entier. */
  included: number
  /** Fichiers de la liste. */
  total: number
  /** Diff incomplet (budget, nombre de fichiers lus, liste coupée). */
  truncated: boolean
  /** Ce qui manque au diff collé (binaires, trop gros, illisibles, non UTF-8, liste coupée…), en français : texte collé. */
  notes: string[]
  /** Les mêmes manques, structurés : résumé affiché (`reviewNoteLabel`, dans la langue de l'interface). */
  missing: ReviewNote[]
}

/** Un manque du contexte collé. */
export type ReviewNote =
  | { kind: 'headCut' }
  | { kind: 'listCut'; listed: number; total: number }
  | { kind: 'listTruncated' }
  | { kind: 'skipped'; count: number }
  | { kind: 'binary'; count: number }
  | { kind: 'tooLarge'; count: number }
  | { kind: 'unreadable'; count: number }
  | { kind: 'diffCut'; included: number; total: number; maxBytes: number }

/** Taille lisible et exacte (« 64 Kio », « 39,1 Kio », « 900 octets »), dans la langue de l'interface. */
export function sizeLabel(n: number): string {
  if (n < 1024) return tr('forge.review.size.bytes', { n })
  const k = n / 1024
  const v = Number.isInteger(k) ? String(k) : numberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(k)
  return tr('forge.review.size.kib', { n: v })
}

/* Texte collé à Claude : toujours en français (comme la consigne du démon), jamais traduit. */

/** Taille dans le texte collé (« 64 Kio », « 39,1 Kio », « 900 octets »). */
function pastedSize(n: number): string {
  // i18n-exempt: texte envoyé à Claude
  if (n < 1024) return `${n} octets`
  const k = n / 1024
  return `${Number.isInteger(k) ? k : k.toFixed(1).replace('.', ',')} Kio`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`
}

/** Un manque, tel qu'il est collé (français). */
function notePasted(n: ReviewNote): string {
  switch (n.kind) {
    case 'headCut':
      return 'en-tête coupé' // i18n-exempt: texte envoyé à Claude
    case 'listCut':
      return `liste des fichiers coupée (${n.listed} sur ${n.total})` // i18n-exempt: texte envoyé à Claude
    case 'listTruncated':
      return 'liste des fichiers coupée par le démon ou la forge' // i18n-exempt: texte envoyé à Claude
    case 'skipped':
      // i18n-exempt: texte envoyé à Claude
      return `${plural(n.count, 'fichier non UTF-8 ignoré', 'fichiers non UTF-8 ignorés')} par le démon`
    case 'binary':
      return plural(n.count, 'fichier binaire sans diff', 'fichiers binaires sans diff') // i18n-exempt: texte envoyé à Claude
    case 'tooLarge':
      return plural(n.count, 'fichier trop volumineux non inclus', 'fichiers trop volumineux non inclus') // i18n-exempt: texte envoyé à Claude
    case 'unreadable':
      return plural(n.count, 'fichier illisible', 'fichiers illisibles') // i18n-exempt: texte envoyé à Claude
    case 'diffCut':
      // i18n-exempt: texte envoyé à Claude
      return `diff tronqué : ${n.included} fichier${n.included > 1 ? 's' : ''} sur ${n.total} inclus (limite de ${pastedSize(n.maxBytes)})`
  }
}

/** Un manque, tel qu'il est affiché dans la confirmation (langue de l'interface). */
export function reviewNoteLabel(n: ReviewNote): string {
  switch (n.kind) {
    case 'headCut':
      return tr('forge.review.note.headCut')
    case 'listCut':
      return tr('forge.review.note.listCut', { listed: n.listed, total: n.total })
    case 'listTruncated':
      return tr('forge.review.note.listTruncated')
    case 'skipped':
      return tr('forge.review.note.skipped', { count: n.count })
    case 'binary':
      return tr('forge.review.note.binary', { count: n.count })
    case 'tooLarge':
      return tr('forge.review.note.tooLarge', { count: n.count })
    case 'unreadable':
      return tr('forge.review.note.unreadable', { count: n.count })
    case 'diffCut':
      return tr('forge.review.note.diffCut', { count: n.included, total: n.total, limit: sizeLabel(n.maxBytes) })
  }
}

/** En-tête collé : ce qu'on relit (titre, description, message : données). */
export function reviewHeader(t: ReviewTarget): string {
  if (t.kind === 'pull') {
    const p = t.pull
    const body = cutBytes(cleanForgeText(p.body ?? '').trim(), MAX_REVIEW_BODY_BYTES)
    const lines = [
      // i18n-exempt: texte envoyé à Claude
      `Demande de fusion #${p.number} : ${oneLine(p.title ?? '')}`,
      // i18n-exempt: texte envoyé à Claude
      `Branche : ${oneLine(p.head?.branch ?? '?')} → ${oneLine(p.base?.branch ?? '?')} · tête ${short(targetSha(t) ?? '???????')}`,
      ...(p.author ? [`Auteur : ${oneLine(p.author)}`] : []),
      '',
      // i18n-exempt: texte envoyé à Claude
      'Description (donnée venue de la forge) :',
      body.text || '(vide)',
      // i18n-exempt: texte envoyé à Claude
      ...(body.cut || p.truncated ? ['[Description coupée.]'] : []),
    ]
    return lines.join('\n')
  }
  if (t.kind === 'commit') {
    const c = t.commit
    const msg = cutBytes(cleanForgeText([c.subject, c.body].filter(Boolean).join('\n\n')).trim(), MAX_REVIEW_MESSAGE_BYTES)
    return [
      `Commit ${short(targetSha(t) ?? c.sha)}${c.author ? ` de ${oneLine(c.author)}` : ''}${c.date ? `, ${c.date}` : ''}`,
      // i18n-exempt: texte envoyé à Claude
      ...(t.session.branch ? [`Branche : ${oneLine(t.session.branch)}`] : []),
      '',
      'Message :',
      msg.text || '(sans message)',
      // i18n-exempt: texte envoyé à Claude
      ...(msg.cut ? ['[Message coupé.]'] : []),
    ].join('\n')
  }
  // i18n-exempt: texte envoyé à Claude
  return [`Changements de la session${t.session.branch ? ` (branche ${oneLine(t.session.branch)})` : ''} contre sa base, modifications non commitées comprises.`].join(
    '\n',
  )
}

/**
 * Contenu collé : en-tête, liste des fichiers, puis diff fichier par
 * fichier tant qu'il tient dans `maxBytes` ; au-delà, une mention le dit.
 * L'en-tête (description comprise) est plafonné à 5/16 du budget (20 Kio
 * sur 64) et la liste à la moitié : le texte collé ne dépasse **jamais** `maxBytes`.
 * `reads` : diffs lus, dans l'ordre de `files` (absent : non lu).
 * `noWorktree` : la session ne tourne pas sur le code relu (dit en tête).
 */
export function buildReviewContext(
  t: ReviewTarget,
  reads: ReadonlyMap<string, FileRead>,
  opts: { maxBytes?: number; noWorktree?: boolean } = {},
): ReviewContext {
  const maxBytes = opts.maxBytes ?? MAX_REVIEW_PASTED_BYTES
  const listTruncated = !!t.listTruncated
  const files = t.files
  const missing: ReviewNote[] = []
  // Place gardée pour les mentions de fin.
  const reserve = 600
  const warn = opts.noWorktree
    // i18n-exempt: texte envoyé à Claude
    ? 'Note de DevMaestro : la session tourne dans le dossier du projet, qui n’est pas sur la branche relue ; ses fichiers ne sont pas ceux du diff ci-dessous.\n\n'
    : ''
  const head = cutBytes(cleanForgeText(`${warn}${reviewHeader(t)}`), Math.floor((maxBytes * 5) / 16))
  if (head.cut) missing.push({ kind: 'headCut' })
  // i18n-exempt: texte envoyé à Claude
  const headText = head.cut ? `${head.text}\n[En-tête coupé.]` : head.text
  // Liste : jusqu'à 500 lignes et la moitié du budget.
  const listBudget = Math.floor(maxBytes / 2)
  // i18n-exempt: texte envoyé à Claude
  let listText = `Fichiers modifiés (${files.length}${listTruncated ? ', liste coupée' : ''}) :`
  let listUsed = utf8Bytes(listText)
  let listed = 0
  for (const f of files.slice(0, MAX_REVIEW_FILE_LIST)) {
    const line = `\n${cleanForgeText(fileLine(f))}`
    const n = utf8Bytes(line)
    if (listUsed + n > listBudget) break
    listText += line
    listUsed += n
    listed++
  }
  if (listed < files.length) {
    // i18n-exempt: texte envoyé à Claude
    listText += `\n… et ${files.length - listed} autres (liste bornée à ${MAX_REVIEW_FILE_LIST} lignes et ${pastedSize(listBudget)}).`
    missing.push({ kind: 'listCut', listed, total: files.length })
  }
  if (listTruncated) missing.push({ kind: 'listTruncated' })
  if (t.skipped && t.skipped > 0) missing.push({ kind: 'skipped', count: t.skipped })
  const intro = `${headText}\n\n${listText}\n\nDiff :\n`
  let used = utf8Bytes(intro)
  let diff = ''
  let included = 0
  let stopped = false
  let binary = 0
  let tooLarge = 0
  let unreadable = 0
  for (const f of files) {
    const r = reads.get(f.path)
    if (!r) {
      stopped = true
      break
    }
    const part = r.ok ? cleanForgeText(unifiedFile(f, r.diff)) : `diff --git a/${f.path} b/${f.path}\n(illisible : ${oneLine(r.error)})\n`
    const n = utf8Bytes(part) + 1
    if (used + n + reserve > maxBytes) {
      stopped = true
      break
    }
    diff += `${part}\n`
    used += n
    if (!r.ok) unreadable++
    else if (r.diff.binary) binary++
    else if (r.diff.too_large) tooLarge++
    else included++
  }
  if (binary) missing.push({ kind: 'binary', count: binary })
  if (tooLarge) missing.push({ kind: 'tooLarge', count: tooLarge })
  if (unreadable) missing.push({ kind: 'unreadable', count: unreadable })
  if (stopped) missing.unshift({ kind: 'diffCut', included, total: files.length, maxBytes })
  const notes = missing.map(notePasted)
  const truncated = stopped || listTruncated || listed < files.length || head.cut
  // i18n-exempt: texte envoyé à Claude
  if (files.length === 0) diff = '(aucun changement)\n'
  // i18n-exempt: texte envoyé à Claude
  const tail = notes.length ? `[Contexte incomplet : ${notes.join(' ; ')}. Le reste se lit dans le dépôt.]` : ''
  let pasted = `${intro}${diff}${tail}`.trim()
  // Garde finale : jamais au-delà de la borne annoncée.
  if (utf8Bytes(pasted) > maxBytes) {
    // i18n-exempt: texte envoyé à Claude
    const end = '\n[Contexte coupé à la limite.]'
    pasted = `${cutBytes(pasted, maxBytes - utf8Bytes(end)).text}${end}`
  }
  return { pasted, bytes: utf8Bytes(pasted), included, total: files.length, truncated, notes, missing }
}

/** Lectures de diffs menées en même temps au plus. */
export const REVIEW_READ_PARALLEL = 4

/**
 * Lit les diffs (`fetch`), quatre à la fois au plus, jusqu'à
 * `MAX_REVIEW_FILES_READ` fichiers ou au budget (plus aucune lecture n'est
 * lancée une fois le budget dépassé) : un fichier illisible est noté sans
 * arrêter les autres. `alive` : plus aucune lecture lancée une fois la
 * confirmation fermée. Le résultat garde l'ordre de `files`.
 */
export async function readReviewFiles(
  files: readonly DiffFile[],
  fetch: (path: string) => Promise<FileDiff>,
  opts: { maxBytes?: number; alive?: () => boolean; parallel?: number; onRead?: (n: number) => void } = {},
): Promise<Map<string, FileRead>> {
  const maxBytes = opts.maxBytes ?? MAX_REVIEW_PASTED_BYTES
  const todo = files.slice(0, MAX_REVIEW_FILES_READ)
  const results: (FileRead | undefined)[] = new Array(todo.length)
  let used = 0
  let next = 0
  let done = 0
  async function worker() {
    for (;;) {
      if (opts.alive && !opts.alive()) return
      if (used > maxBytes) return
      const i = next++
      if (i >= todo.length) return
      const f = todo[i]!
      try {
        const diff = await fetch(f.path)
        results[i] = { ok: true, diff }
        used += utf8Bytes(unifiedFile(f, diff))
      } catch (e) {
        results[i] = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      opts.onRead?.(++done)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel ?? REVIEW_READ_PARALLEL, todo.length)) }, worker))
  // Ordre de `files`, en s'arrêtant au premier trou (le reste n'est pas inclus).
  const out = new Map<string, FileRead>()
  for (let i = 0; i < todo.length; i++) {
    const r = results[i]
    if (!r) break
    out.set(todo[i]!.path, r)
  }
  return out
}

/* ---------- Erreurs du lancement ---------- */

/** Le démon ne trouve pas le commit de départ (`-32602` « base inconnue ») : tête jamais récupérée. */
export function isUnknownBase(code: number | null, message: string): boolean {
  return code === -32602 && /base inconnue/.test(message)
}

/** Commande à lancer soi-même pour récupérer la tête d'une demande (GitHub) ; jamais exécutée par l'app. */
export function fetchCommand(t: ReviewTarget): string | null {
  return t.kind === 'pull' ? `git fetch origin pull/${t.pull.number}/head` : null
}

/* ---------- Registre local des sessions de revue ---------- */

export const REVIEW_MARKS_KEY = 'devmaestro.aiReview.sessions'
const MAX_MARKS = 200

export interface ReviewMark {
  kind: ReviewKind
  /** Numéro de la demande de fusion. */
  pr?: number
  /** Sha relu (complet). */
  sha?: string
  /** Racine du dépôt (ouvrir la PR, nettoyer le worktree). */
  root: string
  /** Chemin du worktree jetable créé ou réutilisé pour la revue (`null` : pas de worktree). */
  worktree: string | null
}

export type ReviewMarks = Readonly<Record<string, ReviewMark>>

function validMark(v: unknown): ReviewMark | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o.kind !== 'pull' && o.kind !== 'diff' && o.kind !== 'commit') return null
  if (typeof o.root !== 'string' || !o.root.startsWith('/')) return null
  const worktree = typeof o.worktree === 'string' && o.worktree.startsWith('/') ? o.worktree : null
  const pr = typeof o.pr === 'number' && Number.isSafeInteger(o.pr) && o.pr > 0 ? o.pr : undefined
  const sha = fullSha(o.sha) ?? undefined
  return { kind: o.kind, root: o.root, worktree, ...(pr ? { pr } : {}), ...(sha ? { sha } : {}) }
}

export function loadReviewMarks(storage: KeyValueStorage | null | undefined): ReviewMarks {
  try {
    const raw = storage?.getItem(REVIEW_MARKS_KEY)
    if (!raw) return {}
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
    const out: Record<string, ReviewMark> = {}
    for (const [id, m] of Object.entries(v)) {
      const ok = validMark(m)
      if (ok && /^[0-9a-f-]{1,64}$/i.test(id)) out[id] = ok
    }
    return out
  } catch {
    return {}
  }
}

export function saveReviewMarks(storage: KeyValueStorage | null | undefined, marks: ReviewMarks): void {
  try {
    const entries = Object.entries(marks).slice(-MAX_MARKS)
    storage?.setItem(REVIEW_MARKS_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* stockage indisponible ou plein : le badge reste en mémoire */
  }
}

/** Registre avec cette session (la plus récente en dernier, 200 au plus). */
export function withMark(marks: ReviewMarks, id: string, mark: ReviewMark): ReviewMarks {
  const { [id]: _old, ...rest } = marks
  const entries = [...Object.entries(rest), [id, mark] as const].slice(-MAX_MARKS)
  return Object.fromEntries(entries)
}

export function withoutMark(marks: ReviewMarks, id: string): ReviewMarks {
  if (!(id in marks)) return marks
  const { [id]: _old, ...rest } = marks
  return rest
}

/** Marque d'une session lancée : ce qu'on relit et où. */
export function markOf(t: ReviewTarget, worktree: string | null): ReviewMark {
  const sha = targetSha(t) ?? undefined
  return {
    kind: t.kind,
    root: targetRoot(t),
    worktree,
    ...(t.kind === 'pull' ? { pr: t.pull.number } : {}),
    ...(sha ? { sha } : {}),
  }
}

/**
 * Worktree jetable d'une session de revue arrêtée à proposer au nettoyage :
 * il existe encore, aucune session n'y tourne, et c'est bien celui de la
 * revue (`isReviewWorktree` : créé par l'app, branche de revue attendue,
 * tête encore sur le sha relu). Sinon rien n'est proposé.
 */
export function reviewCleanupWorktree(
  s: Pick<Session, 'alive'>,
  mark: ReviewMark | undefined,
  worktrees: readonly WorktreeInfo[] | undefined,
): WorktreeInfo | null {
  if (s.alive || !mark?.worktree || !mark.sha) return null
  const branch = markBranch(mark)
  if (!branch) return null
  const w = (worktrees ?? []).find((x) => x.path === mark.worktree)
  if (!w || !w.exists || (w.sessions_running ?? 0) > 0 || !isReviewWorktree(w, branch, mark.sha)) return null
  return w
}
