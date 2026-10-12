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
- **Mini-lecteur** : `Ctrl + Maj + M` ou menu de l'icône. Petite fenêtre toujours au premier plan avec pochette, titre, précédent / lecture / suivant. Se déplace en la tirant ; Espace, flèches et Échap marchent dedans
- **Mises à jour automatiques** : Platine vérifie les Releases GitHub au lancement puis toutes les 6 h, télécharge en fond et propose de redémarrer
- **Lancer au démarrage de Windows** : case à cocher dans le menu de l'icône (Platine démarre réduit dans la zone de notif)

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

## Publier une mise à jour

1. Change `"version"` dans `package.json` (ex. `1.1.0` → `1.2.0`)
2. Commit + push
3. Tag `v1.2.0` + push : le workflow publie la Release avec `latest.yml`, et les Platine installés se mettent à jour tout seuls

## Changer l'icône

Remplace `assets/icon.png` par une image carrée d'au moins 256 × 256 (des propositions sont dans `assets/propositions/`).
