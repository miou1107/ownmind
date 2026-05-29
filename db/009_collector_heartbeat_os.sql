-- 009: collector_heartbeat 加 os 欄位
-- 用於 dashboard 顯示機器副資訊（macOS/Linux/Windows），避免短機器名（如 Bob 的 "after"）造成 UX 混淆。
-- 與 scanner_version 同層級，由 client 主動上送。

ALTER TABLE collector_heartbeat
  ADD COLUMN IF NOT EXISTS os VARCHAR(64);

COMMENT ON COLUMN collector_heartbeat.os IS
  'Client 自報的作業系統 (Node os.platform())：darwin / linux / win32 / 其他。前端可轉換成 macOS / Linux / Windows 顯示。';
