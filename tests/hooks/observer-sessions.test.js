const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listSessionLeases,
  hasActiveSessionLeases
} = require('../../scripts/lib/observer-sessions');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-leases-'));
const context = { projectDir: root };
const leaseDir = path.join(root, '.observer-sessions');
fs.mkdirSync(leaseDir);

function write(name, value) {
  fs.writeFileSync(path.join(leaseDir, `${name}.json`), value);
}

try {
  write('dead', JSON.stringify({ pid: 2147483647 }));
  write('malformed', '{not json');
  write('invalid', JSON.stringify({ pid: 1 }));
  assert.strictEqual(hasActiveSessionLeases(context), false, 'dead and invalid leases are inactive');
  assert.strictEqual(fs.readdirSync(leaseDir).length, 0, 'stale leases are pruned');

  write('live', JSON.stringify({ pid: process.pid }));
  assert.strictEqual(listSessionLeases(context).length, 1, 'a live PID lease remains active');

  write('dead-again', JSON.stringify({ pid: 2147483647 }));
  assert.strictEqual(hasActiveSessionLeases(context), true, 'a live lease keeps observer active with stale leases');
  fs.rmSync(path.join(leaseDir, 'live.json'));
  assert.strictEqual(hasActiveSessionLeases(context), false, 'only stale leases do not block shutdown');
  console.log('✓ observer session leases validate JSON and owning process state');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
