// Réglages à remplir une fois.

// ID de ton application Discord (pas un secret, il peut rester dans le code public).
// Comment l'obtenir : https://discord.com/developers/applications → New Application → nom « Platine »
// → copie l'« Application ID ». Dans « Rich Presence → Art Assets », ajoute l'icône de Platine
// avec le nom « platine » (elle s'affiche quand une plateforme ne fournit pas de pochette).
// Laisse vide pour désactiver Discord.
const DISCORD_CLIENT_ID = '1559302656529539136';

// Port local de l'overlay OBS : http://127.0.0.1:<port>/overlay
const OVERLAY_PORT = 4848;

// --- Playlists (lecture, transfert, sauvegarde) ---
// IDs client de tes applis développeur (publics, pas de secret nécessaire).
// Dans chaque appli, ajoute cette adresse de redirection : http://127.0.0.1:4849/callback
//   Tidal   : https://developer.tidal.com/dashboard  → Create app → copie le « Client ID »
//   Spotify : https://developer.spotify.com/dashboard → Create app (Web API) → copie le « Client ID »
// Tant que c'est vide, la plateforme apparaît « à configurer » dans la fenêtre Playlists.
const TIDAL_CLIENT_ID = 'UyJ1xYZeoydpcIZi';
const SPOTIFY_CLIENT_ID = 'b8dc132c8e14433ca8bca32bec78c1c5';

// Port local utilisé uniquement pendant la connexion (doit correspondre à l'adresse de redirection).
const AUTH_PORT = 4849;

module.exports = { DISCORD_CLIENT_ID, OVERLAY_PORT, TIDAL_CLIENT_ID, SPOTIFY_CLIENT_ID, AUTH_PORT };
