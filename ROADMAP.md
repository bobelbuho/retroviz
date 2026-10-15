# Feuille de route Rétroviz

## À faire avant toute mise en ligne (même pour quelques proches)

1. **Protéger l'assistant** :
   - compte obligatoire pour utiliser l'assistant ;
   - ✅ consignes de l'IA côté serveur (prompts.js) ;
   - quota de questions par jour et par compte ;
   - limite de dépense mensuelle dans la console Anthropic.
2. **Réinitialisation du mot de passe** par e-mail, avec un service d'envoi hébergé en Europe. Ce service servira aussi aux rappels et à la vérification de l'adresse.
3. **Hébergement en Europe avec HTTPS** (Scaleway ou OVH) : `NODE_ENV=production`, configuration du proxy, sauvegardes de la base et des factures.
4. **Essais réels avec la clé API** (en attente : pas encore de clé dans `.env`) :
   - l'assistant (les trois modes) et la valeur indicative ;
   - le pilote de l'Observateur avec recherche web et extraction sur Clio IV, 208 I et Golf 7 (`npm run observer -- --pilote`, avec `OBSERVER_BUDGET_EUR` défini), puis relecture d'un échantillon des propositions avant de lancer les 30 modèles.
5. **Courte notice pour les testeurs** : ce qui est stocké, version d'essai, fiches et estimations à vérifier, comment faire un retour.
6. **Fiches des voitures des testeurs** dans la base Rétroviz.
7. **Journal des erreurs et suivi du nombre d'appels à l'IA**, pour surveiller les coûts.

## Base de connaissances (en cours)

- ✅ Voyants du tableau de bord (fiches et icônes).
- ✅ L'Observateur : recherche, extraction, recoupement et propositions d'amélioration de la base, validées dans la page « Relecture ».
  - Pilote avec recherche web : voir « À faire avant toute mise en ligne », point 4.
- Marques et modèles : les 30 modèles d'occasion les plus courants en France.
- Comparateur, glossaire, guide des prix.

## Phase 1 : comptes et garage (en cours)

- ✅ Comptes utilisateurs (e-mail + mot de passe), conformes au RGPD : export et suppression des données.
- ✅ Garage virtuel : mes voitures, reliées si possible à une fiche de la base Rétroviz.
- ✅ Relevés de kilométrage et moyenne de km par mois.
  - Plus tard : option « compteur changé ou remis à zéro » (aujourd'hui, un relevé inférieur au précédent est refusé).
- ✅ Carnet d'entretien, avec photo ou PDF de facture.
  - Plus tard : stockage des factures compatible S3 hébergé en Europe (Scaleway ou OVH), en remplaçant `createLocalStorage` dans `storage.js`.
  - Au moment du passage à S3 : nettoyage périodique des factures orphelines (fichiers sans entretien, par exemple après un arrêt du serveur pendant une suppression).
- ✅ Rappels : contrôle technique, assurance, vidange, pneus hiver, rappels libres (écran « À venir », dans l'appli seulement).
- ✅ Prochains entretiens calculés à partir de la fiche et du carnet.
- ✅ Valeur indicative estimée par l'IA, avec son évolution dans le temps.
- Historique des conversations des trois modes.

## Phase 2 : l'IA voit ce que vous voyez

- Photo d'un voyant : l'IA identifie le voyant et dit quoi faire.
- Analyse d'un devis de garage par photo : explication des lignes, prix suspects, questions à poser.
- Rappels par e-mail ou par notification.

## Phase 3 : application mobile et boîtier OBD-II

- Application mobile (React Native ou Flutter).
- Boîtier OBD-II Bluetooth :
  - lecture et explication des codes défaut ;
  - données moteur en direct : régime, température, charge, tension batterie, richesse ;
  - enregistrement dans le temps et alertes sur les tendances (batterie qui faiblit, température en hausse…).
- Limites à garder en tête :
  - l'OBD-II standard lit surtout le moteur et la dépollution, pas tous les voyants, ni toujours le kilométrage ;
  - aucune manipulation de l'écran pendant la conduite.

## Phase 4 : données payantes

- Recherche par plaque d'immatriculation (fournisseur SIV).
- Cotes du marché sous licence.
- Voitures connectées via des services d'agrégation constructeur.

## Idées par public

### Achat et revente
- Dossier de vente PDF avec l'historique d'entretien.
- Aide à la lecture d'un rapport HistoVec.
- Comparateur de 2 ou 3 annonces.

### Professionnels
- Fiches clients et véhicules.
- Rapport de diagnostic PDF.
- Gestion de flotte.

## Transversal

- Hébergement en Europe.
- Conformité RGPD.
- Politique de confidentialité et conditions d'utilisation rédigées avec un professionnel avant tout lancement public.

## À faire avant le lancement public

- Vérification de l'adresse e-mail à l'inscription (lien de confirmation).
- Rappels par e-mail (contrôle technique, vidange, assurance…), une fois l'adresse vérifiée.
- **Relecture juridique des avis et du dossier partagé** : la page « Comment fonctionnent les avis » (articles L111-7-2 et D111-16 à D111-19 du Code de la consommation), la mention « Possède cette voiture dans son garage Rétroviz depuis X mois » (remplace « Propriétaire vérifié », jugée trompeuse faute de contrôle de la carte grise, article L121-4), la procédure de signalement et de motivation (règlement européen sur les services numériques, articles 16 et 17), les obligations d'hébergeur (LCEN) et la durée de publication de 5 ans.
- Masquage des factures au clavier (aujourd'hui à la souris ou au doigt seulement).
- Ne plus révéler si une adresse est déjà inscrite : l'inscription affiche le même message dans tous les cas, et un e-mail prévient le titulaire de l'adresse.

## Idées en réserve

- **Indice de santé de la voiture** : une note synthétique, à partir du carnet, des relevés, de « À venir » et des pannes connues du modèle.
- **Dictée vocale** pour décrire une panne sans taper.
- **Photos analysées par l'IA** : un voyant, un devis de garage, l'usure d'un pneu, une fuite sous la voiture.
- **Mode rendez-vous au garage** : ce qu'il faut dire, les questions à poser, le devis à demander, l'historique à montrer.
- **Mode départ en vacances** : vérifications avant un long trajet, adaptées à la voiture et à la saison.
- **Alertes de saison** : pneus hiver, batterie au premier froid, climatisation avant l'été.
- **Tutoriels illustrés des gestes simples** : niveaux, pression des pneus, ampoule, balais d'essuie-glace.
- **QR code pour les garages partenaires** : le client partage son carnet en un geste.
- **Modèle économique** :
  - freemium (l'essentiel gratuit, des fonctions avancées payantes) ;
  - abonnement pour les professionnels ;
  - partenariats transparents, toujours signalés comme tels et sans influence sur les conseils ;
  - offre pour les flottes.
