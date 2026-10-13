// Liste des plateformes. Pour en ajouter une : un id, un nom, l'URL du lecteur web,
// et les domaines qui font partie du site (le reste s'ouvre dans ton navigateur).
module.exports = [
  {
    id: 'tidal', name: 'Tidal', color: '#1a1a1a', accent: '#33ffee',
    url: 'https://listen.tidal.com/',
    domains: ['tidal.com'],
  },
  {
    id: 'spotify', name: 'Spotify', color: '#123d24', accent: '#1ed760',
    url: 'https://open.spotify.com/',
    domains: ['spotify.com', 'spotifycdn.com'],
  },
  {
    id: 'deezer', name: 'Deezer', color: '#2b1240', accent: '#a238ff',
    url: 'https://www.deezer.com/fr/',
    domains: ['deezer.com', 'dzcdn.net'],
  },
  {
    id: 'qobuz', name: 'Qobuz', color: '#0d2233', accent: '#4fb3ff',
    url: 'https://play.qobuz.com/',
    domains: ['qobuz.com'],
  },
  {
    id: 'applemusic', name: 'Apple Music', color: '#3a1018', accent: '#ff4e6b',
    url: 'https://music.apple.com/',
    domains: ['apple.com'],
  },
  {
    id: 'amazonmusic', name: 'Amazon Music', color: '#0f2a30', accent: '#25d1da',
    url: 'https://music.amazon.fr/',
    domains: ['amazon.fr', 'amazon.com', 'media-amazon.com'],
  },
  {
    id: 'ytmusic', name: 'YouTube Music', color: '#3a0d0d', accent: '#ff3b3b',
    url: 'https://music.youtube.com/',
    domains: ['youtube.com', 'google.com', 'gstatic.com'],
    adblock: true,
    note: 'Pubs passées automatiquement · la connexion Google peut être refusée',
  },
  {
    id: 'youtube', name: 'YouTube', color: '#2a0b0b', accent: '#ff4040',
    url: 'https://www.youtube.com/',
    domains: ['youtube.com', 'youtu.be', 'google.com', 'gstatic.com', 'ytimg.com'],
    adblock: true,
    multi: true, // plusieurs onglets possibles
    note: 'Pubs passées automatiquement · la connexion Google peut être refusée',
  },
  {
    id: 'twitch', name: 'Twitch', color: '#1f1233', accent: '#a970ff',
    url: 'https://www.twitch.tv/',
    domains: ['twitch.tv', 'ttvnw.net', 'jtvnw.net', 'twitchcdn.net', 'twitchsvc.net'],
    adblock: true,
    multi: true, // plusieurs onglets possibles
    note: 'Pubs bloquées (TwitchAdSolutions)',
  },
  {
    id: 'soundcloud', name: 'SoundCloud', color: '#3a1f0a', accent: '#ff7a1a',
    url: 'https://soundcloud.com/',
    domains: ['soundcloud.com', 'sndcdn.com'],
    multi: true,
  },
];
