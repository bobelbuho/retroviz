# Feuille de route Rétroviz

## Phase 1 : comptes et garage (en cours)

- Comptes utilisateurs (e-mail + mot de passe), conformes au RGPD : export et suppression des données.
- Garage virtuel : mes voitures, reliées si possible à une fiche de la base Rétroviz.
- Relevés de kilométrage et moyenne de km par mois.
- Carnet d'entretien, avec photo ou PDF de facture.
- Rappels : contrôle technique, assurance, vidange, pneus hiver.
- Prochains entretiens calculés à partir de la fiche et du carnet.
- Valeur indicative estimée par l'IA, avec son évolution dans le temps.
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
