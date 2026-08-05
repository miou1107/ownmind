/**
 * v1.26.49 — visibleMenuItems() encodes Requirement 4 of the team-management page.
 *
 * The row's action dropdown always exposes four items, but items 3 (修改密碼) and
 * 4 (刪除使用者) are conditionally rendered per the same rules the server enforces
 * — no point offering a button the server would reject. Extracted from the page
 * component so the predicates can be tested without React.
 *
 * See openspec/changes/archive/v1.26.49-team-management-page/spec.md Requirement 4.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { visibleMenuItems } from '../client/src/pages/Admin/menu-visibility.js';

const ITEMS = ['install-prompt', 'edit', 'password', 'delete'];

// Fixed cast for readability. Actor is who's clicking; row is whose menu is being opened.
const SUPER = { id: 1, role: 'super_admin' };
const ADMIN = { id: 2, role: 'admin' };
const MEMBER = { id: 3, role: 'user' };

describe('visibleMenuItems — always emits four IDs in the fixed order', () => {
  it('never returns an item outside the allowed set', () => {
    for (const actor of [SUPER, ADMIN, MEMBER]) {
      for (const row of [SUPER, ADMIN, MEMBER]) {
        const out = visibleMenuItems(actor, row);
        for (const id of out) {
          assert.ok(ITEMS.includes(id), `unknown menu id "${id}" for ${actor.role} viewing ${row.role}`);
        }
      }
    }
  });

  it('items 1 and 2 (install-prompt, edit) are always visible', () => {
    for (const actor of [SUPER, ADMIN, MEMBER]) {
      for (const row of [SUPER, ADMIN, MEMBER]) {
        const out = visibleMenuItems(actor, row);
        assert.ok(out.includes('install-prompt'),
          `install-prompt missing for ${actor.role} viewing ${row.role}`);
        assert.ok(out.includes('edit'),
          `edit missing for ${actor.role} viewing ${row.role}`);
      }
    }
  });

  it('order is stable regardless of visibility', () => {
    // If both password and delete are visible, they must appear after edit,
    // and delete must be last so it can be visually separated from safe actions.
    const out = visibleMenuItems(SUPER, ADMIN);
    const idx = (id) => out.indexOf(id);
    assert.ok(idx('install-prompt') < idx('edit'));
    assert.ok(idx('edit') < idx('password'));
    assert.ok(idx('password') < idx('delete'));
  });
});

describe('visibleMenuItems — password (item 3) visibility', () => {
  it('self can change own password whatever the role', () => {
    for (const actor of [SUPER, ADMIN, MEMBER]) {
      const out = visibleMenuItems(actor, actor);
      assert.ok(out.includes('password'), `self should see password for ${actor.role}`);
    }
  });

  it('super_admin can reset non-user roles (admin, super_admin)', () => {
    assert.ok(visibleMenuItems(SUPER, ADMIN).includes('password'));
    assert.ok(visibleMenuItems(SUPER, { id: 99, role: 'super_admin' }).includes('password'));
  });

  it('super_admin cannot reset a plain user via the password modal', () => {
    // Per legacy behaviour and Requirement 4: password modal is for admin+ resets
    // and self-changes. User-role passwords are managed by the user themselves; a
    // super_admin who needs to help a user through a password issue uses the
    // add-user default_password flow (create fresh) or the emergency endpoint
    // (unsurfaced this stage). This mirrors legacy/admin-v1.26/index.html:1250.
    assert.equal(visibleMenuItems(SUPER, MEMBER).includes('password'), false);
  });

  it('admin viewing another admin sees no password item', () => {
    // Only super_admin can reset others; an admin acting on a peer admin is blocked
    // by the server (:345-357), so the button would fail even if shown.
    assert.equal(visibleMenuItems(ADMIN, { id: 99, role: 'admin' }).includes('password'), false);
  });
});

describe('visibleMenuItems — delete (item 4) visibility', () => {
  it('only super_admin can delete', () => {
    for (const actor of [ADMIN, MEMBER]) {
      for (const row of [SUPER, ADMIN, MEMBER]) {
        if (row.id === actor.id) continue;
        assert.equal(visibleMenuItems(actor, row).includes('delete'), false,
          `non-super ${actor.role} must not see delete on ${row.role}`);
      }
    }
  });

  it('super_admin cannot delete themselves', () => {
    assert.equal(visibleMenuItems(SUPER, SUPER).includes('delete'), false);
  });

  it('super_admin cannot delete id=1 (root super_admin)', () => {
    // The seed super_admin at id=1 is what the recovery script targets
    // (scripts/reset-admin-password.js), so its deletion would leave no way in.
    // Server blocks it too (:281-283); belt and suspenders in the UI.
    const otherSuper = { id: 99, role: 'super_admin' };
    assert.equal(visibleMenuItems(otherSuper, { id: 1, role: 'super_admin' }).includes('delete'), false);
  });

  it('super_admin can delete anyone else', () => {
    assert.ok(visibleMenuItems(SUPER, ADMIN).includes('delete'));
    assert.ok(visibleMenuItems(SUPER, MEMBER).includes('delete'));
    assert.ok(visibleMenuItems(SUPER, { id: 99, role: 'super_admin' }).includes('delete'));
  });
});

describe('visibleMenuItems — combined scenarios from spec', () => {
  it('super_admin viewing another admin: all four visible', () => {
    assert.deepEqual(
      visibleMenuItems(SUPER, ADMIN),
      ['install-prompt', 'edit', 'password', 'delete'],
    );
  });

  it('admin viewing self: items 1, 2, 3 visible; item 4 not', () => {
    assert.deepEqual(
      visibleMenuItems(ADMIN, ADMIN),
      ['install-prompt', 'edit', 'password'],
    );
  });

  it('admin viewing a super_admin: items 1, 2 visible; items 3, 4 not', () => {
    assert.deepEqual(
      visibleMenuItems(ADMIN, SUPER),
      ['install-prompt', 'edit'],
    );
  });
});
