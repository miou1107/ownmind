// v1.26.56 — event / type / action keys labelled through the locale dictionary.
//
// The legacy console holds a literal Chinese map (src/public/index.html:1055).
// Copying it here would put Chinese into a build that also serves en and ja.
//
// t() already falls back to the key it was given, which for a namespaced lookup
// means the string "stats.label.some_new_event" would appear on screen the first
// time the server emits an event nobody has translated. So the miss is detected
// and the raw key returned instead — ugly, but honest and recognisable.

export const STATS_LABEL_PREFIX = 'stats.label.';

export function statsLabel(rawKey, t) {
  if (!rawKey) return '';
  const lookup = `${STATS_LABEL_PREFIX}${rawKey}`;
  const translated = t(lookup);
  return translated === lookup ? rawKey : translated;
}
