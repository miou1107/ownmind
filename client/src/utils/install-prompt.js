// Build the "install OwnMind on my machine" message that an admin copies into a colleague's
// AI tool.
//
// Zero-touch install: the message points at the OwnMind server, not at the public repository's
// raw file host. It tells the AI to read the manual (GET /install-manual.md) first, run the
// one-liner for the operating system once, and act on the NEXT / FIX / ASK lines the installer
// prints. The server serves scripts/bootstrap.sh at /install.sh and scripts/bootstrap.ps1 at
// /install.ps1, which work on a computer that has neither a version-control tool nor Node.js.
//
// Pure function on purpose: the React click handler adds clipboard write + toast, but the
// composed string is testable without a DOM.

// The Chinese wording below is drafted and shown to the product owner; final approval is still
// pending, so do not edit a sentence without asking (tests/team-install-prompt.test.js pins it).
const INSTALL_PROMPT = [
  '幫我安裝 OwnMind。',
  '先讀 <API_URL>/install-manual.md，照手冊的步驟做。',
  '依這台電腦的作業系統，從下面挑一行執行，只執行一次。畫面上顯示 NEXT 就照 NEXT 做；顯示 FIX 就先執行 FIX 那一行的指令，再重跑一次安裝指令；顯示 ASK 才來問我。',
  '安裝過程需要我按「允許」或開權限時，一步一步告訴我按哪裡。相依的軟體都由安裝指令自己處理，不要叫我手動裝。',
  '',
  'macOS:',
  'curl -fsSL <API_URL>/install.sh | bash -s -- <KEY> <API_URL>',
  '',
  'Windows (PowerShell):',
  "$env:OWNMIND_API_KEY='<KEY>'; $env:OWNMIND_API_URL='<API_URL>'; irm <API_URL>/install.ps1 | iex",
].join('\n');

export function buildInstallPrompt(user, apiUrl) {
  const apiKey = user && user.api_key;
  if (!apiKey) {
    throw new Error('buildInstallPrompt: user.api_key is required');
  }
  if (!apiUrl) {
    throw new Error('buildInstallPrompt: api_url is required');
  }

  // A trailing slash would turn <API_URL>/install.sh into a double slash.
  const url = apiUrl.replace(/\/+$/, '');
  // One pass with a function replacer: a key containing `$&` or `$1` must come out as typed.
  return INSTALL_PROMPT.replace(/<API_URL>|<KEY>/g, (token) => (token === '<KEY>' ? apiKey : url));
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
