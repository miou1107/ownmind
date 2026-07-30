import { TriangleAlert, Info } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';

// 資料品質警示 — 從舊的 /me/ 頁搬過來（第一次盤點漏掉的兩個功能之一）
//
// 來源：GET /api/me/report 的 me.audit_findings（src/routes/me.js）
// 兩種 finding：
//   heartbeat_absent    最近有活動但 collector 超過 24 小時沒回報 → token 數字可能不完整
//   source_inconsistent 有 activity 但完全沒有 token_events → scanner 可能沒在跑
//
// 為什麼一定要搬：這是「頁面上的數字可不可信」的唯一提示。沒有它，一個 collector
// 掛掉的人看到的用量會偏低，而且看起來完全正常 — 正是 Requirement 7 要避免的「沒有
// 資料被畫成零」。訊息本身由伺服器產生（含數量），前端只負責分級呈現。

const TONE = {
  high: 'border-rose-200 bg-rose-50 text-rose-800',
  medium: 'border-amber-200 bg-amber-50 text-amber-800',
  low: 'border-slate-200 bg-slate-50 text-slate-700',
};

export default function AuditFindings({ findings }) {
  const t = useT();
  const rows = Array.isArray(findings) ? findings : [];
  if (rows.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      {rows.map((f, i) => {
        const tone = TONE[f.severity] || TONE.low;
        const Icon = f.severity === 'high' ? TriangleAlert : Info;
        const tools = f.details?.tools;
        // 伺服器只會產出 heartbeat_absent / source_inconsistent 兩種，但舊頁的對照表列了
        // 九種（其餘在 v1.17.87 搬到踩坑紀錄）。真的冒出沒有標題的類型時只顯示訊息，
        // 不要把 i18n key 原文貼給使用者看 — t() 找不到時會回 key 本身。
        const titleKey = `audit.finding.${f.type}`;
        const title = t(titleKey);
        const severityKey = `audit.severity.${f.severity}`;
        const severity = t(severityKey);
        return (
          <div
            key={`${f.type}-${i}`}
            role="alert"
            className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${tone}`}
          >
            <span className="mt-0.5 shrink-0"><Icon size={16} /></span>
            <div className="min-w-0">
              <p className="font-semibold">
                {/* 嚴重程度不能只靠顏色表示 */}
                {severity !== severityKey && (
                  <span className="mr-1.5 font-normal opacity-70">[{severity}]</span>
                )}
                {title === titleKey ? f.message : title}
              </p>
              {/* 訊息由伺服器組（含實際數量），照原文顯示、不要在前端重寫一遍。
                  沒有標題的類型上面已經把 message 當標題用了、這裡就不重複 */}
              {title !== titleKey && (
                <p className="mt-0.5 leading-relaxed opacity-90">{f.message}</p>
              )}
              {Array.isArray(tools) && tools.length > 0 && (
                <p className="mt-0.5 text-xs opacity-75 break-all">
                  {t('audit.finding.tools', { tools: tools.join('、') })}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
