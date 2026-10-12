# Rétroviz

> Regardez dans le rétro, roulez l'esprit tranquille.

Assistant automobile avec trois modes : **J'ai une panne** (particuliers), **Diagnostic pro** (mécaniciens) et **J'achète une voiture** (analyse d'une occasion : qualités, défauts, pannes à venir selon le kilométrage).

## Structure

```
retroviz/
├── public/index.html   ← l'interface (HTML, CSS, JavaScript)
├── server.js           ← le serveur qui appelle l'API Claude
├── package.json        ← les dépendances
├── .env.example        ← modèle du fichier de configuration
└── README.md
```

## Installation

1. Installez **Node.js** (version LTS) depuis https://nodejs.org
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
- Les réponses viennent des connaissances générales du modèle d'IA : elles peuvent être incomplètes ou inexactes.

## Où modifier quoi

- Le comportement de l'IA (ton, structure des réponses, règles de sécurité) : les textes `rules` et `SAFETY` dans `public/index.html`.
- L'analyse d'achat : la variable `prompt` dans la partie « achat » de `public/index.html`.
- Les couleurs : les variables `--bg`, `--ink`, `--accent`… en haut du `<style>`.
