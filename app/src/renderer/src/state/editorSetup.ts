/**
 * Configuration de l'éditeur CodeMirror 6 de l'onglet Fichiers (lot 7) :
 * numéros de ligne, annuler / refaire, recherche, raccourcis standards,
 * Ctrl+S (enregistrer), thème tiré des jetons (variables CSS : clair,
 * sombre, palettes et taille de l'interface suivent sans reconfiguration),
 * coloration par les classes `hljs-*` de la lecture.
 *
 * Fins de ligne : un fichier CRLF garde ses CRLF (`lineSeparator`) ; le texte
 * à enregistrer se lit avec `editorText` (jamais `doc.toString()`, qui
 * rejoint toujours par `\n`).
 */
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec, Text, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

import { editorLanguage } from './editorLanguage'
import { eolStyle, normalizeEol } from './fileEdit'

/** Coloration : mêmes classes (et donc mêmes couleurs `--hl-*`) que highlight.js en lecture. */
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], class: 'hljs-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape, t.docString], class: 'hljs-string' },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal, t.unit], class: 'hljs-number' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'hljs-comment' },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName), t.macroName], class: 'hljs-title' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: 'hljs-title hljs-section' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], class: 'hljs-type' },
  { tag: [t.propertyName, t.attributeName, t.labelName, t.tagName], class: 'hljs-attr' },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], class: 'hljs-meta' },
  { tag: [t.link, t.url], class: 'hljs-link' },
  { tag: t.inserted, class: 'hljs-addition' },
  { tag: t.deleted, class: 'hljs-deletion' },
  { tag: t.emphasis, class: 'hljs-emphasis' },
  { tag: t.strong, class: 'hljs-strong' },
])

/** Habillage tiré des jetons du thème (mêmes police, taille et hauteur de ligne que la vue code). */
const themeSpec = {
  '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--panel)', fontSize: '12.5px' },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--f-mono)', lineHeight: '20px' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '12px 0' },
  '.cm-line': { padding: '0 16px 0 12px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel)',
  },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--faint)', borderRight: '1px solid var(--line)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--wait) 28%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--wait) 60%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--wait) 50%, transparent)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--run) 25%, transparent)', outline: 'none' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'color-mix(in srgb, var(--err) 25%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--fg)', fontFamily: 'var(--f-body)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '6px 28px 6px 8px' },
  '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--muted)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)', fontSize: '16px' },
  '.cm-textfield': {
    backgroundColor: 'var(--sunk)',
    color: 'var(--fg)',
    border: '1px solid var(--line-2)',
    borderRadius: '4px',
    fontFamily: 'var(--f-mono)',
    fontSize: '12px',
  },
  '.cm-textfield:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-1px' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--panel)',
    color: 'var(--fg)',
    border: '1px solid var(--line-2)',
    borderRadius: '4px',
    fontSize: '12px',
  },
  '.cm-button:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-1px' },
  '.cm-tooltip': { backgroundColor: 'var(--panel-2)', color: 'var(--fg)', border: '1px solid var(--line-2)' },
  '.cm-specialChar': { color: 'var(--err)' },
}

const lightTheme = EditorView.theme(themeSpec, { dark: false })
const darkTheme = EditorView.theme(themeSpec, { dark: true })

/** Thème clair ou sombre de base de CodeMirror selon le mode affiché (`data-theme` de la page). */
export function themeFor(doc: Document = document): Extension {
  return doc.documentElement.dataset.theme === 'light' ? lightTheme : darkTheme
}

/** Phrases de l'interface de CodeMirror (recherche, aides), en français. */
const PHRASES: Record<string, string> = {
  Find: 'Rechercher',
  Replace: 'Remplacer',
  next: 'suivant',
  previous: 'précédent',
  all: 'tout',
  'match case': 'respecter la casse',
  'by word': 'mot entier',
  regexp: 'expression régulière',
  replace: 'remplacer',
  'replace all': 'tout remplacer',
  close: 'fermer',
  'current match': 'occurrence courante',
  'on line': 'à la ligne',
  'replaced match on line $': 'occurrence remplacée à la ligne $',
  'replaced $ matches': '$ occurrences remplacées',
  'Go to line': 'Aller à la ligne',
  go: 'aller',
  'Control character': 'Caractère de contrôle',
  'Folded lines': 'Lignes repliées',
  'Unfolded lines': 'Lignes dépliées',
  to: 'à',
  'folded code': 'code replié',
  unfold: 'déplier',
  'Fold line': 'Replier la ligne',
  'Unfold line': 'Déplier la ligne',
  'Selection deleted': 'Sélection supprimée',
}

export interface EditorHooks {
  /** Le texte diffère (ou non) de la version ouverte. */
  onDirty: (dirty: boolean) => void
  /** Ctrl+S (Cmd+S) : enregistrer. */
  onSave: () => void
  /** Texte de l'aria-label de la zone d'édition. */
  label: string
}

/** Réglages qui changent pendant l'édition (lecture seule pendant l'enregistrement, thème clair / sombre). */
export const readOnlyConf = new Compartment()
export const themeConf = new Compartment()

/** État initial de l'éditeur pour `text` (version ouverte) du fichier `path`. */
export function createEditorState(text: string, path: string, hooks: EditorHooks, opts: { readOnly?: boolean; doc?: Document } = {}): EditorState {
  const crlf = eolStyle(text) === 'crlf'
  /** Texte de la version ouverte (posé une fois l'état créé). */
  const opened: { doc: Text } = { doc: Text.empty }
  const extensions: Extension[] = [
    ...(crlf ? [EditorState.lineSeparator.of('\r\n')] : []),
    // Collé ou déposé : fins de ligne ramenées à celles du fichier (sinon CRLF et LF se mélangeraient).
    EditorView.clipboardInputFilter.of((t) => normalizeEol(t, crlf ? 'crlf' : 'lf')),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of(text.includes('\n\t') ? '\t' : '  '),
    syntaxHighlighting(highlightStyle),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.phrases.of(PHRASES),
    EditorView.contentAttributes.of({ 'aria-label': hooks.label, 'aria-multiline': 'true' }),
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            hooks.onSave()
            return true
          },
        },
      ]),
    ),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    editorLanguage(path),
    themeConf.of(themeFor(opts.doc)),
    readOnlyConf.of(EditorState.readOnly.of(!!opts.readOnly)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.onDirty(!u.state.doc.eq(opened.doc))
    }),
  ]
  const state = EditorState.create({ doc: text, extensions })
  opened.doc = state.doc
  return state
}

/** Texte à enregistrer, avec les fins de ligne du fichier. */
export function editorText(state: EditorState): string {
  return state.sliceDoc()
}
