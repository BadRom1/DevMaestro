/**
 * Chaînes en dur **acceptées** par le détecteur (`i18n-hardcoded.test.ts`,
 * lot 20), chacune avec sa raison. Préférer, au plus près du code, un
 * commentaire `// i18n-exempt: <raison>` sur la ligne ou celle du dessus ;
 * cette liste sert aux cas qu'un commentaire ne peut pas viser (texte JSX
 * réparti, fichier entier).
 *
 * `file` : chemin depuis `app/` ; `text` : texte signalé (espaces réduits),
 * exact ou expression régulière ; `'*'` : tout le fichier.
 */
export interface I18nException {
  file: string
  text: string | RegExp
  reason: string
}

export const I18N_EXCEPTIONS: readonly I18nException[] = []
