import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useT } from './i18n/LocaleContext';
import { AUTH_EXPIRED } from './api/events';
import {
  Layout, RequireAuth, RequireFreshPassword, RequireRole,
} from './components/common';
import { NAV_ENTRIES, OLD_PATHS, allNavItems, firstVisiblePath } from './components/common/nav-sections';
import { ROLE_DENIED_REDIRECT, routeTierFor } from './session/roles';
import { useSession } from './session/SessionContext';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/Home/HomePage';
import SecurityPage from './pages/Preference/SecurityPage';
import ProfilePage from './pages/Preference/ProfilePage';
import VaultPage from './pages/Preference/VaultPage';
import UsageMinePage from './pages/Usage/UsageMinePage';
import RulesPage from './pages/Usage/RulesPage';
import UsageProjectsPage from './pages/Usage/UsageProjectsPage';
import UsageTeamPage from './pages/Usage/UsageTeamPage';
import ProjectHistoryPage from './pages/Portal/ProjectHistoryPage';
import HandoffsPage from './pages/Portal/HandoffsPage';
import LessonsPage from './pages/Portal/LessonsPage';
import TasksPage from './pages/Portal/TasksPage';
import TeamTasksPage from './pages/Team/TeamTasksPage';
import ReportsPage from './pages/Portal/ReportsPage';
import NarrativePage from './pages/Portal/NarrativePage';
import PeriodicReportsPage from './pages/Portal/PeriodicReportsPage';
import TeamPage from './pages/Admin/TeamPage';
import BugReportsPage from './pages/Admin/BugReportsPage';
import StatsPage from './pages/Team/StatsPage';
import MembersPage from './pages/Team/MembersPage';
import MemoryRulesPage from './pages/Memory/MemoryRulesPage';
import SystemConfigPage from './pages/System/SystemConfigPage';
import BroadcastPage from './pages/System/BroadcastPage';
import WorkLogPage from './pages/System/WorkLogPage';

// 後台的每一頁，以 v1.32.0 的新路徑為鍵。導覽列上的每一項（入口或分頁）都必須在這裡
// 找得到，找不到就是接線錯誤。舊路徑（OLD_PATHS）不在這裡，它們只負責轉址。
const REAL_PAGES = {
  '/home': <HomePage />,
  '/inbox/handoffs': <HandoffsPage />,
  '/inbox/lessons': <LessonsPage />,
  '/inbox/tasks': <TasksPage />,
  '/inbox/reports': <ReportsPage />,
  '/inbox/bugs': <BugReportsPage />,
  '/usage/mine': <UsageMinePage />,
  '/usage/rules': <RulesPage />,
  '/usage/projects': <UsageProjectsPage />,
  '/usage/team': <UsageTeamPage />,
  '/team/members': <MembersPage />,
  '/team/observe': <NarrativePage />,
  '/team/reports': <PeriodicReportsPage />,
  '/team/stats': <StatsPage />,
  '/team/tasks': <TeamTasksPage />,
  '/memory/projects': <ProjectHistoryPage />,
  '/memory/rules': <MemoryRulesPage />,
  '/settings/profile': <ProfilePage />,
  '/settings/security': <SecurityPage />,
  '/settings/vault': <VaultPage />,
  '/admin/users': <TeamPage />,
  '/admin/machines': <SystemConfigPage />,
  '/admin/broadcast': <BroadcastPage />,
  '/admin/work-log': <WorkLogPage />,
};

// 導覽列上有、但這裡沒有對應頁面的路徑 — 這是接線錯誤。
// 刻意寫得很難看：舊的空殼頁講「即將於後續階段完工」，那句話本身就是在騙人，
// 換成明白說壞掉。整個 App 不 throw，壞掉的只有那一頁。
function MissingPage({ path }) {
  return (
    <div role="alert" className="rounded-2xl border border-rose-300 bg-rose-50 p-8 text-rose-800">
      <p className="font-bold">Route not wired: {path}</p>
      <p className="mt-1 text-sm">
        This path is in the navigation but no page is wired to it.
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

// v1.32.0 — 一個入口的網址本身（/inbox）不是頁面：依登入者的身分，轉到這個入口裡
// 第一個他看得到的分頁。一個分頁都看不到，就跟角色不夠一樣，送回總覽。
// 身分還沒回來時不轉，否則 null 身分會把管理員送走。
function EntryIndex({ entry }) {
  const { role, ready } = useSession();
  if (!ready) return null;
  return <Navigate to={firstVisiblePath(entry, role) ?? ROLE_DENIED_REDIRECT} replace />;
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

  // 一般頁面兩層守門員：
  //   RequireAuth — 沒登入直接導 /login
  //   RequireFreshPassword — 登入了但 must_change_password=true 強制導
  //     /settings/security（該頁本身會被放行、避免無限循環）
  const renderPage = (page) => (
    <RequireAuth>
      <RequireFreshPassword>
        <Layout>{page}</Layout>
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
          <Layout>{page}</Layout>
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
    const page = REAL_PAGES[item.path] ?? <MissingPage path={item.path} />;
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

  // v1.32.0 — 入口本身的網址轉到第一個看得到的分頁。
  const entryRoutes = NAV_ENTRIES.filter((e) => e.tabs.length > 0).map((entry) => (
    <Route
      key={entry.path}
      path={entry.path}
      element={(
        <RequireAuth>
          <RequireFreshPassword>
            <EntryIndex entry={entry} />
          </RequireFreshPassword>
        </RequireAuth>
      )}
    />
  ));

  // v1.32.0 — 改版前的二十個網址都還能用：記憶、通知、公告裡的舊連結直接轉到接手的
  // 分頁。這份對照表在 nav-sections.js，跟新路徑放在一起，改路徑時兩邊會一起看到。
  const redirectRoutes = Object.entries(OLD_PATHS).map(([from, to]) => (
    <Route key={from} path={from} element={<Navigate to={to} replace />} />
  ));

  return (
    <Routes>
      {/* /login 不包 Layout、不包 RequireAuth — 唯一公開路由 */}
      <Route path="/login" element={<LoginPage />} />

      {/* 根路徑跟「角色不夠」導到同一頁，那一頁必須每個角色都進得去 */}
      <Route path="/" element={<Navigate to={ROLE_DENIED_REDIRECT} replace />} />

      {featureRoutes}
      {entryRoutes}
      {redirectRoutes}

      <Route path="*" element={renderPage(<NotFoundPage />)} />
    </Routes>
  );
}
