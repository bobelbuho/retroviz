# Rétroviz

> Regardez dans le rétro, roulez l'esprit tranquille.

Assistant automobile avec trois modes : **J'ai une panne** (particuliers), **Diagnostic pro** (mécaniciens) et **J'achète une voiture** (analyse d'une occasion : qualités, défauts, pannes à venir selon le kilométrage). Avec un compte, **Mon garage** garde vos voitures.

## Structure

```
retroviz/
├── public/index.html   ← l'interface (HTML, CSS, JavaScript)
├── server.js           ← le serveur qui appelle l'API Claude
├── knowledge.js        ← la recherche dans la base de connaissances
├── auth.js             ← les comptes (inscription, connexion, export, suppression)
├── garage.js           ← « Mon garage » : les voitures de chaque compte
├── kilometrage.js      ← relevés de kilométrage : validation, cohérence, moyenne par mois
├── carnet.js           ← carnet d'entretien et factures
├── avenir.js           ← calcul de « À venir » : rappels et prochains entretiens (sans base de données)
├── rappels.js          ← routes « À venir » et rappels libres
├── valeur.js           ← valeur indicative estimée par l'IA, historique
├── storage.js          ← stockage des fichiers (factures) : enregistrer, lire, supprimer
├── db.js               ← la base SQLite (comptes, garages)
├── storage/            ← la base (retroviz.db) et les factures (uploads/), créés au démarrage, jamais publiés
├── data/               ← la base de connaissances (fiches JSON + mode d'emploi)
│   ├── obd.json
│   ├── vehicules.json
│   └── README.md
├── test/               ← les tests (npm test)
├── package.json        ← les dépendances
├── .env.example        ← modèle du fichier de configuration
├── DESIGN.md           ← le système de design (couleurs, textes, espacements)
└── README.md
```

## Installation

1. Installez **Node.js** (version LTS, 22.13 au minimum) depuis https://nodejs.org
2. Ouvrez le dossier `retroviz` dans VS Code (Fichier > Ouvrir le dossier).
3. Créez une clé API sur https://console.anthropic.com (il faut ajouter un moyen de paiement : chaque question est facturée à l'usage).
4. Copiez `.env.example`, renommez la copie en `.env` et collez votre clé à la place de `sk-ant-votre-cle-ici`.
5. Ouvrez le terminal de VS Code (Terminal > Nouveau terminal) et tapez :

```
npm install
npm start
```

6. Ouvrez http://localhost:3000 dans votre navigateur.

Pendant que vous modifiez le code, `npm run dev` relance le serveur automatiquement à chaque enregistrement de `server.js`. Pour l'interface, il suffit de recharger la page.

## Important

- Ne partagez jamais votre fichier `.env` et ne le publiez pas sur GitHub (il est déjà exclu par `.gitignore`).
- Le modèle utilisé se change dans `.env` (variable `MODEL`).
- Les réponses s'appuient en priorité sur la base Rétroviz quand elle couvre la question, sinon sur les connaissances générales du modèle d'IA : elles peuvent être incomplètes ou inexactes.

## Base de connaissances

Avant chaque réponse, le serveur cherche dans le dossier `data/` les fiches qui correspondent au véhicule et aux codes défaut cités dans le message. Le véhicule vient du champ « Votre véhicule », du formulaire d'achat ou, à défaut, du message lui-même. Les fiches trouvées sont envoyées à l'IA comme **source prioritaire**, avec la consigne de signaler quand elle s'appuie sur une fiche « à vérifier ».

- `data/obd.json` : codes défaut OBD-II génériques (libellé, causes fréquentes, vérifications).
- `data/vehicules.json` : fiches par véhicule et motorisation (pannes connues avec leur kilométrage, entretiens, points forts et faibles).
- Chaque fiche a un statut : **à vérifier** (rédigée sans source, peut contenir des erreurs) ou **vérifiée** (au moins une source indiquée). Toutes les fiches livrées au départ sont à vérifier.
- Sous chaque réponse, une ligne indique les fiches utilisées, par exemple « Sources : base Rétroviz – Peugeot 208 1.2 PureTech (à vérifier), code P0300 (à vérifier) », ou « Sources : connaissances générales de l'IA ».
- `GET /api/codes/P0300` renvoie la fiche d'un code, en JSON.
- Le format des fiches, l'ajout d'une fiche et le passage en « vérifiée » sont expliqués dans [data/README.md](data/README.md).
- Après une modification des fichiers JSON, lancez `npm test`, puis relancez le serveur (les fiches sont lues au démarrage).

La recherche se fait par mots-clés, sans base de données ni vectorisation, dans `knowledge.js`.

## Comptes utilisateurs

Les comptes sont facultatifs : l'assistant reste utilisable sans compte. Le bouton « Se connecter » en haut à droite permet de créer un compte (e-mail et mot de passe de 12 caractères minimum) ; une fois connecté, « Mon compte » permet de télécharger ses données (RGPD, portabilité) ou de supprimer son compte (RGPD, effacement, mot de passe redemandé).

- Les comptes sont stockés dans `storage/retroviz.db` (SQLite, intégré à Node, rien à installer). La variable `DB_PATH` du fichier `.env` change cet emplacement. Ce fichier contient des données personnelles : ne le partagez pas (il est exclu par `.gitignore`).
- Les mots de passe ne sont jamais stockés en clair (hachage scrypt avec sel). La session est un cookie `HttpOnly` valable 30 jours ; seule son empreinte est stockée en base.
- Après 5 mots de passe erronés pour une même adresse, la connexion est bloquée 15 minutes.
- En production (`NODE_ENV=production`, derrière HTTPS), le cookie est en plus marqué `Secure`.
- Routes : `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/account/export`, `DELETE /api/account`.

## Mon garage

« Mon garage », en haut à droite (compte requis), enregistre les voitures de l'utilisateur : surnom, marque, modèle, motorisation, année, boîte. 30 voitures au plus par compte.

- **Fiche reliée** : à chaque enregistrement, le serveur cherche une fiche de `data/vehicules.json`. Il ne la relie que si le modèle **et** le moteur correspondent, et si l'année tombe dans la période de la fiche (une fiche fausse est pire que pas de fiche). L'utilisateur peut écarter une fiche (« Ce n'est pas ma voiture ») ou en chercher une à nouveau.
- **Poser une question** : remplit le champ « Votre véhicule » avec la désignation de la voiture et ouvre « J'ai une panne ». Le menu « Mes voitures… » à côté de ce champ fait la même chose depuis les modes de discussion.
- Les voitures, leurs relevés, entretiens, rappels libres et estimations de valeur sont inclus dans l'export des données et effacés avec le compte.
- **Kilométrage** : chaque voiture a ses relevés (date et kilométrage). Le « Kilométrage actuel » saisi à l'ajout devient le premier relevé. Un relevé à la même date remplace le précédent. Un relevé incohérent est refusé : un compteur ne recule pas. La **moyenne de km par mois** est calculée entre le premier et le dernier relevé, s'ils sont espacés d'au moins 30 jours. Le dernier kilométrage est ajouté à la désignation envoyée à l'assistant.
- Routes (connexion requise) : `GET /api/garage`, `POST /api/garage`, `PUT /api/garage/:id`, `DELETE /api/garage/:id`, et pour les relevés `GET` et `POST /api/garage/:id/releves`, `DELETE /api/garage/:id/releves/:rid`.

## Carnet d'entretien

Depuis la carte d'une voiture, « Ouvrir le carnet » liste ses entretiens, du plus récent au plus ancien, avec le total dépensé.

- **Un entretien** : date, type (vidange, distribution, freins, pneus, batterie, contrôle technique, réparation, autre), kilométrage, garage, coût, description et une facture facultative.
- **Kilométrage** : il doit rester cohérent avec les relevés de la voiture. Si la case « Ajouter ce kilométrage à mes relevés » est cochée (par défaut), il devient un relevé à la date de l'entretien.
- **Factures** : photo (JPEG, PNG, WebP, HEIC) ou PDF, 10 Mo au plus.
  - Le vrai type est vérifié d'après le contenu du fichier, pas d'après son extension.
  - Chaque fichier est enregistré sous un nom aléatoire dans `storage/uploads/`, hors du dossier public et exclu de git.
  - Une facture n'est servie qu'à son propriétaire connecté.
  - Elle est supprimée avec l'entretien, la voiture ou le compte, et listée dans l'export des données.
  - Les photos HEIC sont proposées au téléchargement, car les navigateurs ne savent pas les afficher.
- **Stockage** : tout passe par `storage.js` et ses trois fonctions `save`, `read` et `remove`. Pour passer à un stockage compatible S3 hébergé en Europe (Scaleway, OVH), il suffit d'écrire un autre `createXxxStorage` avec les mêmes fonctions et de le choisir dans `server.js`. La variable `UPLOAD_DIR` du `.env` change le dossier local.
- **Routes** (connexion requise) : `GET` et `POST /api/garage/:id/entretiens`, `PUT` et `DELETE /api/garage/:id/entretiens/:eid`, et pour la facture `PUT` (fichier brut dans le corps, nom d'origine dans l'en-tête `X-Filename`), `GET` et `DELETE /api/garage/:id/entretiens/:eid/facture`.

## À venir : rappels et prochains entretiens

Depuis la carte d'une voiture, « Tout ce qui arrive » ouvre l'écran « À venir ». Il regroupe les rappels et les prochains entretiens, du plus urgent au plus lointain.

- **Statuts** :
  - **En retard** (rouge) ;
  - **Bientôt** (orange : moins de 30 jours ou de 1 000 km) ;
  - **Plus tard** ;
  - **À vérifier** : entretien de la fiche déjà dépassé sans trace dans le carnet, il a peut-être été fait par un ancien propriétaire ;
  - **À surveiller** : panne connue, jamais présentée comme certaine, regroupée dans une section repliée en bas de l'écran ;
  - **À compléter** : il manque une information.
- **Contrôle technique** : premier contrôle avant les 4 ans (d'après la date de première mise en circulation, case B de la carte grise), puis tous les 2 ans.
  - Le calcul est exact si la date du dernier contrôle est connue : champ « Date du dernier contrôle technique » de la voiture, ou contrôle noté dans le carnet. Le plus récent des deux l'emporte.
  - Sinon, on suppose les contrôles faits à temps et l'écran affiche « À compléter ».
  - C'est toujours une estimation, à vérifier sur le procès-verbal.
- **Assurance** : date d'échéance saisie, renouvelée chaque année.
- **Vidange** : intervalle en km et en mois. Par défaut, c'est celui de la fiche Rétroviz liée, sinon 15 000 km ou 12 mois, modifiable. La prochaine se calcule depuis la dernière vidange du carnet.
- **Pneus hiver** (facultatif) : monter avant le 1er novembre, démonter à partir du 1er avril, avec un rappel de la loi Montagne.
- **Rappels libres** : un titre, avec une date ou un kilométrage.
- **Prochains entretiens** : ceux de la fiche liée (bougies, distribution…), tous les N km. Si le carnet en contient un, le suivant est recalculé à partir de lui. La date est estimée grâce à la moyenne de km par mois.
- **Pannes connues** : celles de la fiche, « à surveiller » vers leur kilométrage typique.
- **Sur la carte de la voiture** : une ligne résume le plus urgent, et un badge rouge compte ce qui est en retard.
- **« C'est fait »** : ouvre l'ajout d'un entretien pré-rempli dans le carnet. Pour un rappel libre, celui-ci est supprimé une fois l'entretien enregistré.
- Les rappels ne s'affichent que dans l'application pour l'instant.
- **Routes** (connexion requise) : `GET /api/garage/:id/avenir`, `POST /api/garage/:id/rappels`, `DELETE /api/garage/:id/rappels/:rid`.

## Valeur indicative

Depuis la carte d'une voiture, « Estimer la valeur » demande à l'IA une fourchette de prix de vente entre particuliers.

- **Ce qui est envoyé à l'IA** :
  - la voiture : marque, modèle, motorisation, boîte, année ou date de mise en circulation ;
  - le kilométrage : dernier relevé et moyenne par mois ;
  - un résumé du carnet : nombre d'entretiens, nombre de factures, et pour chaque entretien important son type, sa date, son kilométrage et si sa facture est présente.

  Aucune donnée personnelle ne part : ni e-mail, ni surnom, ni nom du garage, ni description libre des entretiens. Aucune donnée n'est récupérée sur des sites d'annonces : l'IA s'appuie sur ses connaissances générales.
- **Réponse** : JSON imposé par un schéma (basse, haute, valeur probable, explication, facteurs en plus et en moins, conseils), puis revalidé par le serveur (fourchette cohérente, montants plausibles). Si la réponse est invalide, un message clair s'affiche et rien n'est enregistré.
- **Coûts** : une estimation au maximum par voiture et par jour. Au-delà, la dernière estimation est réaffichée, avec sa date, sans appeler l'IA. Deux clics simultanés ne déclenchent qu'un seul appel. Une estimation qui échoue n'est pas comptée.
- **Historique** : chaque estimation est enregistrée avec sa date et le kilométrage du moment. Dès deux estimations, une courbe montre l'évolution de la valeur probable et de la fourchette.
- **Modèle** : le même que l'assistant (variable `MODEL`). Si le modèle décline la demande, l'API la relance sur un autre modèle (repli côté serveur). Sans clé API, l'estimation est désactivée avec un message clair.
- **RGPD** : les estimations sont dans l'export, et effacées avec la voiture ou le compte.
- **Routes** (connexion requise) : `GET /api/garage/:id/valeur` (historique) et `POST /api/garage/:id/valeur` (nouvelle estimation).

## Où modifier quoi

- Le comportement de l'IA (ton, structure des réponses, règles de sécurité) : les textes `rules` et `SAFETY` dans `public/index.html`.
- Les symptômes proposés en pastilles dans « J'ai une panne » : la constante `HELP` dans `public/index.html`. Chaque catégorie est une liste de textes ; ajoutez un `*` à la fin d'un texte pour le marquer comme dangereux (il affiche alors l'encadré rouge « arrêtez-vous dès que possible »).
- La fiche rapide du mode « Diagnostic pro » : le formulaire `proForm` (HTML) et le message qu'il construit (partie « fiche rapide pro » du script).
- L'analyse d'achat : la variable `prompt` dans la partie « achat » de `public/index.html`.
- Les fiches de la base de connaissances : `data/vehicules.json` et `data/obd.json` (mode d'emploi dans `data/README.md`).
- La consigne donnée à l'IA sur l'usage des fiches : la constante `KB_RULES` dans `server.js`.
- La recherche (scores, taille maximale du contexte `MAX_CONTEXT`) : `knowledge.js`. Lancez `npm test` après toute modification.
- Les comptes (longueur minimale du mot de passe, durée de session, blocage après échecs) : les constantes en haut de `auth.js`. Lancez `npm test` après toute modification.
- Le garage (nombre maximal de voitures, champs, règle de rattachement à une fiche `matchFiche`) : `garage.js`. Les relevés (écart minimal pour la moyenne, nombre maximal, contrôles) : `kilometrage.js`. Le carnet (types d'entretien, limites) : `carnet.js`. Les règles « À venir » (seuils « bientôt », vidange par défaut, contrôle technique, pneus hiver) : `avenir.js`. La consigne envoyée à l'IA pour la valeur, son schéma JSON et les contrôles de la réponse : `valeur.js`. Les types de fichiers acceptés et la taille maximale : `storage.js`. Lancez `npm test` après toute modification.
- L'apparence (couleurs claires et sombres, tailles de texte, espacements, arrondis) : les variables en haut du `<style>` de `public/index.html`, documentées dans [DESIGN.md](DESIGN.md). Tout nouvel écran suit ce système.
