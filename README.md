<p align="center">
  <img src="assets/icon.png" width="96" alt="">
</p>

<h1 align="center">Platine</h1>

<p align="center">
  Toutes tes plateformes de musique dans une seule appli Windows, stable et en qualité maximale.<br>
  Tidal · Spotify · Deezer · Qobuz · Apple Music · Amazon Music · YouTube Music · SoundCloud
</p>

<p align="center">
  <a href="https://github.com/BlancheLaGoat/platine/releases/latest"><b>⬇ Télécharger la dernière version</b></a>
</p>

<p align="center">
  <img src="docs/choix.png" width="720" alt="Écran de choix de la plateforme">
</p>

## Pourquoi Platine ?

Les applis desktop officielles plantent, rament ou ne gardent pas la qualité max. Platine fait tourner le **lecteur web officiel** de chaque plateforme dans une appli dédiée, avec le module DRM Widevine : tu gardes ton compte, ta bibliothèque, tes playlists et la qualité **High / Max**. Tout reste synchronisé avec ton téléphone.

## Fonctionnalités

- **Toutes tes plateformes** : choisis-en une au premier lancement, change quand tu veux (`Ctrl + Maj + P`). Une session par plateforme, donc tu restes connecté partout.
- **Ne plante plus** : si une page crashe, fige ou que la carte graphique lâche, Platine la relance tout seul, là où tu étais.
- **Mini-lecteur** (`Ctrl + Maj + M`) : petite fenêtre toujours au premier plan, avec pochette, avance dans le morceau et volume.

  <img src="docs/mini.png" width="380" alt="Mini-lecteur">

- **Overlay OBS** : une carte « en écoute » pour ton stream, qui se cache toute seule quand la musique est en pause.

  <img src="docs/overlay.png" width="520" alt="Overlay OBS">

- **Discord** : affiche « Écoute… » sur ton profil, avec la pochette et le temps restant, quelle que soit la plateforme.
- **Touches multimédia** du clavier et contrôles de Windows.
- **Mises à jour automatiques** depuis les Releases GitHub.
- **Lancement au démarrage de Windows**, réduit dans la zone de notification.
- Fermer la fenêtre ne coupe pas la musique : Platine reste près de l'horloge.

Tout se règle par **clic droit sur l'icône Platine** près de l'horloge.

## Installation

1. Télécharge `Platine-Setup-x.y.z.exe` depuis les [Releases](https://github.com/BlancheLaGoat/platine/releases/latest).
2. Lance-le. Si Windows affiche **« Windows a protégé votre ordinateur »**, clique sur **Informations complémentaires** puis **Exécuter quand même**. Ce message apparaît pour toute appli sans certificat Microsoft payant ; le code de Platine est entièrement lisible dans ce repo.
3. Choisis ta plateforme et connecte-toi.

## Overlay OBS

1. Clic droit sur l'icône Platine → **Overlay OBS → Activé**, puis **Copier le lien pour OBS**.
2. Dans OBS : **Sources → + → Navigateur**, colle le lien (`http://127.0.0.1:4848/overlay`), largeur `620`, hauteur `150`.

Options à ajouter à la fin du lien :

| Option | Effet |
| --- | --- |
| `?style=carte` | autre présentation : nom de la plateforme en haut, fine barre en bas |
| `?pause=show` | reste affiché quand la musique est en pause |
| `?compact=1` | version plus petite, sans pochette |
| `?align=right` | colle la carte à droite |
| `?accent=00e5ff` | force une couleur (sinon celle de la plateforme) |

Les options se combinent : `…/overlay?accent=00e5ff&pause=show`. L'état brut est aussi disponible en JSON sur `http://127.0.0.1:4848/now`. Le serveur n'écoute que sur ton PC, rien n'est accessible depuis le réseau.

## Questions fréquentes

**La connexion Google est refusée.** Google bloque volontairement sa connexion dans les applis qui embarquent un navigateur. Connecte-toi par e-mail + mot de passe (crée un mot de passe avec « Mot de passe oublié » si besoin). Pour YouTube Music, ça peut rester bloqué.

**Pourquoi plusieurs « Platine » dans le Gestionnaire des tâches ?** Platine est construit sur Chrome, qui sépare l'interface, l'audio, le réseau, le DRM et chaque page dans des processus différents. C'est ce qui lui permet de relancer une page plantée sans tout fermer. Environ 500 Mo de mémoire, c'est normal.

**Une plateforme ne lit rien ou affiche une erreur de lecture.** Recharge (clic droit sur l'icône → Recharger). Si ça continue, ouvre le journal des crashs depuis le même menu et ouvre une *issue* avec son contenu.

---

## Pour les développeurs

```
npm install
python -m castlabs_evs.vmp sign-pkg node_modules/electron/dist
npm start
```

- `npm run dist` construit l'installeur dans `dist/`, signé automatiquement par Castlabs (compte EVS gratuit : `pip install castlabs-evs` puis `python -m castlabs_evs.account signup`).
- **Ajouter une plateforme** : une entrée dans `src/platforms.js` (nom, couleurs, URL du lecteur web, domaines).
- **Discord** : mets l'*Application ID* de ton appli Discord dans `src/config.js`.
- **Publier une version** : change `"version"` dans `package.json`, commit, push, puis tag `vX.Y.Z`. Le workflow GitHub Actions (secrets `EVS_ACCOUNT` / `EVS_PASSWD`) construit, signe et publie la Release ; les Platine installés se mettent à jour tout seuls.
- **Mettre à jour Chrome** : change la version Castlabs aux deux endroits de `package.json` (`devDependencies.electron` et `build.electronDownload.version`).

Construit avec [Electron for Content Security (Castlabs)](https://github.com/castlabs/electron-releases), [electron-builder](https://www.electron.build/) et [@xhayper/discord-rpc](https://github.com/xhayper/discord-rpc). Platine n'est affilié à aucune des plateformes citées.
