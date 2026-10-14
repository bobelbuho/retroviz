# Système de design Rétroviz

Une interface épurée en bleu et blanc, rassurante et facile à utiliser, autant pour quelqu'un qui n'y connaît rien que pour un mécanicien.

Toutes les valeurs sont des variables CSS définies au début du `<style>` de [public/index.html](public/index.html). Un nouvel écran n'introduit **aucune** couleur, taille, marge ou arrondi en dur : il réutilise ces variables, ou en ajoute une ici et dans le `:root`.

## Principes

1. **Un titre, une action principale par écran.** L'action principale est le seul bouton bleu plein. Le reste est en bouton bleu clair (`.btn.soft`) ou en texte seul (`.btn.ghost`).
2. **Beaucoup d'espace, peu de bordures.** Les blocs se distinguent par le fond (`--surface` sur `--bg`) et une ombre légère (`--shadow`), pas par des cadres.
3. **Le vert, l'orange et le rouge ont un sens, jamais un rôle décoratif** : niveaux de gravité, alertes, suppression définitive.
4. **Des textes courts.** Une phrase d'introduction par écran, au plus. Les explications détaillées vont dans les aides (`.hint`) ou les réponses.
5. **Accessible par défaut** : contrastes WCAG AA, focus clavier visible, cibles tactiles de 44 px, rendu correct dès 360 px de large.

## Couleurs

| Variable | Clair | Sombre (bleu nuit) | Usage |
|---|---|---|---|
| `--bg` | `#F6F9FD` | `#0A1426` | Fond de page |
| `--surface` | `#FFFFFF` | `#101D33` | Cartes, champs, fenêtres |
| `--soft` | `#E8F0FB` | `#172A4A` | Bleu clair : fonds de section, éléments actifs, boutons secondaires |
| `--soft-hover` | `#DCE8F8` | `#1E3459` | Survol des éléments `--soft` |
| `--line` | `#D8E3F0` | `#24375A` | Séparateurs décoratifs uniquement |
| `--field-line` | `#7A8CA6` | `#62789E` | Bordure des champs (contraste 3:1 exigé) |
| `--ink` | `#0E1F3B` | `#E6EEF9` | Texte principal |
| `--muted` | `#4E5F78` | `#A3B4CF` | Texte secondaire, gris bleuté |
| `--primary` | `#123F8C` | `#8DB8F7` | Bleu profond : actions, titres de section, liens, focus |
| `--primary-hover` | `#0D3170` | `#B0CEFA` | Survol du bleu profond |
| `--on-primary` | `#FFFFFF` | `#0A1426` | Texte posé sur `--primary` |

Couleurs de sens. La version simple sert aux pastilles, voyants et bordures (contraste 3:1 au moins). La version `-ink` sert au texte coloré (4,5:1 au moins).

| Sens | Graphique | Texte | Usage |
|---|---|---|---|
| Vert | `--green` | `--green-ink` | « Vous pouvez rouler », gravité faible, bon choix |
| Orange | `--amber` | `--amber-ink` | « Prévoyez le garage », gravité moyenne, prudence |
| Rouge | `--red` | `--red-ink` | « Arrêtez-vous », gravité élevée, signe d'alerte, suppression |
| Gris | `--grey` | — | Niveau inconnu |

Pour un fond teinté de sens (bandeau de niveau, étiquette) : `color-mix(in srgb, var(--c) 12%, var(--surface))` avec du texte `--ink`. On ne met jamais de texte blanc sur l'orange.

Contrastes vérifiés (ratio WCAG) : texte principal 14 à 16:1, texte secondaire 5,6 à 8:1, bouton principal 9 à 10:1, texte coloré de sens 6,5:1 ou plus, bordure des champs 3,2:1 ou plus. Si vous changez une couleur, revérifiez le contraste.

**Mode sombre** : il suit le réglage du système (`prefers-color-scheme`). On peut le forcer avec `data-theme="dark"` ou `data-theme="light"` sur `<html>`. Toute nouvelle variable doit être définie dans les **trois** blocs : `:root`, le `@media (prefers-color-scheme: dark)` et `:root[data-theme="dark"]`.

## Typographie

Une seule police : **Barlow** (Google Fonts, graisses 400, 500, 600 et 700), avec repli sur les polices système.

| Variable | Taille | Usage |
|---|---|---|
| `--fs-xs` | 13 px | Aides, sources, mentions, pied de page |
| `--fs-sm` | 15 px | Textes secondaires, libellés, pastilles, navigation |
| `--fs-md` | 17 px | Texte courant, champs, boutons |
| `--fs-lg` | 20 px | Titres de section, titres des modes |
| `--fs-xl` | 24 px | Titres de carte et de fenêtre |
| `--fs-2xl` | 32 px | Réservé à un grand titre de page |
| `--fs-brand` | 30 px | Logo « Rétroviz » |

Interlignes : `--lh` (1,55) pour le texte, `--lh-tight` (1,2) pour les titres. Graisses : `--fw-regular`, `--fw-medium`, `--fw-semibold`, `--fw-bold`.

Les titres de section sont en `--primary`, en gras. Le texte courant ne descend jamais sous 15 px.

## Espacements, arrondis, mise en page

- **Espacements** (multiples de 4 px) : `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24, `--sp-6` 32, `--sp-7` 48, `--sp-8` 64.
  - entre éléments liés : `--sp-2` ou `--sp-3` ;
  - intérieur des cartes : `--sp-5` (`--sp-4` sous 420 px) ;
  - entre blocs : `--sp-5` ou `--sp-6`.
- **Arrondis** : `--r-sm` 8 px (champs, boutons), `--r-md` 12 px (modes, sections), `--r-lg` 16 px (cartes, fenêtres, bulles), `--r-pill` (pastilles, liens de navigation).
- **Page** : largeur maximale `--page-max` (880 px), marges latérales `--gutter` (16 px sur mobile, 24 px au-delà de 600 px).
- **Cibles tactiles** : `--tap` (44 px) de haut au minimum pour les boutons, champs et liens de navigation. `.btn.small` (36 px) est réservé aux actions secondaires groupées.
- **Points de rupture** : 420 px (petit mobile), 640 px (les modes et colonnes passent en une colonne), 700 px (formulaires en 2 colonnes), 800 px.

## Composants

| Classe | Rôle |
|---|---|
| `.btn` | Action principale : bleu profond plein. Une seule par écran. |
| `.btn.soft` | Action secondaire : fond bleu clair, texte bleu. |
| `.btn.ghost` | Action discrète : texte bleu seul, fond bleu clair au survol. |
| `.btn.red` / `.btn.stop` | Action destructrice ou arrêt. |
| `.btn.small` | Variante compacte pour les actions groupées (cartes). |
| `.link` | Lien dans une phrase (souligné). |
| `.navlink` | Liens de l'en-tête (« Mon garage », « Mon compte ») ; `aria-current="page"` pour la page active. |
| `.mode` | Les trois modes ; `aria-selected="true"` = fond `--soft`, bordure `--primary`. |
| `.field` | Champ de saisie ou liste ; focus = bordure `--primary` et halo. |
| `.hint` | Aide sous un champ. |
| `.form` | Formulaire en grille de 4 colonnes (`.s2` = 2 colonnes, `.full` = toute la largeur). |
| `.car`, `.box`, `.msg-ai`, `.odo` | Cartes : `--surface`, `--r-lg`, `--shadow`, sans bordure. |
| `.help`, `.empty`, `.notice`, `.fiche` | Blocs d'information : fond `--soft`, sans bordure. |
| `.pill` | Statut d'un élément (`data-s` : `retard` rouge, `bientot` orange, `plus_tard` vert, `verifier`/`surveiller` bleu, `inconnu` gris). Pastille de couleur et texte : l'information ne passe jamais par la couleur seule. |
| `.badge` | Compteur rouge à côté d'un titre (« 2 en retard »). Réservé à ce qui est en retard. |
| `.av` | Élément de « À venir » : carte avec filet gauche rouge ou orange seulement pour « en retard » et « bientôt ». |
| `.formsec` | Sous-titre de section dans un formulaire en grille. |
| `.ent` | Entretien du carnet : carte avec le type en titre, le coût à droite, la date, le kilométrage et le garage en `--muted`. |
| `.check` | Case à cocher avec son libellé (cible de 20 px, couleur `--primary`). |
| `.back` | Lien de retour (« ← Mon garage ») en `.btn.ghost.small`, en haut d'une vue détaillée. |
| `.kmbox`, `.kmpanel`, `.kmlist` | Kilométrage d'une voiture : chiffre clé en `--fs-lg`, panneau dépliable sur fond `--soft`, liste en chiffres tabulaires. |
| `.level`, `.tag`, `.item` | Éléments porteurs de sens : la variable locale `--c` reçoit `--green`, `--amber`, `--red` ou `--grey`. |
| `.danger-box` | Alerte « arrêtez-vous » : fond rouge très clair, filet rouge à gauche, texte `--red-ink`. |
| `dialog.dlg` | Fenêtre modale (compte). |

## Écrire un nouvel écran

1. Une phrase d'introduction en `.intro`, puis le contenu.
2. Une seule `.btn` pleine ; les autres actions en `.soft` ou `.ghost`.
3. Des cartes (`.car`, `.box`) ou des fonds `--soft`, pas de bordures.
4. Vérifier à 360 px de large, en clair et en sombre, au clavier (Tab) : focus visible, aucun défilement horizontal.
