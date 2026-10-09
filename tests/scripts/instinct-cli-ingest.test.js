const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(repoRoot, 'skills', 'continuous-learning-v2', 'scripts', 'instinct-cli.py');
const python = process.env.PYTHON3 || 'python3';
let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (error) { console.log(`  ✗ ${name}\n    Error: ${error.message}`); failed += 1; }
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-instinct-ingest-')); }
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function projectHash(value) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}
function setup() {
  const root = tempDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(repo, ['init']);
  const id = projectHash(runGit(repo, ['rev-parse', '--show-toplevel']));
  const personal = path.join(root, 'projects', id, 'instincts', 'personal');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({
    [id]: { name: 'test-project', root: repo, remote: '', last_seen: '2026-01-01T00:00:00Z' },
  }));
  return { root, repo, personal };
}
function payload(ids, count = 11) {
  return {
    status: 'analysis_complete',
    instincts: ids.map(id => ({
      id, trigger: `when ${id}`, domain: 'workflow', action: `Do ${id}.`,
      evidence: { count, pattern: `Pattern ${id}`, last_observed: '2026-01-02T00:00:00Z', session_ids: ['s1'] },
    })),
  };
}
function ingest(fixture, data) {
  const resultFile = path.join(fixture.root, 'result.json');
  fs.writeFileSync(resultFile, JSON.stringify(data));
  return spawnSync(python, [cliPath, 'ingest', resultFile], {
    cwd: fixture.repo, encoding: 'utf8',
    env: { ...process.env, CLV2_HOMUNCULUS_DIR: fixture.root },
  });
}
function assertRejected(data, message) {
  const fixture = setup();
  try {
    const result = ingest(fixture, data);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(message));
  } finally { cleanup(fixture.root); }
}

console.log('\n=== Testing instinct-cli.py ingest ===\n');

test('rejects unexpected top-level fields', () => {
  const data = payload(['top-level']);
  data.extra = true;
  assertRejected(data, 'payload contains unexpected fields: extra');
});

test('rejects unexpected instinct fields', () => {
  const data = payload(['instinct-extra']);
  data.instincts[0].extra = true;
  assertRejected(data, 'instinct\\[0\\] contains unexpected fields: extra');
});

test('rejects unexpected evidence fields', () => {
  const data = payload(['evidence-extra']);
  data.instincts[0].evidence.extra = true;
  assertRejected(data, 'instinct\\[0\\]\\.evidence contains unexpected fields: extra');
});

test('preflight failure prevents earlier instincts from being written', () => {
  const fixture = setup();
  try {
    fs.mkdirSync(path.join(fixture.personal, 'later.md'));
    const result = ingest(fixture, payload(['first', 'later']));
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /ingest target is not a file/);
    assert.ok(!fs.existsSync(path.join(fixture.personal, 'first.md')));
  } finally { cleanup(fixture.root); }
});

test('successful multi-instinct batch creates all targets', () => {
  const fixture = setup();
  try {
    const result = ingest(fixture, payload(['one', 'two']));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(fixture.personal, 'one.md')));
    assert.ok(fs.existsSync(path.join(fixture.personal, 'two.md')));
  } finally { cleanup(fixture.root); }
});

test('create, update, and skip decisions remain intact', () => {
  const fixture = setup();
  try {
    fs.writeFileSync(path.join(fixture.personal, 'update.md'), [
      '---', 'id: update', 'trigger: "old"', 'confidence: 0.5', 'domain: workflow', '---',
      '', 'Old.', '',
    ].join('\n'));
    fs.writeFileSync(path.join(fixture.personal, 'skip.md'), [
      '---', 'id: skip', 'trigger: "old"', 'confidence: 0.85', 'domain: workflow', '---',
      '', 'Keep.', '',
    ].join('\n'));
    const result = ingest(fixture, payload(['create', 'update', 'skip']));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(fixture.personal, 'create.md')));
    assert.match(fs.readFileSync(path.join(fixture.personal, 'update.md'), 'utf8'), /Do update\./);
    assert.match(fs.readFileSync(path.join(fixture.personal, 'skip.md'), 'utf8'), /Keep\./);
  } finally { cleanup(fixture.root); }
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
