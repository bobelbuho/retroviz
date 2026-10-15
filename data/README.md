# Base de connaissances Rétroviz

Ce dossier contient les fiches que le serveur donne à l'IA **avant** qu'elle réponde. Quand une question mentionne un véhicule ou un code défaut présent ici, la fiche est envoyée à l'IA comme source prioritaire, et l'interface affiche sous la réponse quelles fiches ont servi.

Les fichiers sont lus **au démarrage du serveur** : après une modification, arrêtez le serveur (Ctrl+C) et relancez `npm start`. `npm run dev` ne surveille pas les fichiers JSON : il faut aussi le relancer. Si un fichier contient une erreur de syntaxe JSON, le serveur affiche un message `⚠️ Base Rétroviz : … ignoré` et démarre quand même, sans ces fiches.

Après chaque modification, lancez `npm test` : les tests vérifient aussi que les données sont bien formées.

## Règles de fiabilité (toutes les fiches)

Chaque fiche, quel que soit le fichier, porte ces champs :

| Champ | Rôle |
|---|---|
| `statut` | `a_verifier` ou `verifie`. Une fiche `verifie` doit avoir **au moins une source**. |
| `sources` | Liste des sources (texte ou URL), vide si aucune. |
| `redige_par` | `ia` (rédigée de mémoire par l'IA) ou `humain`. |
| `mise_a_jour` | Date de la dernière modification, au format `AAAA-MM-JJ`. |
| `incertitudes` | Facultatif : liste des points dont le rédacteur n'est pas sûr. |

- Tout ce que l'IA rédige de mémoire est en `a_verifier`, avec `redige_par: "ia"`.
- On n'invente jamais de source, de référence de pièce, de numéro de rappel constructeur ni de statistique précise. Dans le doute, on n'écrit pas l'information, ou on la met dans `incertitudes`.
- On préfère des fourchettes (km, coûts) à des valeurs exactes.
- Dans l'interface, une fiche `a_verifier` affiche discrètement « Fiche en cours de vérification ».
- `npm test` vérifie ces règles sur tous les fichiers (`test/donnees.test.js`).

## `voyants.json` : voyants et témoins du tableau de bord

Un tableau d'objets, un par voyant :

```json
{
  "id": "pression-huile",
  "nom": "Pression d'huile",
  "autres_noms": ["voyant huile", "burette rouge"],
  "couleurs": ["rouge"],
  "urgence": "rouge",
  "rouler": "non",
  "categorie": "moteur",
  "symbole": "Une burette d'huile d'où tombe une goutte.",
  "signification": "Deux phrases au plus, en langage simple.",
  "que_faire": ["Étape 1", "Étape 2"],
  "causes": ["Cause fréquente"],
  "cout": "De 10 à 20 € (…) à plusieurs milliers d'euros (…)",
  "variantes": [{ "etat": "fixe", "sens": "…" }, { "couleur": "bleu", "etat": "fixe", "sens": "…" }],
  "icone": "<path d=\"…\"/>",
  "incertitudes": [],
  "statut": "a_verifier", "sources": [], "redige_par": "ia", "mise_a_jour": "2026-10-14"
}
```

| Champ | Rôle |
|---|---|
| `couleurs` | Parmi `rouge`, `orange`, `vert`, `bleu`, `blanc`. La première sert à colorer l'icône. |
| `urgence` | `rouge` (s'arrêter), `orange` (garage rapidement) ou `info` (information). |
| `rouler` | `oui`, `prudemment` ou `non`. |
| `autres_noms` | Façons courantes d'en parler : elles servent à retrouver la fiche dans les questions. Un nom d'un seul mot (« ABS ») ne compte que si la question parle aussi de voyant, de témoin ou d'allumage. Évitez les mots trop vagues (« défaut », « service »). |
| `variantes` | Fixe ou clignotant, éventuellement selon la couleur. |
| `icone` | Contenu d'un SVG 24 × 24 (trait de 1,7, couleur `currentColor`), dessiné pour Rétroviz d'après l'esprit des symboles normalisés ISO 2575, sans copier d'image de constructeur. Seuls `path`, `circle`, `rect` et `text` sont autorisés : l'icône est insérée telle quelle dans la page, et les tests refusent tout le reste. |

Les voyants cités dans une question (« voyant huile rouge ») sont envoyés à l'IA comme les autres fiches, au plus 2 à la fois. L'écran « Voyants » de l'interface les affiche tous.

## `obd.json` : codes défaut OBD-II génériques

Un tableau d'objets :

```json
{
  "code": "P0300",
  "libelle": "Ratés d'allumage aléatoires ou multiples détectés",
  "causes_frequentes": ["Bougies usées", "Bobine(s) d'allumage défaillante(s)"],
  "verifications": ["Compteurs de ratés par cylindre en données dynamiques"],
  "statut": "a_verifier",
  "sources": [],
  "redige_par": "ia",
  "mise_a_jour": "2026-10-13"
}
```

- `code` : lettre P, B, C ou U, puis 4 caractères (ex. `P0300`, `P20EE`, `U0100`). Un code ne doit apparaître qu'une fois.
- `statut`, `sources`, `redige_par` et `mise_a_jour` suivent les règles de fiabilité ci-dessus.
- Seuls les codes **génériques** (normalisés, identiques pour toutes les marques) ont leur place ici. Les codes constructeur (souvent P1xxx) n'ont pas le même sens selon la marque.

## `marques/` : marques, modèles, générations et motorisations

Un fichier par marque (`marques/peugeot.json`…), organisé ainsi : **marque › modèles › générations › motorisations**.

```json
{
  "id": "peugeot", "nom": "Peugeot", "pays": "France",
  "image": "…", "cout_entretien": "moyen", "cout_entretien_texte": "…", "reseau": "…",
  "statut": "a_verifier", "sources": [], "redige_par": "ia", "mise_a_jour": "2026-10-14",
  "modeles": [{
    "id": "peugeot-208", "nom": "208",
    "qualites": ["…"], "defauts": ["…"], "pour_qui": "…", "a_verifier_achat": ["…"],
    "statut": "a_verifier", "sources": [], "redige_par": "ia", "mise_a_jour": "2026-10-14",
    "generations": [{
      "id": "peugeot-208-1", "nom": "208 I", "annees": "2012-2019", "alias": ["208 1", "208 phase 1"],
      "motorisations": [{
        "id": "peugeot-208-1-12-puretech",
        "moteurs": ["1.2 PureTech 82", "1.2 PureTech 110"], "codes_moteur": ["EB2F", "EB2DT"],
        "energie": "thermique", "carburant": "essence",
        "conseil": "neutre", "conseil_texte": "Bon moteur si l'entretien est prouvé.",
        "pannes": [{ "titre": "…", "km_typique": 80000, "gravite": "elevee", "symptomes": "…", "solution": "…", "cout_indicatif": "800 à 1 500 €" }],
        "entretiens": [{ "titre": "Courroie de distribution", "km": 100000, "cout_indicatif": "700 à 1 200 €" }],
        "points_forts": ["…"], "points_faibles": ["…"],
        "statut": "a_verifier", "sources": [], "redige_par": "ia", "mise_a_jour": "2026-10-13"
      }]
    }]
  }]
}
```

Le reste de l'application (assistant, garage, « À venir », schéma, Observateur) voit chaque **motorisation** comme une fiche « à plat », avec `marque`, `modele`, `generation`, `annees` et `alias` hérités de sa génération et de son modèle (`marques.js`). Les identifiants des motorisations ne changent jamais : ce sont eux que retiennent les voitures des garages. La Relecture présente trois collections : **Marques**, **Modèles** (avec leurs générations) et **Motorisations**.

| Champ | Rôle |
|---|---|
| `id` | Identifiant unique, en minuscules avec des tirets. |
| `cout_entretien` (marque) | `faible`, `moyen` ou `eleve`, expliqué par `cout_entretien_texte`. |
| `alias` (modèle) | Autres noms du modèle (« vw golf »). Ils aident à reconnaître le modèle mais ne désignent pas une génération. |
| `generations[].annees` | `AAAA-AAAA`, ou `AAAA-auj.` pour une génération encore produite. |
| `generations[].alias` | Autres noms de la génération (« Clio 4 », « golf 7 ») : ils départagent les générations. |
| `annees_propres` (motorisation) | Facultatif : période de la motorisation si elle diffère de celle de la génération. |
| `moteurs` | Au format « cylindrée nom puissance » (ex. `1.5 dCi 90`). Une cylindrée différente dans la question écarte la fiche ; une cylindrée demandée écarte aussi les électriques. |
| `energie`, `carburant` | `thermique`, `hybride`, `hybride_rechargeable` ou `electrique` ; `essence` ou `diesel`. |
| `conseil` | `a_privilegier`, `neutre` ou `a_eviter`, expliqué par `conseil_texte`. |
| `pannes[].gravite` | `faible`, `moyenne` ou `elevee`. |

### Comment la recherche fonctionne

Le texte (champ « Votre véhicule », ou le message si ce champ est vide) est mis en minuscules, sans accents. « 1,2 » devient « 1.2 » et « pure tech » équivaut à « puretech ». Une fiche est retenue si le **modèle** ou le **moteur** correspond. Au plus 2 fiches sont envoyées. Si le modèle est reconnu, les fiches d'autres modèles qui partagent seulement le moteur sont écartées ; si le moteur l'est aussi, les autres moteurs du même modèle aussi. Une génération nommée (« Clio IV ») écarte les autres générations ; sinon, une année qui tombe dans la période d'une génération écarte les générations hors période. Sinon, ces fiches sont envoyées avec la mention « même moteur », et l'IA est priée de n'en utiliser que les informations moteur.

## Ajouter une fiche

1. Dans le fichier de la marque (`marques/…json`), copiez une motorisation existante et collez-la dans la bonne génération (attention aux virgules entre les objets).
2. Changez l'`id` (il doit être unique, et ne plus jamais changer ensuite), puis tous les champs.
3. Laissez `"statut": "a_verifier"` tant que les informations ne sont pas recoupées.
4. Mettez la date du jour dans `mise_a_jour`.
5. Lancez `npm test`, puis relancez le serveur.

## Vérifier une fiche dans la page « Relecture »

La page « Relecture » n'est visible que pour les comptes dont l'adresse figure dans `ADMIN_EMAILS` (fichier `.env`, adresses séparées par des virgules). Pour tous les autres, elle n'existe pas.

1. Onglet « Fiches » : filtrez par collection, par statut ou par mot.
2. Ouvrez une fiche : son contenu s'affiche en JSON, modifiable. « Enregistrer la correction » refuse toute fiche qui ne respecte pas les règles de fiabilité (statut, sources, format, icône sans danger…).
3. « Ajouter une source » : une URL ou une référence précise, réellement consultée.
4. « Passer en vérifiée » n'est possible qu'avec au moins une source, et après avoir recoupé chaque information.

Chaque action est écrite dans le fichier JSON de `data/` (donc visible dans git) avec la date de mise à jour et une ligne dans `revisions` (`date`, `par`, `action`). Une fiche validée garde aussi `verifie_par` et `verifie_le`. La base est rechargée aussitôt : pas besoin de relancer le serveur. La variable `DATA_DIR` permet de travailler sur une copie de `data/` (essais).

## Passer une fiche en « vérifiée » (à la main)

Une fiche ne passe en `"statut": "verifie"` que si :

1. chaque information (pannes, kilométrages, intervalles d'entretien, coûts) a été recoupée avec une source fiable : documentation constructeur, note technique, base technique professionnelle, rappel officiel, expérience d'atelier documentée… ;
2. **au moins une source** est indiquée dans `sources`, par exemple :
   ```json
   "sources": ["Carnet d'entretien Renault Clio IV (2016), p. 34", "https://…"],
   ```
3. `mise_a_jour` porte la date de la vérification.

Les tests (`npm test`) et la Relecture refusent une fiche `verifie` sans source.

Toutes les fiches livrées au départ sont **à vérifier** : elles ont été rédigées à partir de connaissances générales et peuvent contenir des erreurs, en particulier les kilométrages, les intervalles d'entretien et les coûts.
