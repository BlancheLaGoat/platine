# Platine

Tes plateformes de musique dans une vraie appli desktop, stable, en qualité max. Chaque plateforme tourne avec son lecteur web officiel dans un Electron Castlabs signé (Widevine).

**Plateformes** : Tidal, Spotify, Deezer, Qobuz, Apple Music, Amazon Music, YouTube Music, SoundCloud.

- **Écran de choix** au premier lancement, puis Platine rouvre la dernière plateforme utilisée
- **Une session par plateforme** : tu te connectes une fois à chacune et tu restes connecté
- **Changer de plateforme** : `Ctrl + Maj + P`, ou clic droit sur l'icône près de l'horloge → Plateforme
- **Auto-récupération** : page qui crashe, qui fige ou GPU qui lâche → rechargement automatique là où tu étais
- Fermer la fenêtre la réduit dans la zone de notif sans couper la musique
- Touches multimédia et contrôles Windows (donc TidalNowPlaying marche toujours)
- « Se déconnecter de cette plateforme » et journal des crashs dans le menu de l'icône

## Ajouter une plateforme

Ajoute une entrée dans `src/platforms.js` : id, nom, couleurs, URL du lecteur web et domaines du site.

## Lancer / construire

```
npm install
python -m castlabs_evs.vmp sign-pkg node_modules/electron/dist
npm start
```

Installeur : `npm run dist` (la signature Castlabs est faite automatiquement à la fin du build). Il sort dans `dist/`.

Sur GitHub Actions : secrets `EVS_ACCOUNT` et `EVS_PASSWD`, puis pousse un tag `v1.0.0`.

## Connexion Google (YouTube Music)

Google bloque volontairement sa connexion dans les applis qui embarquent un navigateur. Elle peut donc être refusée. Pour les autres plateformes, utilise une connexion par e-mail et mot de passe si le bouton « Continuer avec Google » est bloqué.
