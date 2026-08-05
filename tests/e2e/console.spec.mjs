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
import {
  ACCOUNTS, LOCKED_SUPER_ADMIN, E2E_SETUP_TOKEN, SEEDED_USER_COUNT,
} from './harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const zh = JSON.parse(readFileSync(join(repoRoot, 'client/src/i18n/zh.json'), 'utf8'));

const base = () => process.env.E2E_BASE_URL;
const url = (path) => `${base()}${path}`;

// v1.26.60: this file used to derive a SIGNPOST subject from the manifest, because three
// specs drove the "this feature still lives in /admin" page and the credential handoff
// behind it. `signpost` is no longer a legal manifest state and the page is deleted, so
// those specs went with it. What replaced them is the block that asserts /admin redirects,
// which used to be their mutually-exclusive mirror and is now simply the behaviour.

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
  // Matched on visible text rather than the accessible name. It mattered while items
  // could carry a signpost marker whose aria-label made the accessible name compound;
  // `getByRole('link', { name, exact: true })` then reported 0 for an item plainly on
  // screen, which made every `toHaveCount(0)` below pass for the wrong reason. Kept
  // because visible text is what the requirement is actually about.
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
    // And their own pages are there. 週報月報 joined them in v1.26.59: it is personal by
    // nature (GET /api/session/report filters WHERE user_id = $1) and sat at admin only
    // while it was a signpost into a console that refuses a member at login — a signpost
    // to a door that will not open is worse than none. The real page has no such problem.
    for (const label of ['用量分析', '專案歷程', '工作交接', '回報紀錄', '整體分析', '踩坑紀錄',
      '週報月報']) {
      await expect(navItem(page, label)).toHaveCount(1);
    }
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

test.describe('the legacy console is retired', () => {
  // Was the mirror of a `signposts` block that ran while something still lived in /admin.
  // v1.26.60 deleted that block along with the feature, so this is now unconditional.

  test('/admin/ redirects to the console instead of serving the old one', async ({ page }) => {
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/admin/'));

    // Followed the redirect out of /admin entirely.
    await expect(page).not.toHaveURL(/\/admin\/?$/);
    await expect(page).toHaveURL(/\/dashboard\//);
    // The old console's markup must be gone, not merely hidden.
    await expect(page.locator('[data-tab="users"]')).toHaveCount(0);
  });

  test('a path below /admin redirects too, not just the directory', async ({ page }) => {
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/admin/anything/deeper'));
    await expect(page).toHaveURL(/\/dashboard\//);
  });

  test('the sidebar offers only real pages, and never mentions the old console', async ({ page }) => {
    // "Every nav item has a page" is asserted against the source in
    // tests/console-nav-structure.test.js, which is where it belongs — walking all
    // seventeen routes in a browser tripled this suite's wall clock and destabilised
    // the timing-sensitive specs around it. What is left here is the part only a browser
    // can answer: the rendered sidebar names no feature as living somewhere else.
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/dashboard/portal/usage'));
    const aside = page.locator('aside');
    await expect(aside.locator('a')).toHaveCount(17);
    await expect(aside.getByText('舊後台')).toHaveCount(0);
    await expect(page.getByText(/^Route not wired:/)).toHaveCount(0);
  });
});

test.describe('v1.26.59 sole-admin recovery, now that /admin/ is gone', () => {
  // The path scripts/reset-admin-password.js documents. Its last step used to be the
  // legacy console's setup form, and this release stops serving it. Driven for real
  // rather than asserted at the source, because "a locked-out super_admin can get back
  // in" is the kind of claim that is worthless unless something actually did it.
  //
  // Runs last in file order on purpose: it sets the account's password, so the NULL
  // state it depends on exists only once per stack.
  test('a locked-out super_admin sets a new password and signs in', async ({ page }) => {
    const newPassword = 'e2e-recovered-pass';

    await page.goto(url('/dashboard/login'));
    await page.locator('input[type=email]').fill(LOCKED_SUPER_ADMIN.email);
    await page.locator('input[type=password]').fill('anything-at-all');
    await page.locator('button[type=submit]').click();

    // The server recognised the state instead of answering "contact your administrator",
    // which for a sole super_admin names nobody.
    await expect(page.locator('form[name=setup]')).toBeVisible();

    await page.locator('input[type=text]').fill(E2E_SETUP_TOKEN);
    await page.locator('input[type=password]').first().fill(newPassword);
    await page.locator('input[type=password]').nth(1).fill(newPassword);
    await page.locator('form[name=setup] button[type=submit]').click();

    // Back to the ordinary login, not signed in from the setup form.
    await expect(page.locator('form[name=login]')).toBeVisible();
    await expect(page.getByRole('status')).toBeVisible();

    await page.locator('input[type=email]').fill(LOCKED_SUPER_ADMIN.email);
    await page.locator('input[type=password]').fill(newPassword);
    await page.locator('button[type=submit]').click();
    await expect(page).toHaveURL(/\/dashboard\/portal\/usage$/);
  });

  test('a wrong setup token is refused', async ({ page, request }) => {
    // The form is a convenience; the endpoint is the gate. Checked directly so the
    // assertion does not depend on the browser having reached the right screen.
    const r = await request.post(url('/api/admin/setup'), {
      data: { email: ACCOUNTS.superAdmin.email, setup_token: 'wrong', password: 'whatever-8' },
    });
    expect(r.status()).toBe(403);
    void page;
  });

  test('an account that already has a password is never offered the form', async ({ page }) => {
    await page.goto(url('/dashboard/login'));
    await page.locator('input[type=email]').fill(ACCOUNTS.superAdmin.email);
    await page.locator('input[type=password]').fill('definitely-wrong');
    await page.locator('button[type=submit]').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('form[name=setup]')).toHaveCount(0);
  });
});

test.describe('v1.26.59 週報月報', () => {
  test('a plain member reaches their own report', async ({ page }) => {
    // It sat behind an admin guard from v1.26.46 only because the signpost pointed at
    // a console that refuses a member at login. The data was always personal.
    await login(page, ACCOUNTS.user);
    await page.goto(url('/dashboard/portal/periodic-reports'));
    await expect(page).toHaveURL(/\/dashboard\/portal\/periodic-reports$/);
    await expect(pageHeading(page, '週報月報')).toBeVisible();
  });

  test('all three cards render, including the one that never had a query', async ({ page }) => {
    await login(page, ACCOUNTS.user);
    await page.goto(url('/dashboard/portal/periodic-reports'));

    for (const label of ['新增記憶', '自動建立 Friction Issue', '自動建立 Suggestion Action']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    // The defect: suggestion_actions_created was never emitted, so this card read the
    // absent-data placeholder on every request. A seeded account has no auto-created
    // memories, so the honest value now is a real 0 — the point is that it is a number
    // the server measured, not a dash standing in for a query nobody wrote.
    const card = page.locator('[data-card="suggestion_actions_created"]');
    await expect(card).toBeVisible();
    await expect(card.getByText('尚無資料')).toHaveCount(0);
    await expect(card.locator('.tabular-nums')).toHaveText(/^\d+$/);

    // And the two created-counts say which period they describe. The job runs Monday
    // over the previous week, so without this line the number reads as "your friction
    // this period produced N issues", which is not what it counts.
    await expect(page.getByText(/系統是每週一凌晨回頭整理上一週/)).toBeVisible();
  });

  test('an empty list says which kind of empty it is', async ({ page }) => {
    await login(page, ACCOUNTS.user);
    await page.goto(url('/dashboard/portal/periodic-reports'));

    // A seeded account logs no sessions, so both lists must name that cause rather
    // than printing the legacy 本期無 friction 資料 for all four situations.
    await expect(page.getByText('這段期間沒有任何工作紀錄').first()).toBeVisible();
    await expect(page.getByText('本期無 friction 資料')).toHaveCount(0);
  });

  test('a populated list renders its rows with counts', async ({ page }) => {
    // The super_admin has three seeded sessions carrying the same friction text, so
    // this exercises the branch the other specs cannot: rows, not an empty state.
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/dashboard/portal/periodic-reports'));

    await expect(page.getByText('e2e friction: SSH kept timing out')).toBeVisible();
    await expect(page.getByText('e2e suggestion: retry with backoff')).toBeVisible();
    await expect(page.getByText('3x').first()).toBeVisible();
    // And with rows present, none of the four empty sentences may appear.
    await expect(page.getByText('這段期間沒有任何工作紀錄')).toHaveCount(0);
  });

  test('clicking a row opens the memory search, as the legacy tab did', async ({ page }) => {
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/dashboard/portal/periodic-reports'));

    await page.getByText('e2e friction: SSH kept timing out').click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    // Names which list it came from, and shows the term it actually searched — the
    // legacy modal truncated to 30 characters and so does this one.
    await expect(modal.getByText('相關記憶（卡關）')).toBeVisible();
    // Truncated to 30 characters, as the legacy modal was: the tail is absent.
    const shown = await modal.getByText(/^搜尋關鍵字：/).textContent();
    expect(shown).toContain('e2e friction: SSH kept timing');
    expect(shown).not.toContain('timing out');
    // A matching memory is seeded, so this covers the branch that renders results
    // rather than only the empty state. The production check on 2026-08-05 could not
    // reach it: no real friction line happened to match a memory there.
    await expect(modal.getByText('沒有找到相關的記憶')).toHaveCount(0);
    await expect(modal.locator('li')).toHaveCount(1);
    await expect(modal.locator('li').first()).toContainText('e2e friction: SSH kept timing out');
    // The type badge and date come from the same row; a shape change in
    // /api/memory/search must fail here rather than render blanks.
    await expect(modal.locator('li').first()).toContainText('project');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a row with no matching memory says so rather than showing an empty box', async ({ page }) => {
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/dashboard/portal/periodic-reports'));

    // The suggestion text has no seeded counterpart, so this is the other branch.
    await page.getByText('e2e suggestion: retry with backoff').click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText('相關記憶（建議）')).toBeVisible();
    await expect(modal.getByText('沒有找到相關的記憶')).toBeVisible();
  });

  test('the previous period is cleared the moment the selection changes', async ({ page }) => {
    // The other half of the staleness problem, and the one the request gate does not
    // solve: while the refetch is in flight the selects have already moved, so leaving
    // the old cards up puts one period's figures under another period's controls.
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/dashboard/portal/periodic-reports'));
    await expect(page.locator('[data-card="new_memories"]')).toBeVisible();

    // Installed after the first load, so there is something on screen to go stale.
    await page.route('**/api/session/report**', async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });

    await page.selectOption('#periodic-period', 'month');
    // Well inside the 3s hold, so this is asserting the in-flight window itself.
    await expect(page.locator('[data-card="new_memories"]')).toHaveCount(0, { timeout: 1500 });
    await expect(page.getByText('e2e friction: SSH kept timing out')).toHaveCount(0);
  });

  test('a slow response for an abandoned period cannot overwrite the current one', async ({ page }) => {
    await login(page, ACCOUNTS.user);
    await page.goto(url('/dashboard/portal/periodic-reports'));

    // Make the weekly request slow and the monthly one fast, so the abandoned reply
    // is guaranteed to land after the wanted one. Without the request gate the late
    // week payload overwrites the month report and the page shows one period's
    // numbers under the other's label — the v1.26.56 Critical, third occurrence.
    await page.route('**/api/session/report**', async (route) => {
      if (route.request().url().includes('period=week')) {
        await new Promise((r) => setTimeout(r, 4000));
      }
      await route.continue();
    });

    // Kick off the slow weekly request, then switch away before it can land.
    await page.selectOption('#periodic-offset', '1');
    await page.selectOption('#periodic-period', 'month');

    const label = page.locator('[data-period-label]');
    // The monthly reply is not delayed, so it settles well inside this.
    await expect(label).toHaveText(/\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/, { timeout: 3000 });
    const settled = await label.textContent();

    // Now outlive the abandoned weekly response and confirm nothing rewrote the page.
    await page.waitForTimeout(4000);
    expect(await label.textContent()).toBe(settled);
    await expect(page.locator('#periodic-period')).toHaveValue('month');
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

});

test.describe('v1.26.58 team usage', () => {
  // The harness seeds three accounts, one session_log for the admin and no
  // token_usage_daily rows at all, which is precisely the state that made the
  // legacy page misleading: three members it had no data for, rendered as
  // `0 tokens / 0 次對話 / $0.0000`.

  test('members with no usage data are marked, not shown as zero', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/usage'));
    await expect(pageHeading(page, '團隊用量')).toBeVisible();

    const header = page.getByRole('row').first();
    for (const col of ['成員', '最近活動', '對話場次', '最常做的專案', '鐵律遵守率',
      '用量', '訊息', '活躍時長']) {
      await expect(header.getByText(col, { exact: true })).toBeVisible();
    }

    // All three seeded members lack usage rows, so all three carry the badge.
    // Scoped to the table: the coverage panel above names the same members, and
    // getByText matches substrings, so a page-wide count reads one too many.
    const table = page.getByRole('table').first();
    await expect(table.getByText(zh['team_usage.badge.unmeasured'])).toHaveCount(SEEDED_USER_COUNT);
    // And no cell in the table invented a zero for them.
    await expect(table.getByText('0', { exact: true })).toHaveCount(0);
  });

  test('the seeded session still fills the activity columns', async ({ page }) => {
    // The other half of the requirement: only what is genuinely missing may read
    // as missing. The admin has one logged conversation, so their row must show
    // it rather than joining the members with nothing.
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/usage'));
    const row = page.getByRole('row').filter({ hasText: ACCOUNTS.admin.name });
    await expect(row.getByText('e2e-project')).toBeVisible();
  });

  test('no cost is displayed anywhere on the page', async ({ page }) => {
    // Requirement 8. The endpoint still answers with cost_usd; nothing here may
    // render it, and the legacy sort-by-cost option is gone with it.
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/usage'));
    await expect(pageHeading(page, '團隊用量')).toBeVisible();

    // `USD` deliberately not in the pattern: it matches member names and emails
    // as readily as it matches a currency, and a spec that fails because someone
    // is called usd@example.com teaches the reader to ignore it. A rendered cost
    // in this codebase is `$` or the word 成本, both of which appear nowhere else
    // on the page.
    const body = await page.locator('main').innerText();
    expect(body).not.toMatch(/\$|成本/);
    expect(await page.locator('#team-sort option').allInnerTexts())
      .toEqual(['依用量', '依訊息數', '依活躍時長']);
  });

  test('the coverage panel states its denominator and says who is missing', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/usage'));
    await expect(page.getByText(`全隊 ${SEEDED_USER_COUNT} 人`)).toBeVisible();
    // None of them measured, which is well under the four-fifths mark.
    await expect(page.getByText(/只涵蓋 0%/)).toBeVisible();
    // Named, not just counted: a number alone cannot be chased up.
    await expect(page.getByText(new RegExp(`沒有資料：.*${ACCOUNTS.admin.name}`))).toBeVisible();
  });

  test('clicking a member opens the drill-down against the same window', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/usage'));
    await page.getByRole('row').filter({ hasText: ACCOUNTS.admin.name }).click();

    await expect(page.getByText(`成員明細：${ACCOUNTS.admin.name}`)).toBeVisible();
    expect(await page.locator('#detail-group option').allInnerTexts())
      .toEqual(['按日', '按工具', '按模型', '按對話']);
    // No usage rows seeded, so every card reads as absent rather than as 0.
    await expect(page.getByText(zh['team_usage.no_data']).first()).toBeVisible();

    // The conversation list is loaded with the detail; the toggle only shows it.
    await page.getByRole('button', { name: /最近對話/ }).click();
    await expect(page.getByText('e2e orphan session')).toBeVisible();
  });

  test('opening a member on a reversed range says so instead of spinning', async ({ page }) => {
    // Found in review. The ranking keeps rendering its last good payload while
    // the dates are reversed, so there is still a row to click; the drill-down
    // then mounted with `loading` true and returned early without clearing it.
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/usage'));
    await page.locator('#team-from').fill('2026-08-10');
    await page.locator('#team-to').fill('2026-08-01');
    await page.getByRole('row').filter({ hasText: ACCOUNTS.admin.name }).click();

    await expect(page.getByText(zh['team_usage.filter.reversed']).nth(1)).toBeVisible();
    await expect(page.getByText(zh['team_usage.loading'])).toHaveCount(0);
  });

  test('switching member does not leave the previous one\'s numbers on screen', async ({ page }) => {
    // Found in review, and the same defect the stats page shipped with: the
    // heading switches immediately while the cards below still hold the previous
    // member, so one person's numbers appear under another person's name.
    await login(page, ACCOUNTS.admin);
    await page.goto(url('/dashboard/team/usage'));

    await page.getByRole('row').filter({ hasText: ACCOUNTS.admin.name }).click();
    await expect(page.getByText(`成員明細：${ACCOUNTS.admin.name}`)).toBeVisible();
    await page.getByRole('button', { name: /最近對話/ }).click();
    await expect(page.getByText('e2e orphan session')).toBeVisible();

    // The defect only exists while the second member's requests are in flight,
    // and against a local server that window is a few milliseconds — short
    // enough that a retrying assertion sails past it and the spec passes with
    // the fix removed, which is what the first draft of this test did. Holding
    // the responses open makes the window observable; the assertion window is
    // deliberately shorter than the delay, so a stale render cannot outwait it.
    await page.route('**/api/usage/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

    // The other member has no sessions at all, so the admin's conversation must
    // be gone the moment the heading changes, not once the refetch returns.
    await page.getByRole('row').filter({ hasText: ACCOUNTS.user.name }).click();
    await expect(page.getByText(`成員明細：${ACCOUNTS.user.name}`)).toBeVisible();
    await expect(page.getByText('e2e orphan session')).toHaveCount(0, { timeout: 1000 });
    await page.unroute('**/api/usage/**');
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

test.describe('the console shell', () => {
  test('the console shell still resolves at depth, so deep links are not blank', async ({ page }) => {
    // v1.26.44's base-href rewrite. A regression here renders every route deeper than one
    // segment as a white page, which no source-level test would catch.
    await login(page, ACCOUNTS.superAdmin);
    await page.goto(url('/dashboard/system/config'));
    await expect(pageHeading(page, '系統設定')).toBeVisible();
  });
});
