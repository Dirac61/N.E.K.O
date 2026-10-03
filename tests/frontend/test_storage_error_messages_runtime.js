const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const script = fs.readFileSync(path.join(root, 'static/app/app-storage-location.js'), 'utf8');
const template = fs.readFileSync(path.join(root, 'templates/memory_browser.html'), 'utf8');
assert(template.indexOf('app-storage-location.js') < template.indexOf('memory_browser.js'));

for (const locale of ['en', 'ja', 'zh-CN']) {
  const messages = JSON.parse(fs.readFileSync(path.join(root, `static/locales/${locale}.json`), 'utf8'));
  const window = {
    location: { origin: 'http://localhost' },
    addEventListener() {},
    safeT(key, fallback) {
      return key.split('.').reduce((value, part) => value && value[part], messages) || fallback;
    },
  };
  const context = vm.createContext({
    window, console,
    document: { currentScript: { getAttribute() { return 'false'; } } },
  });
  vm.runInContext(script, context);
  const format = window.appStorageLocation.formatError;
  const payload = { error_code: 'storage_policy_rollback_failed', error: '中文底层异常私有路径' };
  assert.strictEqual(format({ ...payload, phase: 'startup_release' }, 'fallback'), messages.storage.startupReleaseRollbackFailed);
  assert.strictEqual(format({ ...payload, restart_mode: 'migrate_after_shutdown' }, 'fallback'), messages.storage.restartRollbackFailed);
  assert.strictEqual(format({ ...payload, error_code: 'storage_state_invalid' }, 'fallback'), messages.storage.storageStateInvalid);
  assert.strictEqual(format({ ...payload, error_code: 'startup_release_failed' }, 'fallback'), messages.storage.startupReleaseFailed);
  assert.strictEqual(format({ ...payload, error_code: 'unknown_error' }, 'fallback'), 'fallback');
}
console.log('Storage error formatting passed for English, Japanese and Simplified Chinese.');
