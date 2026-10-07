// Browser-safe catalog: audio is composed locally, with no third-party streams or API keys.
export const RADIO_TRACKS = [
  { id: 'moonlit-notes', title: 'Moonlit notes', kind: 'music', durationMs: 96_000, symbol: '☾' },
  { id: 'soft-morning', title: 'Soft morning', kind: 'music', durationMs: 96_000, symbol: '✧' },
  { id: 'window-seat', title: 'Window seat', kind: 'music', durationMs: 96_000, symbol: '♡' },
  { id: 'rain', title: 'Rain at the window', kind: 'ambience', durationMs: 96_000, symbol: '☂' },
  { id: 'cafe', title: 'Quiet café', kind: 'ambience', durationMs: 96_000, symbol: '☕' },
];
export const radioTrack = (id) => RADIO_TRACKS.find(track => track.id === id);
