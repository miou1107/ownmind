// End-to-end specs for the console, driving a real browser against a real server.
//
// These cover what the rest of the suite cannot: node --test cannot render React, so every
// claim about "a member sees only their own sections" or "the credential is handed across"
// was previously an assertion about source text. Source text cannot tell you that a nav
// item is on the screen.
//
// The zh dictionary is the default locale, so labels are asserted in Chinese. They come
// from client/src/i18n/zh.json; a rename there is meant to fail here, because the label is
// what the user actually sees.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS } from './harness.mjs';
import { signpostFeatures } from '../../shared/legacy-console-manifest.js';
import { navMinRole } from '../../client/src/components/common/nav-sections.js';

const base = () => process.env.E2E_BASE_URL;
const url = (path) => `${base()}${path}`;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const zh = JSON.parse(readFileSync(join(repoRoot, 'client/src/i18n/zh.json'), 'utf8'));

// The signpost specs below used to hardcode whichever path was signposted at the
// time — /admin/team in v1.26.46, then /admin/bugs in v1.26.49. Both went live in
// a later stage and left the specs asserting that a real page was a signpost. They
// were red from v1.26.51 until v1.26.56 and nobody saw it, because e2e is not part
// of `npm test`. So the subject is derived from the manifest instead.
//
// Deliberately NOT filtered by role. An earlier draft took the first signpost
// whose navMinRole === LEGACY_CONSOLE_MIN_ROLE, which silently yields null the
// day every remaining signpost sits at some other tier — and `test.skip` on null
// would green-skip three specs while /admin/ is still being served. That is the
// same shape of defect this block exists to fix. Take whatever is first and
// choose the account from its own minRole; skip only when nothing is signposted,
// which is the one condition under which the behaviour genuinely does not exist.
const SIGNPOST = signpostFeatures()[0] ?? null;
const signpostName = SIGNPOST ? zh[`legacy.tab.${SIGNPOST.legacyTab}`] : '';
const signpostAccount = SIGNPOST
  ? ({ user: ACCOUNTS.user, admin: ACCOUNTS.admin, super_admin: ACCOUNTS.superAdmin })[navMinRole(SIGNPOST.consolePath)]
  : null;

/** Regex-safe: a future tab label could contain `(`, `+` or `.`. */
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const signpostLink = (page) =>
  page.getByRole('link', { name: new RegExp(`前往舊後台的「${rx(signpostName)}」`) });

// Section headers are buttons; nav items are links. Both live inside the sidebar <aside>.
const SECTIONS = ['我的', '團隊', '偏好設定', '管理', '系統'];

async function login(page, account) {
  await page.goto(url('/dashboard/login'));
  await page.locator('input[type=email]').fill(account.email);
  await page.locator('input[type=password]').fill(account.password);
  await page.locator('button[type=submit]').click();
  // Landing on the usage page means the session resolved and the guards let us through.
  await expect(page).toHaveURL(/\/dashboard\/portal\/usage$/);
}

/** Section labels currently rendered in the sidebar, in order. */
async function visibleSections(page) {
  const aside = page.locator('aside');
  await expect(aside).toBeVisible();
  const labels = await aside.locator('nav > div > button').allInnerTexts();
  return labels.map((s) => s.trim()).filter(Boolean);
}

/** The sidebar link whose visible label is exactly this text. */
function navItem(page, label) {
  // Matched on visible text, not on the accessible name. The signpost marker carries an
  // aria-label, so a signposted item's accessible name is compound — "系統設定 這個功能還在
  // 舊後台" — and `getByRole('link', { name, exact: true })` reports 0 for an item that is
  // plainly on screen. The first version of this helper did exactly that, which made every
  // `toHaveCount(0)` below pass for the wrong reason: they would have passed even if the
  // items were visible to a member.
  return page.locator('aside a').filter({ hasText: new RegExp(`^${label}$`) });
}

/** A page's own heading, not the copy of it in the top bar. */
function pageHeading(page, name) {
  return page.getByRole('main').getByRole('heading', { name });
}

test.describe('who sees what', () => {
  test('a member sees only 我的 and 偏好設定', async ({ page }) => {
    await login(page, ACCOUNTS.user);

    expect(await visibleSections(page)).toEqual(['我的', '偏好設定']);

    // Nothing from the three privileged groups.
    for (const label of ['團隊用量', '統計儀表板', '使用者管理', '錯誤回報', '系統設定',
      '廣播管理', '工作紀錄']) {
      await expect(navItem(page, label)).toHaveCount(0);
    }
    // And their own pages are there.
    for (const label of ['用量分析', '專案歷程', '工作交接', '回報紀錄', '整體分析', '踩坑紀錄']) {
      await expect(navItem(page, label)).toHaveCount(1);
    }
    // 週報月報 is personal by nature but signposted at admin, because the legacy console
    // refuses a member at login. A signpost to a door that will not open is worse than none.
    await expect(navItem(page, '週報月報')).toHaveCount(0);
  });

  test('an admin sees 系統設定 but not 廣播管理 or 工作紀錄', async ({ page }) => {
    await login(page, ACCOUNTS.admin);

    expect(await visibleSections(page)).toEqual(SECTIONS);

    // This is the case that per-section permission could not express: one group holding
    // items an admin may use next to items only a super_admin may.
    await expect(navItem(page, '系統設定')).toHaveCount(1);
    await expect(navItem(page, '廣播管理')).toHaveCount(0);
    await expect(navItem(page, '工作紀錄')).toHaveCount(0);

    await expect(navItem(page, '週報月報')).toHaveCount(1);
    await expect(navItem(page, '使用者管理')).toHaveCount(1);
  });

  test('a super_admin sees every item', async ({ page }) => {
    await login(page, ACCOUNTS.superAdmin);

    expect(await visibleSections(page)).toEqual(SECTIONS);
    for (const label of ['廣播管理', '工作紀錄', '系統設定', '使用者管理', '錯誤回報',
      '團隊用量', '統計儀表板', '週報月報']) {
      await expect(navItem(page, label)).toHaveCount(1);
    }
  });

  test('稽核記錄 is gone from the navigation entirely', async ({ page }) => {
    await login(page, ACCOUNTS.superAdmin);
    // It was a nav item for a feature with no page and no API anywhere.
    await expect(page.locator('aside').getByText('稽核')).toHaveCount(0);
  });
});

test.describe('route guards', () => {
  test('a typed admin URL sends a member back to a page they may see', async ({ page }) => {
    await login(page, ACCOUNTS.user);
    await page.goto(url('/dashboard/admin/team'));
    await expect(page).toHaveURL(/\/dashboard\/portal\/usage$/);
  });

  test('an admin hard-loading an admin URL stays on it', async ({ page }) => {
    // The readiness gate: deciding while the identity is still in flight would bounce a
    // legitimate admin, because an unresolved session looks exactly like a role-less one.
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/admin/team'));
    await expect(page).toHaveURL(/\/dashboard\/admin\/team$/);
    await expect(pageHeading(page, '使用者管理')).toBeVisible();
  });

  test('a super-admin-only URL sends an admin away', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/system/broadcast'));
    await expect(page).toHaveURL(/\/dashboard\/portal\/usage$/);
  });
});

test.describe('signposts', () => {
  // Every spec here needs something still signposted. Skipping is the honest
  // answer once the consolidation finishes — the behaviour will no longer exist.
  test.skip(() => SIGNPOST === null, 'no signposts left; the legacy console is retired');

  test('a signpost names where the feature is and does not claim to be a rebuild', async ({ page }) => {
    await login(page, signpostAccount);
    await page.goto(url(`/dashboard${SIGNPOST.consolePath}`));

    // The copy it replaced said "此頁面正在重構中、即將於後續階段完工", which was untrue:
    // the feature was working the whole time, in the old console.
    await expect(page.getByText('即將於後續階段完工')).toHaveCount(0);
    await expect(page.getByText('這個功能現在還在舊後台運作')).toBeVisible();
    // Names the destination tab rather than saying "go and find it".
    await expect(signpostLink(page)).toBeVisible();
  });

  test('following a signpost carries the credential and lands on the right tab', async ({ page }) => {
    await login(page, signpostAccount);
    const consoleKey = await page.evaluate(() => localStorage.getItem('ownmind.api_key'));
    expect(consoleKey).toBeTruthy();

    await page.goto(url(`/dashboard${SIGNPOST.consolePath}`));
    await signpostLink(page).click();

    await expect(page).toHaveURL(new RegExp(`/admin/#${SIGNPOST.legacyTab}$`));

    // Same value under the legacy name: three consoles, three key names, one users.api_key.
    const handed = await page.evaluate(() => ({
      key: localStorage.getItem('om_api_key'),
      role: localStorage.getItem('om_role'),
      name: localStorage.getItem('om_user_name'),
    }));
    expect(handed.key).toBe(consoleKey);
    expect(handed.role).toBe(signpostAccount.role);
    expect(handed.name).toBe(signpostAccount.name);

    // No second login: the legacy console restored the session and opened the asked-for tab.
    await expect(page.locator('#loginView')).toBeHidden();
    await expect(page.locator(`.tab[data-tab="${SIGNPOST.legacyTab}"]`)).toHaveClass(/active/);
  });

  test('logging out of the console clears the legacy credential too', async ({ page }) => {
    // The defect this covers, found in review: the handoff writes a usable om_api_key and
    // logout cleared only the console's own key, so the next person to open /admin/ in this
    // browser was restored as the previous user, holding a key every adminAuth route takes.
    await login(page, signpostAccount);
    await page.goto(url(`/dashboard${SIGNPOST.consolePath}`));
    await signpostLink(page).click();
    await expect(page).toHaveURL(new RegExp(`/admin/#${SIGNPOST.legacyTab}$`));
    expect(await page.evaluate(() => localStorage.getItem('om_api_key'))).toBeTruthy();

    // Back to the console and log out through the avatar menu.
    await page.goto(url('/dashboard/portal/usage'));
    await page.locator('header button').filter({ hasText: signpostAccount.name }).click();
    await page.getByRole('button', { name: '登出' }).click();
    await expect(page).toHaveURL(/\/dashboard\/login$/);

    const left = await page.evaluate(() => ['om_api_key', 'om_role', 'om_user_id', 'om_user_name',
      'ownmind.api_key'].filter((k) => localStorage.getItem(k) !== null));
    expect(left).toEqual([]);
  });
});

test.describe('v1.26.49 team management page', () => {
  test('admin sees the users table with expected columns and the add-user button', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/admin/team'));
    await expect(pageHeading(page, '使用者管理')).toBeVisible();

    // Column headers surface the two new columns (密碼狀態, 用量資料) that the legacy tab lacked.
    for (const col of ['Email', 'API Key', '角色', '密碼狀態', '用量資料']) {
      await expect(page.getByText(col).first()).toBeVisible();
    }

    // Add user is the only mutation the header exposes; row-level actions live in the dropdown.
    await expect(page.getByRole('button', { name: /新增使用者/ })).toBeVisible();
  });

  test('users with no usage rows render 尚無資料, not zero', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/admin/team'));
    // The harness seeds three accounts and no usage: every row should read as unmeasured.
    await expect(page.getByText('尚無資料').first()).toBeVisible();
  });

  test('sidebar 使用者管理 no longer carries the amber "still in legacy" marker', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/portal/usage'));
    // The nav item exists but must not carry the aria-label the signpost uses.
    // Scoped to this one item — the remaining signposts still carry it, so a
    // page-wide search would fail.
    //
    // v1.26.56: the label was written as 成員 here, but nav.members has read
    // 使用者管理 the whole time, so getByRole matched nothing and the test was
    // red from the day it was written.
    const membersNavItem = page.getByRole('link', { name: new RegExp(`^${zh['nav.members']}`) });
    await expect(membersNavItem).toBeVisible();
    await expect(membersNavItem.getByLabel('這個功能還在舊後台')).toHaveCount(0);
  });
});

test.describe('v1.26.56 statistics dashboard', () => {
  // The harness seeds three accounts and no activity of any kind, which is
  // exactly the state Requirement 7 is about: every rate is unmeasured rather
  // than zero. A page that renders 0% here would be asserting a failure it
  // never observed.

  test('the overview lists the seeded users with unmeasured rates, not zeros', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/stats'));
    await expect(pageHeading(page, '統計儀表板')).toBeVisible();

    const header = page.getByRole('row').first();
    for (const col of ['用戶', '記憶', 'Session', '使用工具', '使用模型', '落地率', '最後活躍']) {
      await expect(header.getByText(col, { exact: true })).toBeVisible();
    }

    // No compliance events seeded ⇒ 尚無數據 in the rate column, and 從未 in
    // last-active. Neither may render as 0% or as a date.
    await expect(page.getByText('尚無數據').first()).toBeVisible();
    await expect(page.getByText('從未').first()).toBeVisible();
    // exact, because the default is substring and "100%" contains "0%".
    await expect(page.getByText('0%', { exact: true })).toHaveCount(0);

    // A NULL model column survives GROUP BY as the string "null". Found here
    // rendering as `null 1` in a pill; it must resolve through the dictionary.
    await expect(page.getByText('null', { exact: true })).toHaveCount(0);
  });

  test('selecting a user renders every detail block, each empty one saying so', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/stats'));

    await page.locator('#stats-user').selectOption({ label: ACCOUNTS.admin.name });

    for (const block of ['記憶類型分布', '工具使用分布', '模型使用分布', '每日活動量',
      '鐵律合規率', '各規則落地率', '各工具落地率', '每條鐵律落地率', '鐵律觸發 Top 5',
      '系統健康', '常用操作', '專案分布', '使用者痛點', 'AI 改善建議', '交接統計']) {
      await expect(pageHeading(page, block)).toBeVisible();
    }

    // The harness seeds one session carrying a details payload, so the context
    // section is available with every sub-list empty. Requirement 6's second
    // scenario: an empty block states its own emptiness and its siblings still
    // render. (The context-absent branch is unit-tested in stats-detail-vm; e2e
    // cannot make the endpoint return null without changing the fixture.)
    await expect(page.getByText('本期沒有回報痛點')).toBeVisible();
    await expect(page.getByText('本期沒有改善建議')).toBeVisible();

    // Nothing on a page with no compliance events may show a rate.
    // exact, because the default is substring and "100%" contains "0%".
    await expect(page.getByText('0%', { exact: true })).toHaveCount(0);
  });

  test('short charts sit beside a sibling and the bars are width-capped', async ({ page }) => {
    // Umbrella Requirement 7's last scenario, which is a layout claim and so
    // cannot be proved by a unit test: a three-row chart spanning the full page
    // puts a two-digit count 1500px from its own label. Measured rather than
    // asserted against class names, which would pass for a broken layout.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/stats'));
    await page.locator('#stats-user').selectOption({ label: ACCOUNTS.admin.name });
    await expect(pageHeading(page, '工具使用分布')).toBeVisible();

    const card = (title) => page.getByRole('heading', { name: title }).locator('..');
    const tools = await card('工具使用分布').boundingBox();
    const models = await card('模型使用分布').boundingBox();

    expect(Math.abs(tools.y - models.y)).toBeLessThan(4);
    expect(models.x).toBeGreaterThan(tools.x + tools.width - 4);

    // And the bar rows inside are capped, not stretched to the card.
    const barRow = card('專案分布').locator('div.max-w-2xl').first();
    const rowBox = await barRow.boundingBox();
    expect(rowBox.width).toBeLessThanOrEqual(672 + 1); // Tailwind max-w-2xl = 42rem
  });

  test('the range select offers exactly 7 / 30 / 90 and defaults to 30', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/stats'));
    const range = page.locator('#stats-days');
    await expect(range).toHaveValue('30');
    expect(await range.locator('option').allInnerTexts())
      .toEqual(['最近 7 天', '最近 30 天', '最近 90 天']);
  });

  test('sidebar 統計儀表板 no longer carries the amber "still in legacy" marker', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/portal/usage'));
    // Label read from the dictionary for the same reason as 使用者管理 above: a
    // hardcoded one that drifts makes the locator match nothing, and a test that
    // finds nothing passes every `toHaveCount(0)` for the wrong reason.
    const statsNavItem = page.getByRole('link', { name: new RegExp(`^${zh['nav.team_stats']}`) });
    await expect(statsNavItem).toBeVisible();
    await expect(statsNavItem.getByLabel('這個功能還在舊後台')).toHaveCount(0);
  });
});

test.describe('the pages ported from /me/', () => {
  test('整體分析 renders its ten sections and says why there are no AI notes', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/portal/narrative'));

    for (const heading of ['誰最常用 OwnMind', '大家的 OwnMind 版本', '哪幾天最忙',
      '一天裡哪個時段最忙（台北時間）', '一週各天分布', '軟體更新有沒有失敗',
      '大家的 OwnMind 行為分析', '鐵律有沒有被遵守', '各專案活動量排行',
      '各專案最常踩什麼坑']) {
      await expect(pageHeading(page, new RegExp(heading))).toBeVisible();
    }

    // The harness starts the server with no LLM key, so /insights answers 503 no_api_key.
    // The mechanical report has to survive that, and the reason has to be stated rather
    // than left as an unexplained dash.
    await expect(page.getByText('管理者還沒設定 AI 服務').first()).toBeVisible();
  });

  test('整體分析 marks members who have never reported instead of showing them as zero', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/portal/narrative'));

    // All three seeded accounts are brand new: no heartbeat, no activity. So all three are
    // genuinely unmeasured, and none of them may be rendered as a real zero.
    await expect(page.getByText(/從來沒有回報過任何資料/)).toBeVisible();
    await expect(page.getByText('從來沒有回報過（可能還沒安裝）').first()).toBeVisible();
  });

  test('踩坑紀錄 renders its three sections and the seeded orphan session', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/portal/pitfalls'));

    await expect(pageHeading(page, /踩坑紀錄/)).toBeVisible();

    // The harness seeds one six-turn session with no compliance array, so all three
    // sections render and the third has a row. Asserting the all-clear state instead would
    // have left the port's actual rendering untested.
    for (const heading of ['鐵律被動到、但伺服器沒留紀錄', '系統看到了、但 AI 沒主動回報',
      '整段對話都沒有遵守紀錄']) {
      await expect(pageHeading(page, new RegExp(heading))).toBeVisible();
    }
    await expect(page.getByText(/6 輪/)).toBeVisible();
    // Every row must carry its "what to do" line, because most of them say "historical
    // residue, leave it alone" and without that people try to backfill the data by hand.
    await expect(page.getByText(/怎麼處理：/).first()).toBeVisible();
  });

  test('踩坑紀錄 reports a clean bill of health rather than an error when there is nothing', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/portal/pitfalls'));
    // The seeded session is a day old, so a 7-day window still contains it; narrow the
    // window past it by asking for a period it cannot fall in is not possible here, so
    // instead check the empty state through the section that has no rows.
    await expect(page.getByText('這段期間沒有這一類的紀錄').first()).toBeVisible();
  });

  test('the custom date range queries the server with start and end', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/portal/usage'));

    await page.getByRole('button', { name: '自訂區間' }).click();
    // Filling only one date must not fire a request: the effect depends on the computed
    // query string, so a half-filled range cannot produce half a query.
    const requests = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/me/report')) requests.push(r.url());
    });

    await page.locator('input[type=date]').first().fill('2026-07-01');
    await expect(page.getByText('開始與結束日期都選好之後才會查')).toBeVisible();
    expect(requests).toEqual([]);

    await page.locator('input[type=date]').nth(1).fill('2026-07-15');
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests[requests.length - 1]).toContain('start=2026-07-01');
    expect(requests[requests.length - 1]).toContain('end=2026-07-15');
  });

  test('a reversed custom range is refused rather than silently returning nothing', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/portal/usage'));
    await page.getByRole('button', { name: '自訂區間' }).click();
    await page.locator('input[type=date]').first().fill('2026-07-15');
    await page.locator('input[type=date]').nth(1).fill('2026-07-01');
    await expect(page.getByRole('alert').filter({ hasText: '開始日期不能晚於結束日期' })).toBeVisible();
  });
});

test.describe('the legacy console is still served while signposts remain', () => {
  test('/admin/ answers with the old console, not a redirect', async ({ request }) => {
    // The other half of the manifest either/or. Its retirement branch is covered by
    // tests/legacy-console-manifest.test.js, which can vary the manifest; this checks the
    // real app as configured today, with eight signposts outstanding.
    const r = await request.get(url('/admin/'), { maxRedirects: 0 });
    expect(r.status()).toBe(200);
    expect(await r.text()).toContain('data-tab="users"');
  });

  test('the console shell still resolves at depth, so deep links are not blank', async ({ page }) => {
    // v1.26.44's base-href rewrite. A regression here renders every route deeper than one
    // segment as a white page, which no source-level test would catch.
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/dashboard/system/config'));
    await expect(pageHeading(page, '系統設定')).toBeVisible();
  });
});
