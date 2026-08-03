import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useT } from './i18n/LocaleContext';
import { AUTH_EXPIRED } from './api/events';
import {
  Layout, RequireAuth, RequireFreshPassword, RequireRole, Signpost,
} from './components/common';
import { allNavItems } from './components/common/nav-sections';
import { ROLE_DENIED_REDIRECT, routeTierFor } from './session/roles';
import { isSignpost } from '@shared/legacy-console-manifest.js';
import LoginPage from './pages/LoginPage';
import SecurityPage from './pages/Preference/SecurityPage';
import ProfilePage from './pages/Preference/ProfilePage';
import VaultPage from './pages/Preference/VaultPage';
import UsagePage from './pages/Portal/UsagePage';
import ProjectHistoryPage from './pages/Portal/ProjectHistoryPage';
import HandoffsPage from './pages/Portal/HandoffsPage';
import ReportsPage from './pages/Portal/ReportsPage';
import NarrativePage from './pages/Portal/NarrativePage';
import PitfallsPage from './pages/Portal/PitfallsPage';
import TeamPage from './pages/Admin/TeamPage';
import BugReportsPage from './pages/Admin/BugReportsPage';
import SystemConfigPage from './pages/System/SystemConfigPage';
import BroadcastPage from './pages/System/BroadcastPage';
import WorkLogPage from './pages/System/WorkLogPage';

// 已經在新後台跑起來的頁面。還在舊後台的功能不列在這裡 — 由功能清單
// （shared/legacy-console-manifest.js）決定要畫指路牌，兩邊不會各說一套。
const REAL_PAGES = {
  '/portal/usage': <UsagePage />,
  '/portal/project-history': <ProjectHistoryPage />,
  '/portal/handoffs': <HandoffsPage />,
  '/portal/reports': <ReportsPage />,
  '/portal/narrative': <NarrativePage />,
  '/portal/pitfalls': <PitfallsPage />,
  '/preference/profile': <ProfilePage />,
  '/preference/security': <SecurityPage />,
  '/preference/vault': <VaultPage />,
  '/admin/team': <TeamPage />,
  '/admin/bugs': <BugReportsPage />,
  '/system/config': <SystemConfigPage />,
  '/system/broadcast': <BroadcastPage />,
  '/system/work-log': <WorkLogPage />,
};

// 導覽列有、但兩邊都沒對到東西的路徑 — 這是接線錯誤，不是「即將完工」。
// 刻意寫得很難看：舊的空殼頁講「即將於後續階段完工」，那句話本身就是在騙人，
// 換成明白說壞掉。整個 App 不 throw，壞掉的只有那一頁。
function MissingPage({ path }) {
  return (
    <div role="alert" className="rounded-2xl border border-rose-300 bg-rose-50 p-8 text-rose-800">
      <p className="font-bold">Route not wired: {path}</p>
      <p className="mt-1 text-sm">
        This path is in the navigation but has neither a page nor a signpost entry.
      </p>
    </div>
  );
}

function NotFoundPage() {
  const t = useT();
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center shadow-sm">
      <h1 className="text-2xl font-bold text-sage-700">{t('error.not_found')}</h1>
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();

  // 監聽 client.js 在 401 時 dispatch 的 auth-expired event、自動導 /login
  // 保留 SPA 體驗（不 hard reload）、router state reset 由 navigate 處理
  //
  // SessionContext 的 logout() 也 dispatch 同一個 event，所以「登出」跟
  // 「token 失效」走同一條路徑，只有一個地方決定怎麼回到 /login
  useEffect(() => {
    function onAuthExpired() {
      navigate('/login', { replace: true });
    }
    window.addEventListener(AUTH_EXPIRED, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED, onAuthExpired);
  }, [navigate]);

  // Layout 自己從 SessionContext 讀身分、從 server 讀版號，所以這裡不再往下傳
  // role / profile / onLogout / onOpenProfile。那四個原本是寫死的佔位值：角色寫死
  // super_admin、姓名寫死 'User'、登出只 console.log、onOpenProfile 沒有實作。
  // 寫死的角色會讓每一個登入者都看到「管理」跟「超級管理」區塊。
  //
  // changelog 刻意留空：Footer 三語系都有 changelog.empty 空狀態，真正的更新
  // 紀錄來源是獨立的一件事。
  const layoutProps = { changelog: [] };

  // 一般頁面兩層守門員：
  //   RequireAuth — 沒登入直接導 /login
  //   RequireFreshPassword — 登入了但 must_change_password=true 強制導
  //     /preference/security（該頁本身會被放行、避免無限循環）
  const renderPage = (page) => (
    <RequireAuth>
      <RequireFreshPassword>
        <Layout {...layoutProps}>{page}</Layout>
      </RequireFreshPassword>
    </RequireAuth>
  );

  // 需要角色的頁面多包一層 RequireRole。側邊欄本來就按角色過濾，但那只擋住
  // 「看得到入口」，擋不住直接打網址進來。伺服器端每支 API 仍各自把關，這裡是
  // 讓後台不要提供伺服器本來就會拒絕的東西。
  const renderGated = (minRole, page) => (
    <RequireAuth>
      <RequireFreshPassword>
        <RequireRole min={minRole}>
          <Layout {...layoutProps}>{page}</Layout>
        </RequireRole>
      </RequireFreshPassword>
    </RequireAuth>
  );

  // 路由直接由導覽列資料長出來，所以不會出現「側邊欄有這一項、但沒有對應路由」
  // 或反過來的情形。守門的角色也讀同一份 minRole，跟側邊欄的過濾條件同源。
  //
  // 「要不要包守門員」由 routeTierFor 決定、不是寫在這裡的三元條件。理由跟
  // decideRoleGate 一樣：條件寫反會把每一頁個人頁面鎖起來、每一頁管理頁面打開，
  // 那種東西要用跑得起來的測試守，不能靠比對這一行的原始碼。
  const featureRoutes = allNavItems().map((item) => {
    const page = isSignpost(item.path)
      ? <Signpost path={item.path} />
      : (REAL_PAGES[item.path] ?? <MissingPage path={item.path} />);
    return (
      <Route
        key={item.path}
        path={item.path}
        element={routeTierFor(item.minRole) === 'open'
          ? renderPage(page)
          : renderGated(item.minRole, page)}
      />
    );
  });

  return (
    <Routes>
      {/* /login 不包 Layout、不包 RequireAuth — 唯一公開路由 */}
      <Route path="/login" element={<LoginPage />} />

      {/* 根路徑跟「角色不夠」導到同一頁，那一頁必須每個角色都進得去 */}
      <Route path="/" element={<Navigate to={ROLE_DENIED_REDIRECT} replace />} />

      {featureRoutes}

      <Route path="*" element={renderPage(<NotFoundPage />)} />
    </Routes>
  );
}
