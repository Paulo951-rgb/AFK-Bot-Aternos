# AFK-Bot-Aternos
# Minecraft AFK Bot — Aternos + Render

Bot AFK Minecraft développé avec Mineflayer pour maintenir un serveur Aternos actif 24h/24.

Le projet est optimisé pour fonctionner avec :
- Aternos
- Render
- PaperMC
- Mineflayer
- Serveurs SMP entre amis

---

# 📌 Objectif du projet

Le but principal du bot est de :

- empêcher Aternos d’éteindre automatiquement le serveur
- maintenir un joueur connecté en permanence
- effectuer des mouvements anti-AFK
- reconnecter automatiquement le bot après une déconnexion
- fonctionner de manière stable sur Render

Le bot agit comme un faux joueur connecté au serveur Minecraft.

---

# ⚠️ Contexte du projet

Aternos coupe automatiquement un serveur lorsqu’aucun joueur n’est connecté pendant plusieurs minutes.

Le problème :
- un simple bot AFK classique finit souvent par être kick
- Render redémarre parfois les services automatiquement
- Mineflayer peut avoir des problèmes de version Minecraft
- PaperMC peut bloquer certains comportements de bot
- certaines reconnexions créent plusieurs instances du bot

Ce projet a donc été entièrement réécrit pour :
- éviter les doubles connexions
- éviter les boucles de reconnexion infinies
- gérer correctement les timeouts
- être compatible avec Render
- être plus stable avec Aternos

---

# 🧠 Fonctionnement global

Le système fonctionne en plusieurs étapes :

1. Le serveur Express démarre
2. Render détecte le port HTTP
3. Le bot attend avant de se connecter
4. Mineflayer crée le client Minecraft
5. Le bot rejoint le serveur
6. L’anti-AFK démarre
7. En cas de crash ou déconnexion :
   - nettoyage du bot
   - reconnexion automatique

---

# 📁 Structure du projet

```text
minecraft-afk-bot/
│
├── index.js
├── settings.json
├── package.json
├── .gitignore
└── README.md
```

---

# 📄 Description des fichiers

## index.js

Fichier principal du projet.

Contient :
- le serveur Express
- le système de connexion Minecraft
- l’anti AFK
- la reconnexion automatique
- la gestion des erreurs
- la protection contre les doubles bots

---

## settings.json

Contient toute la configuration :

- IP du serveur
- port
- version Minecraft
- nom du bot
- système d’authentification
- paramètres anti-AFK
- délais de reconnexion

Exemple :

```json
{
  "server": {
    "ip": "example.aternos.me",
    "port": 25565,
    "version": "1.21.1"
  },

  "bot": {
    "username": "AFKBot",
    "auth": "offline"
  }
}
```

---

## package.json

Contient :
- les dépendances Node.js
- les scripts de lancement
- les informations du projet

---

# ⚙️ Dépendances utilisées

## Mineflayer

Librairie principale utilisée pour créer le bot Minecraft.

Permet :
- rejoindre un serveur
- envoyer des commandes
- détecter les événements
- bouger
- interagir avec le monde

Documentation :
https://github.com/PrismarineJS/mineflayer

---

## Express

Utilisé pour créer un serveur HTTP.

Render exige un port HTTP actif pour considérer le service comme vivant.

Le serveur Express sert donc uniquement à :
- garder Render actif
- fournir un endpoint de health check

---

# 🔄 Système de reconnexion

Le bot possède un système de reconnexion sécurisé.

Fonctionnement :
- évite plusieurs connexions simultanées
- nettoie les anciennes instances
- empêche les doubles bots
- évite les reconnexions infinies trop rapides

Causes possibles de reconnexion :
- timeout
- crash
- kick
- fermeture de connexion
- serveur redémarré

---

# ⏱️ Gestion des timeouts

Aternos peut être lent au démarrage.

Le bot :
- attend avant de se connecter
- possède un timeout de spawn
- attend plusieurs secondes avant une reconnexion

Cela évite :
- spam de connexion
- surcharge du serveur
- détection anti-bot

---

# 🎮 Anti AFK

Le bot effectue périodiquement :
- des sauts
- des mouvements
- des déplacements latéraux

Objectif :
- éviter les kicks AFK
- simuler un vrai joueur

Les mouvements sont simples volontairement afin de :
- réduire les bugs
- éviter les problèmes de pathfinding
- limiter la consommation CPU/RAM

---

# 🌐 Compatibilité Aternos

Le projet est spécifiquement optimisé pour Aternos.

Points importants :
- attendre le démarrage complet du serveur
- éviter les reconnexions trop rapides
- utiliser la bonne version Minecraft
- éviter les doubles bots

---

# 🌐 Compatibilité Render

Le projet est optimisé pour fonctionner sur Render Free.

Configuration importante :

## Build Command

```bash
npm install
```

## Start Command

```bash
node index.js
```

## Health Check Path

```text
/
```

## Auto Deploy

Désactivé recommandé.

Sinon :
- Render redéploie automatiquement
- le bot redémarre
- le serveur Aternos peut s’éteindre

---

# ⚠️ Problèmes rencontrés pendant le développement

## 1. Spawn timeout

Le bot se connectait mais ne recevait jamais le packet de spawn.

Causes possibles :
- mauvaise version Minecraft
- PaperMC
- auth incorrecte
- plugins anti-bot

---

## 2. Double instance du bot

Le fichier index.js avait été dupliqué accidentellement.

Résultat :
- plusieurs bots
- reconnexions multiples
- conflits réseau

---

## 3. Render redéployait le projet en boucle

Cause :
- auto deploy
- mauvais health check

Résultat :
- coupure des connexions Minecraft
- ECONNRESET
- spawn timeout

---

## 4. Versions Minecraft incompatibles

Mineflayer est très sensible :
- à la version exacte
- au protocole Paper
- aux versions Mineflayer

---

# 🔒 Limitations

Le projet ne peut pas empêcher :

- Aternos de bloquer certaines IP
- les plugins anti-bot
- les limitations Render Free
- les protections PaperMC
- les problèmes réseau externes

---

# 📌 Recommandations

Pour une stabilité maximale :

- serveur cracké ON
- auth offline
- version exacte Minecraft
- Auto Deploy OFF
- attendre qu’Aternos soit totalement lancé avant Render

---

# 🚀 Lancement local

Installation :

```bash
npm install
```

Démarrage :

```bash
node index.js
```

---

# 📜 Licence

Projet personnel et éducatif.

Utilisation libre pour projets privés.
