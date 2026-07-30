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
import { ACCOUNTS } from './harness.mjs';

const base = () => process.env.E2E_BASE_URL;
const url = (path) => `${base()}${path}`;

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
  test('a signpost names where the feature is and does not claim to be a rebuild', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/admin/team'));

    // The copy it replaced said "此頁面正在重構中、即將於後續階段完工", which was untrue:
    // the feature was working the whole time, in the old console.
    await expect(page.getByText('即將於後續階段完工')).toHaveCount(0);
    await expect(page.getByText('這個功能現在還在舊後台運作')).toBeVisible();
    // Names the destination tab rather than saying "go and find it".
    await expect(page.getByRole('link', { name: /前往舊後台的「使用者管理」/ })).toBeVisible();
  });

  test('following a signpost carries the credential and lands on the right tab', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    const consoleKey = await page.evaluate(() => localStorage.getItem('ownmind.api_key'));
    expect(consoleKey).toBeTruthy();

    await page.goto(url('/dashboard/admin/bugs'));
    await page.getByRole('link', { name: /前往舊後台的「錯誤回報」/ }).click();

    await expect(page).toHaveURL(/\/admin\/#bug-reports$/);

    // Same value under the legacy name: three consoles, three key names, one users.api_key.
    const handed = await page.evaluate(() => ({
      key: localStorage.getItem('om_api_key'),
      role: localStorage.getItem('om_role'),
      name: localStorage.getItem('om_user_name'),
    }));
    expect(handed.key).toBe(consoleKey);
    expect(handed.role).toBe('admin');
    expect(handed.name).toBe(ACCOUNTS.admin.name);

    // No second login: the legacy console restored the session and opened the asked-for tab.
    await expect(page.locator('#loginView')).toBeHidden();
    await expect(page.locator('.tab[data-tab="bug-reports"]')).toHaveClass(/active/);
  });

  test('logging out of the console clears the legacy credential too', async ({ page }) => {
    // The defect this covers, found in review: the handoff writes a usable om_api_key and
    // logout cleared only the console's own key, so the next person to open /admin/ in this
    // browser was restored as the previous user, holding a key every adminAuth route takes.
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/admin/team'));
    await page.getByRole('link', { name: /前往舊後台的「使用者管理」/ }).click();
    await expect(page).toHaveURL(/\/admin\/#users$/);
    expect(await page.evaluate(() => localStorage.getItem('om_api_key'))).toBeTruthy();

    // Back to the console and log out through the avatar menu.
    await page.goto(url('/dashboard/portal/usage'));
    await page.locator('header button').filter({ hasText: ACCOUNTS.admin.name }).click();
    await page.getByRole('button', { name: '登出' }).click();
    await expect(page).toHaveURL(/\/dashboard\/login$/);

    const left = await page.evaluate(() => ['om_api_key', 'om_role', 'om_user_id', 'om_user_name',
      'ownmind.api_key'].filter((k) => localStorage.getItem(k) !== null));
    expect(left).toEqual([]);
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
