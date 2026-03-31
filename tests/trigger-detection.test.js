import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectCommandTrigger, detectTriggerFromContext } from '../shared/helpers.js';

describe('detectCommandTrigger', () => {
  // commit triggers
  it('git commit → commit', () => {
    assert.equal(detectCommandTrigger('git commit -m "feat: add feature"'), 'commit');
  });
  it('git reset → commit', () => {
    assert.equal(detectCommandTrigger('git reset --hard HEAD~1'), 'commit');
  });
  it('git rebase → commit', () => {
    assert.equal(detectCommandTrigger('git rebase main'), 'commit');
  });
  it('git merge → commit', () => {
    assert.equal(detectCommandTrigger('git merge feature-branch'), 'commit');
  });
  it('git tag → commit', () => {
    assert.equal(detectCommandTrigger('git tag v1.0.0'), 'commit');
  });

  // deploy triggers
  it('git push → deploy', () => {
    assert.equal(detectCommandTrigger('git push origin main'), 'deploy');
  });
  it('docker compose up → deploy', () => {
    assert.equal(detectCommandTrigger('docker compose up -d'), 'deploy');
  });
  it('docker compose build → deploy', () => {
    assert.equal(detectCommandTrigger('docker compose build --no-cache'), 'deploy');
  });
  it('kubectl apply → deploy', () => {
    assert.equal(detectCommandTrigger('kubectl apply -f deployment.yaml'), 'deploy');
  });
  it('npm run deploy → deploy', () => {
    assert.equal(detectCommandTrigger('npm run deploy'), 'deploy');
  });

  // delete triggers
  it('rm -rf → delete', () => {
    assert.equal(detectCommandTrigger('rm -rf /tmp/old-data'), 'delete');
  });
  it('rmdir → delete', () => {
    assert.equal(detectCommandTrigger('rmdir /s /q old-folder'), 'delete');
  });
  it('Remove-Item → delete', () => {
    assert.equal(detectCommandTrigger('Remove-Item -Recurse ./old'), 'delete');
  });
  it('DROP TABLE → delete', () => {
    assert.equal(detectCommandTrigger('psql -c "DROP TABLE users"'), 'delete');
  });
  it('DELETE FROM → delete', () => {
    assert.equal(detectCommandTrigger('mysql -e "DELETE FROM sessions"'), 'delete');
  });

  // no trigger
  it('git status → null', () => {
    assert.equal(detectCommandTrigger('git status'), null);
  });
  it('git log → null', () => {
    assert.equal(detectCommandTrigger('git log --oneline'), null);
  });
  it('npm install → null', () => {
    assert.equal(detectCommandTrigger('npm install'), null);
  });
  it('empty string → null', () => {
    assert.equal(detectCommandTrigger(''), null);
  });

  // false positive prevention
  it('echo "no commit here" → null (word boundary)', () => {
    assert.equal(detectCommandTrigger('echo "recommit the changes"'), null);
  });
  it('docker compose logs → null (not up/build/push)', () => {
    assert.equal(detectCommandTrigger('docker compose logs -f'), null);
  });
});

describe('detectTriggerFromContext', () => {
  it('context mentioning commit → commit', () => {
    assert.equal(detectTriggerFromContext('preparing to commit code'), 'commit');
  });
  it('context mentioning deploy → deploy', () => {
    assert.equal(detectTriggerFromContext('about to deploy to production'), 'deploy');
  });
  it('context mentioning 部署 → deploy', () => {
    assert.equal(detectTriggerFromContext('準備部署到伺服器'), 'deploy');
  });
  it('context mentioning delete → delete', () => {
    assert.equal(detectTriggerFromContext('will delete old records'), 'delete');
  });
  it('context mentioning 刪除 → delete', () => {
    assert.equal(detectTriggerFromContext('準備刪除舊資料'), 'delete');
  });
  it('null context → null', () => {
    assert.equal(detectTriggerFromContext(null), null);
  });
  it('unrelated context → null', () => {
    assert.equal(detectTriggerFromContext('reading the documentation'), null);
  });
});
