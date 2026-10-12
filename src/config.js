// Réglages à remplir une fois.

// ID de ton application Discord (pas un secret, il peut rester dans le code public).
// Comment l'obtenir : https://discord.com/developers/applications → New Application → nom « Platine »
// → copie l'« Application ID ». Dans « Rich Presence → Art Assets », ajoute l'icône de Platine
// avec le nom « platine » (elle s'affiche quand une plateforme ne fournit pas de pochette).
// Laisse vide pour désactiver Discord.
const DISCORD_CLIENT_ID = '1559302656529539136';

// Port local de l'overlay OBS : http://127.0.0.1:<port>/overlay
const OVERLAY_PORT = 4848;

module.exports = { DISCORD_CLIENT_ID, OVERLAY_PORT };
