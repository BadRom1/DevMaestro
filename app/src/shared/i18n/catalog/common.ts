/** Textes communs : statuts de session (`state/status.ts`), composants de `components/common.tsx`, langues. */
import { defineMessages } from '../core'

export const common = defineMessages({
  fr: {
    'common.status.waitingPermission': 'À répondre : permission',
    'common.status.waitingQuestion': 'À répondre : question',
    'common.status.waiting': 'À répondre',
    'common.status.starting': 'Démarrage',
    'common.status.running': 'En cours',
    'common.status.idle': 'Inactive',
    'common.status.stopped': 'Arrêtée',
    'common.status.error': 'Erreur',
    'common.status.unknown': 'Statut inconnu',
    'common.profileBadgeTitle': 'Profil {label} ({profile})',
    'common.anyProfileTitle': 'Visible par plusieurs profils : profil d’origine inconnu',
    'common.profileChipTitle': 'Profil Claude Code {label} ({profile})',
    'common.language.system': 'Système',
    'common.language.fr': 'Français',
    'common.language.en': 'English',
  },
  en: {
    'common.status.waitingPermission': 'Needs answer: permission',
    'common.status.waitingQuestion': 'Needs answer: question',
    'common.status.waiting': 'Needs answer',
    'common.status.starting': 'Starting',
    'common.status.running': 'Running',
    'common.status.idle': 'Idle',
    'common.status.stopped': 'Stopped',
    'common.status.error': 'Error',
    'common.status.unknown': 'Unknown status',
    'common.profileBadgeTitle': 'Profile {label} ({profile})',
    'common.anyProfileTitle': 'Visible to several profiles: original profile unknown',
    'common.profileChipTitle': 'Claude Code profile {label} ({profile})',
    'common.language.system': 'System',
    'common.language.fr': 'Français',
    'common.language.en': 'English',
  },
})
