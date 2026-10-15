# Rétroviz

> Regardez dans le rétro, roulez l'esprit tranquille.

Assistant automobile avec trois modes : **J'ai une panne** (particuliers), **Diagnostic pro** (mécaniciens) et **J'achète une voiture** (analyse d'une occasion : qualités, défauts, pannes à venir selon le kilométrage). Avec un compte, **Mon garage** garde vos voitures.

## Structure

```
retroviz/
├── public/index.html   ← l'interface (HTML, CSS, JavaScript)
├── public/glossaire.js ← soulignement des termes du glossaire et fenêtre de définition
├── public/schema-dessin.js ← dessins SVG du schéma (vue d'ensemble et 8 zones)
├── public/avis.html    ← « Comment fonctionnent les avis » (informations exigées par le Code de la consommation)
├── public/dossier.html ← page publique d'un dossier partagé (lecture seule, non indexée)
├── public/dossier-rendu.js ← rendu du dossier, commun à la page publique et à l'aperçu
├── server.js           ← le serveur : assemble les modules et sert l'interface
├── chat.js             ← l'assistant (/api/chat) : relaie les questions à l'API Claude
├── prompts.js          ← les consignes de l'IA et la voix de Rétroviz (côté serveur)
├── knowledge.js        ← la recherche dans la base de connaissances
├── auth.js             ← les comptes (inscription, connexion, export, suppression)
├── garage.js           ← « Mon garage » : les voitures de chaque compte
├── kilometrage.js      ← relevés de kilométrage : validation, cohérence, moyenne par mois
├── carnet.js           ← carnet d'entretien et factures
├── avenir.js           ← calcul de « À venir » : rappels et prochains entretiens (sans base de données)
├── rappels.js          ← routes « À venir » et rappels libres
├── valeur.js           ← valeur indicative estimée par l'IA, historique
├── vie.js              ← page de vie d'une voiture : frise, étapes marquantes, chiffres clés
├── badge.js            ← badge « Voiture bien suivie » : critères et seuils
├── energie.js          ← énergie d'une voiture (thermique, hybride, électrique)
├── transfert.js        ← dossier partageable, transfert au nouveau propriétaire, notes sur l'historique reçu
├── marques.js          ← stockage par marque (data/marques/) et vue « à plat » des motorisations
├── catalogue.js        ← « Marques et modèles » : lecture publique des marques et modèles
├── schema.js           ← schéma interactif : pièces de la voiture reliées à sa fiche, « À venir » et son carnet
├── avis.js             ← avis de propriétaires : conditions, filtre, synthèse, signalements, modération
├── historique.js       ← confiance de l'historique : « saisi le », « modifié le », continuité du kilométrage
├── metadonnees.js      ← retire les métadonnées (GPS…) des images avant de les montrer
├── relecture.js        ← page « Relecture » (administrateurs) : corriger et valider les fiches
├── fiabilite.js        ← règles de fiabilité des fiches, partagées par les tests et la Relecture
├── propositions.js     ← propositions d'amélioration de la base (Observateur, signalements)
├── retours.js          ← retours sous les réponses, questions sans fiche, statistiques anonymes
├── storage.js          ← stockage des fichiers (factures) : enregistrer, lire, supprimer
├── db.js               ← la base SQLite (comptes, garages)
├── observateur/        ← l'Observateur : recherche, extraction, recoupement, propositions
├── scripts/observer.js ← lancement de l'Observateur (npm run observer)
├── storage/            ← la base (retroviz.db) et les factures (uploads/), créés au démarrage, jamais publiés
├── data/               ← la base de connaissances (fiches JSON + mode d'emploi)
│   ├── obd.json
│   ├── marques/        ← un fichier par marque : modèles, générations, motorisations
│   ├── voyants.json
│   ├── glossaire.json  ← 96 termes définis simplement, soulignés dans les réponses et les fiches
│   ├── prix.json       ← guide des prix : 42 interventions, garage indépendant et concession
│   ├── pieces.json     ← pièces du schéma (rôle, usure, durée de vie, prix, voyants, mots du glossaire)
│   ├── sources.json    ← registre des sources de l'Observateur
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
- `data/marques/` : un fichier par marque (13 marques, les 30 modèles d'occasion les plus courants, 121 motorisations) ; pour chaque motorisation, pannes connues avec leur kilométrage, entretiens, points forts et faibles, conseil d'achat. Voir `data/README.md`.
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

## Page de vie d'une voiture

« Voir sa page » (ou un clic sur le nom de la voiture) ouvre sa page principale, avec quatre onglets : **Sa vie**, **Carnet**, **À venir** et **Valeur**.

- **Photo** facultative : JPEG, PNG ou WebP, 10 Mo au plus, vrai type vérifié d'après le contenu, nom aléatoire, visible par le seul propriétaire. Elle passe par `storage.js` comme les factures, et elle est effacée avec la voiture ou le compte.
- **Frise** : ajout au garage ou achat, relevés, entretiens et factures (« avec facture » ou « déclaré »), estimations de valeur. Les changements de propriétaire et les avis s'y ajouteront.
- **Étapes marquantes** : paliers de kilométrage franchis avec vous (50 000, 100 000 km…), anniversaires (« 1 an avec vous »).
- **Chiffres clés**, depuis l'achat (date et kilométrage d'achat facultatifs, sinon depuis l'ajout au garage) : km parcourus, total dépensé en entretien, coût d'entretien par km et par mois.
- Routes : `GET /api/garage/:id/vie` ; photo : `PUT`, `GET` et `DELETE /api/garage/:id/photo`.

## Badge « Voiture bien suivie »

Affiché en tête de « Sa vie », et en pastille sur la carte de la voiture. Il repose sur les informations saisies par le propriétaire, et l'écran le dit toujours. Les 5 critères sont listés, cochés ou non, avec ce qu'il faut faire pour chaque critère manquant (« plus que 2 critères »).

1. **Historique** : au moins 12 mois depuis la plus ancienne date connue (achat, premier relevé ou premier entretien, y compris l'historique reçu d'un ancien propriétaire).
2. **Relevés réguliers** : au moins 3 relevés sur les 12 derniers mois, jamais plus de 6 mois sans relevé, jusqu'à aujourd'hui. Les kilométrages des entretiens comptent.
3. **Vidanges à temps** (thermiques et hybrides) : au moins une vidange notée, et un écart entre les 2 dernières vidanges qui ne dépasse pas l'intervalle prévu de plus de 10 % (en km et en mois). Pour une **voiture électrique**, ce critère est remplacé par « entretiens de la fiche faits à temps ».
4. **Rien en retard** dans « À venir » : contrôle technique, vidange, entretiens de la fiche. Les rappels libres ne comptent pas.
5. **Preuves** : au moins 2 entretiens, et un score de preuve d'au moins 75 % (entretien avec facture = 1 point, sans facture = 0,5).

Si la voiture perd le badge, l'écran indique la date, les critères en cause et comment le récupérer. L'énergie de la voiture (champ « Énergie », sinon déduite de la motorisation) décide du critère vidange ; une voiture électrique n'a pas non plus de vidange dans « À venir ». Route : `GET /api/garage/:id/badge`. Seuils : `SEUILS` dans `badge.js`.

## Partager ou vendre : le carnet suit la voiture

Onglet « Partager ou vendre » de la page d'une voiture. **Tout ce qui peut identifier le propriétaire est décoché par défaut** : noms de garage, descriptions (entretien par entretien), factures (une par une), photo, estimations de valeur (partage seulement).

- **Lien de partage** (`/dossier.html#jeton`) : lecture seule, 1, 7 ou 30 jours, révocable, plusieurs liens possibles. « Voir l'aperçu » montre exactement ce que verra le visiteur (même code de rendu). Le jeton n'est jamais stocké, seulement son empreinte. Pages et réponses marquées `noindex` et `no-referrer`.
- **Masquage des factures** : le navigateur dessine la facture dans un canvas, l'utilisateur trace des rectangles, peints en noir dans les pixels ; l'image obtenue est envoyée comme **copie masquée** (`PUT …/facture-masquee`). L'original ne change pas. Un PDF est converti en image par pdf.js (`/vendor/pdfjs`, servi depuis `node_modules`, 4 pages au plus) ; s'il ne peut pas l'être, ou pour une photo HEIC, un avertissement le dit. Une facture montrée ou transmise est la copie masquée si elle existe, sinon l'original **sans ses métadonnées** (`metadonnees.js` : Exif, XMP, IPTC, textes PNG).
- **Transfert** : le vendeur crée un code (8 caractères sans I, O, 0, 1, valable 7 jours, un seul à la fois, annulable). L'acheteur connecté le saisit (« J'ai un code de transfert »), voit un résumé, accepte. La voiture change de compte : surnom, assurance, pneus hiver, rappels libres, estimations, liens de partage, photo et factures non cochées sont effacés ; descriptions et garages non cochés sont vidés ; les noms de fichiers d'origine sont remplacés (`facture-AAAA-MM-JJ.jpg`). L'achat de l'acheteur est daté du transfert, au dernier kilométrage connu. La frise affiche « Changement de propriétaire » et « Achat par un propriétaire précédent », sans identité. **10 codes faux par compte et par heure** (et 30 par adresse IP), puis refus pendant une heure.
- **Historique verrouillé** : relevés, entretiens, factures et notes reçus ne peuvent être ni modifiés ni supprimés (403). L'acheteur peut ajouter une **note** sur une entrée reçue (500 caractères), visible dans la frise, le carnet et le dossier, et transmise aux propriétaires suivants.
- **Confiance** : chaque entrée affiche « avec facture » ou « déclaré » ; « saisi le … » si elle a été ajoutée plus de 30 jours après sa date ; « modifié le … » si elle a été modifiée alors que sa date et sa saisie avaient plus de 30 jours (table `modifications` : anciennes et nouvelles valeurs pour date, km, type, coût ; pour la description et le garage, seulement le fait qu'ils ont changé, jamais l'ancien texte ; suppressions comptées). Le dossier résume : « 3 entretiens saisis après coup, dont 2 avec facture », et met en avant le **kilométrage suivi sans interruption** (jamais plus de 6 mois sans kilométrage connu), y compris d'un propriétaire à l'autre.
- **RGPD** : l'export de l'acheteur contient l'historique reçu et les dates de changement de propriétaire ; supprimer le compte du vendeur ne touche pas une voiture déjà transférée.

## Guides : marques et modèles, comparateur, prix, glossaire

Lien « Guides » du menu, quatre onglets.

- **Comparer** : 2 ou 3 modèles côte à côte (générations, pour qui, qualités, défauts, motorisations à privilégier ou à éviter, pannes graves connues, coût d'entretien de la marque, avis, points à vérifier). Sur mobile, le tableau défile dans son cadre.
- **Guide des prix** (`data/prix.json`) : 42 interventions courantes, fourchettes TTC pièces et main-d'œuvre en garage indépendant et en concession, avec ce qui est compris et la fréquence. Un test vérifie que la concession n'est jamais moins chère.
- **Glossaire** (`data/glossaire.json`) : 96 termes. Dans les réponses de l'assistant (une fois la réponse terminée), le rapport d'achat, les fiches de modèles, de pièces, de voyants, les prix et le comparateur, la première occurrence de chaque terme est soulignée en pointillés ; un clic ou Entrée affiche la définition (Échap pour fermer) et mène au glossaire complet. Les liens, boutons et titres ne sont pas soulignés. Les mots cités par les pièces et les prix doivent exister dans le glossaire (test).
- Glossaire et prix suivent les règles de fiabilité et se corrigent dans la Relecture (collections « Glossaire » et « Prix »).

### Marques et modèles
 Les 30 modèles d'occasion les plus courants en France (13 marques), avec recherche (y compris « golf 7 », « clio 4 »). Pour chaque modèle : qualités, défauts, pour qui, points à vérifier à l'achat, puis chaque génération et ses motorisations (conseil « à privilégier », « correct » ou « à éviter », points forts et faibles, pannes connues, entretiens), les avis des propriétaires et la marque (image, coût d'entretien relatif, réseau et pièces en France). Deux boutons : « Analyser une occasion de ce modèle » (« J'achète une voiture » pré-rempli) et « Ajouter à mon garage » (formulaire pré-rempli). Toutes ces fiches sont rédigées de mémoire et « à vérifier ». Routes : `GET /api/marques`, `GET /api/modeles/:id`.

## Schéma interactif

Onglet « Schéma » de la page d'une voiture. Une vue de profil dessinée en SVG avec 8 zones (moteur, transmission, freins, direction et suspension, électricité, échappement et dépollution, pneus, carrosserie) ; un clic ouvre le schéma détaillé de la zone, avec ses pièces numérotées.

- **Trois versions** selon l'énergie de la voiture (`energie.js`) : thermique, hybride (pièces thermiques et électriques), électrique (pas d'échappement, réducteur, batterie de traction, onduleur…).
- **`data/pieces.json`** (51 pièces, toutes « à vérifier ») : rôle, signes d'usure, durée de vie, prix indicatif (fourchette `prix_eur`), voyants liés, mots du glossaire, mots-clés et types de carnet servant aux liens. Les règles de fiabilité s'appliquent (collection `pieces` de la Relecture).
- **Pour votre voiture** (`schema.js`) : une pièce est mise en avant (repère orange, rouge si grave ou en retard) quand une panne connue de la fiche reliée la vise, ou qu'un entretien est proche ou en retard. Une panne ne vise que la pièce dont le mot-clé vient **en premier** dans son titre (son sujet) : « ratés d'allumage (versions turbo) » vise l'allumage, pas le turbo. Les entrées liées du carnet sont listées (type ou description).
- **« J'ai un souci ici »** ouvre « J'ai une panne » avec la voiture et la pièce pré-remplies ; les voyants liés ouvrent leur fiche.
- **Accessibilité** : zones et repères au clavier (Tab, Entrée, Échap pour revenir), liste des zones et liste de toutes les pièces en texte, équivalentes au dessin.
- Routes : `GET /api/pieces` (public), `GET /api/garage/:id/schema`.

## Avis de propriétaires

Onglet « Avis » de la page d'une voiture.

- **Qui publie** : la voiture doit être dans le garage depuis au moins **3 mois calendaires** (depuis le transfert pour une voiture reçue) avec au moins **2 relevés** faits par ce propriétaire (`CONDITIONS` dans `avis.js`). Un avis par voiture et par propriétaire, modifiable et supprimable. Après une vente, l'avis reste à son auteur (« Mon compte › Mes avis »).
- **Formulaire** : 5 notes de 1 à 5 (fiabilité, coût d'entretien, confort, consommation, rapport qualité-prix), « la recommanderiez-vous ? », pannes (pièce, km, coût), points forts, points faibles, commentaire court.
- **Filtre automatique** à la publication : e-mail, téléphone, lien, plaque (format AB-123-CD) et injures visant des personnes sont refusés, avec la raison. Un avis négatif sur la voiture passe toujours.
- **Affichage** : avis de la motorisation et de tout le modèle, du plus récent au plus ancien. À partir de **5 avis** (`SEUIL_SYNTHESE`), moyennes, part qui recommande et pannes citées par au moins 2 avis ; avant, avis un par un. Chaque avis montre la durée de possession, les km parcourus, le km au compteur, la date, la mention « Propriétaire vérifié par son garage Rétroviz », jamais l'identité. Publié au plus 5 ans après la dernière modification.
- **Modération** : « Signaler » (anonyme, motif obligatoire) ; file « Avis signalés » dans la Relecture ; masquer exige un motif de la liste `MOTIFS_MASQUAGE`, où « négatif » ne figure pas. L'auteur voit le motif ; s'il corrige son avis, il revient dans la file.
- **Observateur** : les pannes citées par au moins 2 avis du modèle deviennent des faits d'une source de type « proprietaires » (une seule source pour tous les avis, jamais suffisante seule pour confirmer).
- Routes : `GET/PUT/DELETE /api/garage/:id/avis`, `GET /api/avis?marque=&modele=&motorisation=&fiche=`, `POST /api/avis/:id/signaler`, `GET /api/avis/miens`, `GET/POST /api/admin/avis`.

## Mon garage

« Mon garage », en haut à droite (compte requis), enregistre les voitures de l'utilisateur : surnom, marque, modèle, motorisation, année, boîte. 30 voitures au plus par compte.

- **Fiche reliée** : à chaque enregistrement, le serveur cherche une fiche de motorisation dans `data/marques/` (l'année aide à choisir la génération). Il ne la relie que si le modèle **et** le moteur correspondent, et si l'année tombe dans la période de la fiche (une fiche fausse est pire que pas de fiche). L'utilisateur peut écarter une fiche (« Ce n'est pas ma voiture ») ou en chercher une à nouveau.
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

## Relecture et apprentissage depuis l'usage

- **Page « Relecture »** (comptes de `ADMIN_EMAILS` seulement), avec cinq onglets :
  - **Tableau de bord** : propositions et signalements en attente, dépense de l'Observateur, fiches par statut, retours des 30 derniers jours, voitures les plus demandées sans fiche.
  - **Fiches** : corriger, ajouter une source, passer en vérifiée (voir `data/README.md`).
  - **Propositions** : accepter, modifier puis accepter, ou rejeter avec un motif. Une proposition acceptée est écrite dans la fiche avec ses sources ; la fiche reste « à vérifier ».
  - **Signalements** : les erreurs signalées par les utilisateurs.
  - **Questions sans fiche** : la liste prioritaire de l'Observateur.
- **Sous chaque réponse** : « Cette réponse vous a aidé ? Oui / Non / Signaler une erreur ». C'est anonyme : aucun lien avec le compte. Le commentaire est nettoyé des adresses, numéros et plaques, et la question n'est jamais gardée.
- **Questions sans fiche** : quand la base n'a pas de fiche pour la question ou pour la voiture indiquée, seuls la voiture et les codes défaut sont notés.
- **Statistiques anonymes des carnets** : seulement pour les comptes qui l'ont accepté dans « Mon compte » (désactivé par défaut). Elles ne sont publiées qu'à partir de 10 véhicules, en fourchette arrondie au millier de km (`GET /api/stats/entretiens`).
- **Confidentialité** : la page `public/confidentialite.html`, en version provisoire, à faire relire par un professionnel.

## L'Observateur

`npm run observer -- --modele "Clio IV"` cherche, extrait et recoupe des informations sur un modèle, puis crée des propositions à valider dans la page « Relecture ». Il ne modifie jamais les fiches directement, sauf pour ajouter les rappels officiels. `npm run observer -- --aide` liste les options : `--pilote`, `--prioritaires`, `--hebdo`, `--simulation`, `--sans-web`, `--planifier`…

- **Registre des sources** (`data/sources.json`) : pour chaque site, son type (officiel, constructeur, presse, pro, forum), son poids, sa méthode (API ou recherche web), s'il est autorisé, et sa limite de requêtes par minute.
- **Respect des sites** :
  - `robots.txt` lu pour chaque site ;
  - un site qui refuse les robots d'IA est considéré comme refusant l'analyse automatisée ;
  - refus TDM (en-tête, balise, `/.well-known/tdmrep.json`) et balise `noai` respectés ;
  - pages derrière une connexion ou un abonnement écartées ;
  - limite de requêtes par site.
- **Données officielles** (gratuites, sans clé API), API vérifiées le 2026-10-14 :
  - RappelConso et Safety Gate (rapports hebdomadaires XML) : les rappels qui citent la génération sont ajoutés automatiquement à la fiche, avec la mention « source officielle » et le lien. Ceux qui citent le modèle sans sa génération deviennent des propositions, sauf si leurs dates de production l'excluent.
  - NHTSA (marché américain) : rappels proposés, en anglais, à vérifier. Seul le nombre de plaintes par organe est utilisé, jamais leur texte.
  - ADEME : les données ne couvrent que les voitures neuves actuelles.
- **Recherche web** (outil de recherche web de l'API Claude, limité aux sites autorisés du registre) : quatre questions par modèle et motorisation (pannes, kilométrages, coûts, avis de mécaniciens). Chaque page est ensuite lue par l'Observateur lui-même, qui vérifie d'abord tous les refus.
- **Extraction** : l'IA transforme chaque page en faits structurés (sujet, type, contenu reformulé, km, coût, URL, type de source). Les faits recopiés mot pour mot sont écartés, et les données personnelles retirées.
- **Recoupement** :
  - un fait est « confirmé » par au moins 3 sources indépendantes (un même site ne compte qu'une fois), dont une officielle, constructeur, presse ou pro ;
  - sinon il est « signalé », avec le nombre de sources ;
  - les kilométrages ou coûts très différents sont signalés comme contradictions.
- **Coûts** : budget mensuel `OBSERVER_BUDGET_EUR`. Chaque appel vérifie d'abord son coût maximal, et l'Observateur s'arrête quand le budget est atteint. Chaque passage est journalisé (sources consultées, pages écartées et pourquoi, faits, propositions, rappels, coût) et visible dans le tableau de bord de la Relecture.
- **Planification** : `npm run observer -- --planifier` explique comment lancer le passage hebdomadaire (`--hebdo`) avec le Planificateur de tâches Windows ou cron.

## Où modifier quoi

- La voix de Rétroviz, le comportement de l'IA (ton, structure des réponses, règles de sécurité) et la demande d'analyse d'achat : `prompts.js`. Ces consignes restent sur le serveur : la page n'envoie que le mode choisi, la conversation et la voiture.
- Les symptômes proposés en pastilles dans « J'ai une panne » : la constante `HELP` dans `public/index.html`. Chaque catégorie est une liste de textes ; ajoutez un `*` à la fin d'un texte pour le marquer comme dangereux (il affiche alors l'encadré rouge « arrêtez-vous dès que possible »).
- La fiche rapide du mode « Diagnostic pro » : le formulaire `proForm` (HTML) et le message qu'il construit (partie « fiche rapide pro » du script).
- L'analyse d'achat : la variable `prompt` dans la partie « achat » de `public/index.html`.
- Les fiches de la base de connaissances : `data/marques/`, `data/obd.json`, `data/voyants.json`, `data/pieces.json` (mode d'emploi dans `data/README.md`).
- La consigne donnée à l'IA sur l'usage des fiches : la constante `REGLES_BASE` dans `prompts.js`.
- La recherche (scores, taille maximale du contexte `MAX_CONTEXT`) : `knowledge.js`. Lancez `npm test` après toute modification.
- Les comptes (longueur minimale du mot de passe, durée de session, blocage après échecs) : les constantes en haut de `auth.js`. Lancez `npm test` après toute modification.
- Le garage (nombre maximal de voitures, champs, règle de rattachement à une fiche `matchFiche`) : `garage.js`. Les relevés (écart minimal pour la moyenne, nombre maximal, contrôles) : `kilometrage.js`. Le carnet (types d'entretien, limites) : `carnet.js`. Les règles « À venir » (seuils « bientôt », vidange par défaut, contrôle technique, pneus hiver) : `avenir.js`. La consigne envoyée à l'IA pour la valeur, son schéma JSON et les contrôles de la réponse : `valeur.js`. Les types de fichiers acceptés et la taille maximale : `storage.js`. Lancez `npm test` après toute modification.
- L'apparence (couleurs claires et sombres, tailles de texte, espacements, arrondis) : les variables en haut du `<style>` de `public/index.html`, documentées dans [DESIGN.md](DESIGN.md). Tout nouvel écran suit ce système.
