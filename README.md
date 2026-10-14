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
├── db.js               ← la base SQLite (comptes, garages)
├── storage/            ← le fichier de la base des comptes (créé au démarrage, jamais publié)
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
- Les voitures et leurs relevés sont inclus dans l'export des données et effacés avec le compte.
- **Kilométrage** : chaque voiture a ses relevés (date et kilométrage). Le « Kilométrage actuel » saisi à l'ajout devient le premier relevé. Un relevé à la même date remplace le précédent. Un relevé incohérent est refusé : un compteur ne recule pas. La **moyenne de km par mois** est calculée entre le premier et le dernier relevé, s'ils sont espacés d'au moins 30 jours. Le dernier kilométrage est ajouté à la désignation envoyée à l'assistant.
- Routes (connexion requise) : `GET /api/garage`, `POST /api/garage`, `PUT /api/garage/:id`, `DELETE /api/garage/:id`, et pour les relevés `GET` et `POST /api/garage/:id/releves`, `DELETE /api/garage/:id/releves/:rid`.

## Où modifier quoi

- Le comportement de l'IA (ton, structure des réponses, règles de sécurité) : les textes `rules` et `SAFETY` dans `public/index.html`.
- Les symptômes proposés en pastilles dans « J'ai une panne » : la constante `HELP` dans `public/index.html`. Chaque catégorie est une liste de textes ; ajoutez un `*` à la fin d'un texte pour le marquer comme dangereux (il affiche alors l'encadré rouge « arrêtez-vous dès que possible »).
- La fiche rapide du mode « Diagnostic pro » : le formulaire `proForm` (HTML) et le message qu'il construit (partie « fiche rapide pro » du script).
- L'analyse d'achat : la variable `prompt` dans la partie « achat » de `public/index.html`.
- Les fiches de la base de connaissances : `data/vehicules.json` et `data/obd.json` (mode d'emploi dans `data/README.md`).
- La consigne donnée à l'IA sur l'usage des fiches : la constante `KB_RULES` dans `server.js`.
- La recherche (scores, taille maximale du contexte `MAX_CONTEXT`) : `knowledge.js`. Lancez `npm test` après toute modification.
- Les comptes (longueur minimale du mot de passe, durée de session, blocage après échecs) : les constantes en haut de `auth.js`. Lancez `npm test` après toute modification.
- Le garage (nombre maximal de voitures, champs, règle de rattachement à une fiche `matchFiche`) : `garage.js`. Les relevés (écart minimal pour la moyenne, nombre maximal, contrôles) : `kilometrage.js`. Lancez `npm test` après toute modification.
- L'apparence (couleurs claires et sombres, tailles de texte, espacements, arrondis) : les variables en haut du `<style>` de `public/index.html`, documentées dans [DESIGN.md](DESIGN.md). Tout nouvel écran suit ce système.
