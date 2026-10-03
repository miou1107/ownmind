// The setup wizard's script. Inline until v1.31.1, when the server turned its content
// security policy on: an inline script, and inline onclick handlers, are exactly what that
// policy exists to refuse. Served by src/app.js at /setup.js.
const form = document.getElementById('setup-form');
const errorBox = document.getElementById('error-box');
const submitBtn = document.getElementById('submit-btn');
const formSection = document.getElementById('form-section');
const successSection = document.getElementById('success-section');
const apiKeyText = document.getElementById('api-key-text');
const installCmd = document.getElementById('install-cmd');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
}
function clearError() {
  errorBox.classList.remove('show');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const email = document.getElementById('email').value.trim();
  const name = document.getElementById('name').value.trim();
  const password = document.getElementById('password').value;
  const password2 = document.getElementById('password2').value;

  if (password !== password2) {
    showError('兩次輸入的密碼不一樣、請再確認');
    return;
  }
  if (password.length < 8) {
    showError('密碼至少 8 個字元');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '建立中...';

  try {
    const res = await fetch('/api/setup/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: name || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || '建立失敗、請查 server log');
      submitBtn.disabled = false;
      submitBtn.textContent = '建立管理員帳號';
      return;
    }

    // 成功：切到 success 區
    apiKeyText.textContent = data.api_key;
    const host = window.location.origin;
    installCmd.textContent =
      `curl -fsSL https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.sh | bash -s -- ${data.api_key} ${host}`;
    formSection.style.display = 'none';
    successSection.classList.add('show');
  } catch (err) {
    showError('網路錯誤、無法連到伺服器');
    submitBtn.disabled = false;
    submitBtn.textContent = '建立管理員帳號';
  }
});

function copyApiKey(ev) {
  navigator.clipboard.writeText(apiKeyText.textContent);
  const btn = ev.target;
  const orig = btn.textContent;
  btn.textContent = '已複製';
  setTimeout(() => { btn.textContent = orig; }, 1500);
}
function copyInstallCmd(ev) {
  navigator.clipboard.writeText(installCmd.textContent);
  const btn = ev.target;
  const orig = btn.textContent;
  btn.textContent = '已複製';
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

document.getElementById('copy-api-key').addEventListener('click', copyApiKey);
document.getElementById('copy-install-cmd').addEventListener('click', copyInstallCmd);
