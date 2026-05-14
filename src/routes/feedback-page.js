/**
 * feedback-page.js — GET /feedback/block 渲染確認頁面
 *
 * 無 auth、純 HTML inline 渲染、按一次確認 1 秒完成。
 * 設計來源：openspec/changes/v1.18.5-block-feedback-and-safety-alerts/spec.md A.2.1
 */

import { Router } from 'express';

// HTML 跳脫小工具：event_id 從 URL 來、防 reflected XSS
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderPage({ eventId, sig, userId }) {
  const safeEventId = escapeHtml(eventId);
  // sig / userId 透過 JS URLSearchParams 拿，不直接 inline 進 script
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OwnMind 回報誤殺</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; text-align: center; color: #222; background: #fafafa; }
    h2 { font-weight: 500; margin-bottom: 12px; }
    code { background: #eee; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
    button { padding: 16px 32px; font-size: 18px; background: #d33; color: white; border: none; border-radius: 8px; cursor: pointer; margin-top: 24px; }
    button:hover { background: #b22; }
    button:disabled { background: #888; cursor: not-allowed; }
    #status { margin-top: 24px; font-size: 16px; }
    .ok { color: #2a7a2a; }
    .err { color: #c33; }
    .small { color: #666; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <h2>確認回報這次擋錯了嗎？</h2>
  <p>事件 ID：<code>${safeEventId}</code></p>
  <button id="confirm">👎 確認擋錯了</button>
  <p id="status"></p>
  <p class="small">按下後 1 秒內回報完成、可手動關閉此分頁</p>
  <script>
    document.getElementById('confirm').addEventListener('click', async () => {
      const btn = document.getElementById('confirm');
      const status = document.getElementById('status');
      btn.disabled = true;
      const params = new URLSearchParams(location.search);
      try {
        const r = await fetch('/ownmind/api/feedback/block', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id: params.get('event_id'),
            sig: params.get('sig'),
            user_id: Number(params.get('user_id')),
          }),
        });
        if (r.ok) {
          status.className = 'ok';
          status.innerText = '✓ 已回報、感謝！';
        } else {
          status.className = 'err';
          const data = await r.json().catch(() => ({}));
          status.innerText = '✗ 回報失敗：' + (data.error || r.status);
        }
      } catch (e) {
        status.className = 'err';
        status.innerText = '✗ 網路錯誤：' + e.message;
      }
    });
  </script>
</body>
</html>`;
}

export function createFeedbackPageRouter() {
  const router = Router();

  router.get('/', (req, res) => {
    const eventId = req.query.event_id;
    const sig = req.query.sig;
    const userId = req.query.user_id;

    if (!eventId || !sig || !userId) {
      return res.status(400).type('text/html; charset=utf-8').send(
        '<!doctype html><body><h2>連結不完整</h2><p>缺少 event_id / sig / user_id</p></body>'
      );
    }

    res.type('text/html; charset=utf-8').send(renderPage({ eventId, sig, userId }));
  });

  return router;
}

export default createFeedbackPageRouter();
