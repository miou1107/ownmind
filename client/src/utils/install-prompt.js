// Build the "install OwnMind on my machine" prompt that admin copies into the
// user's AI tool. Ported from src/public/index.html:1474-1480; the string shape
// stays byte-identical so a machine already primed by the legacy tab keeps
// working, and so a screenshot from a year ago still reads the same today.
//
// Pure function on purpose: the React click handler adds clipboard write +
// toast, but the composed string is testable without a DOM.

export function buildInstallPrompt(user, apiUrl) {
  const apiKey = user && user.api_key;
  if (!apiKey) {
    throw new Error('buildInstallPrompt: user.api_key is required');
  }
  if (!apiUrl) {
    throw new Error('buildInstallPrompt: api_url is required');
  }

  return `幫我安裝 OwnMind：

macOS / Linux:
curl -sL https://raw.githubusercontent.com/miou1107/ownmind/main/install.sh | bash -s -- ${apiKey} ${apiUrl}

Windows (PowerShell):
$env:OWNMIND_API_KEY='${apiKey}'; $env:OWNMIND_API_URL='${apiUrl}'; irm https://raw.githubusercontent.com/miou1107/ownmind/main/install.ps1 | iex`;
}

// Derive the API base URL the way the legacy tab did (src/public/index.html
// `getApiUrl()`): take the current origin+path, strip a trailing `/admin` or
// `/admin/whatever`. This works behind the /ownmind reverse proxy AND at a bare
// origin, because it only removes the /admin suffix — everything before it
// (the /ownmind prefix, or nothing) is preserved.
//
// Pulled out into a separate export so the tests for install-prompt itself can
// pass a fixed api_url; only the click handler in TeamPage.jsx calls this one.
export function currentApiUrl(location) {
  const href = `${location.origin}${location.pathname}`;
  return href.replace(/\/admin(\/.*)?$/, '').replace(/\/dashboard(\/.*)?$/, '');
}
