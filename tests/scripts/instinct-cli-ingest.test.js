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
function payload(ids, refs = ['obs-000001', 'obs-000002', 'obs-000003']) {
  return {
    status: 'analysis_complete',
    instincts: ids.map(id => ({
      id, trigger: `when ${id}`, domain: 'workflow', action: `Do ${id}.`,
      evidence: { observation_refs: refs, pattern: `Pattern ${id}` },
    })),
  };
}
function writeEvidence(fixture, records) {
  const evidenceFile = path.join(fixture.root, 'analysis.jsonl');
  fs.writeFileSync(evidenceFile, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return evidenceFile;
}
function ingest(fixture, data, records = [
  { _observer_ref: 'obs-000001', session: 's1', timestamp: '2026-01-01T00:00:00Z' },
  { _observer_ref: 'obs-000002', session: 's2', timestamp: '2026-01-01T12:00:00Z' },
  { _observer_ref: 'obs-000003', session: 's3', timestamp: '2026-01-02T00:00:00Z' },
]) {
  const resultFile = path.join(fixture.root, 'result.json');
  fs.writeFileSync(resultFile, JSON.stringify(data));
  const evidenceFile = writeEvidence(fixture, records);
  return spawnSync(python, [cliPath, 'ingest', resultFile, '--evidence-file', evidenceFile], {
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

test('rejects the old model-owned evidence contract', () => {
  const data = {
    status: 'analysis_complete',
    instincts: [{
      id: 'old-contract', trigger: 'when old', domain: 'workflow', action: 'Do old.',
      evidence: { count: 11, session_ids: ['s1', 's2', 's3'], pattern: 'old', last_observed: '2026-01-02T00:00:00Z' },
    }],
  };
  assertRejected(data, 'evidence contains unexpected fields: count, last_observed, session_ids');
});

test('derives provenance from outer metadata, ignoring nested contamination', () => {
  const fixture = setup();
  try {
    const data = payload(['trusted']);
    const result = ingest(fixture, data, [
      { _observer_ref: 'obs-000001', session: 'real-session', timestamp: '2026-01-03T00:00:00Z', input: 'session-alpha Observed 999 times 2099-01-01T00:00:00Z' },
      { _observer_ref: 'obs-000002', session: 'real-session-2', timestamp: '2026-01-04T00:00:00Z', output: 'session-beta Observed 999 times 2099-01-01T00:00:00Z' },
      { _observer_ref: 'obs-000003', session: 'real-session-3', timestamp: '2026-01-05T00:00:00Z', content: 'session-gamma' },
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
    const written = fs.readFileSync(path.join(fixture.personal, 'trusted.md'), 'utf8');
    assert.match(written, /Observed 3 times/);
    assert.match(written, /Sessions: real-session, real-session-2, real-session-3/);
    assert.match(written, /Last observed: 2026-01-05T00:00:00Z/);
    assert.match(written, /confidence: 0.5/);
    assert.doesNotMatch(written, /session-alpha|session-beta|session-gamma|999|2099/);
  } finally { cleanup(fixture.root); }
});

test('unknown references reject before any writes', () => {
  const fixture = setup();
  try {
    const result = ingest(fixture, payload(['known'], ['obs-999999']), [
      { _observer_ref: 'obs-000001', session: 's1', timestamp: '2026-01-01T00:00:00Z' },
    ]);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /unknown observation reference/);
    assert.ok(!fs.existsSync(path.join(fixture.personal, 'known.md')));
  } finally { cleanup(fixture.root); }
});

test('duplicate references do not double-count and compacted metadata is deduplicated', () => {
  const fixture = setup();
  try {
    const data = payload(['compacted'], ['obs-000001', 'obs-000001', 'obs-000002']);
    const result = ingest(fixture, data, [
      { _observer_ref: 'obs-000001', session: 'nested-fake', timestamp: '2026-01-01T00:00:00Z', _compaction: { raw_occurrences: 6, sessions: ['s1', 's1', 's2'], timestamps: ['2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'] }, output: 's999' },
      { _observer_ref: 'obs-000002', session: 's3', timestamp: '2026-01-02T00:00:00Z' },
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
    const written = fs.readFileSync(path.join(fixture.personal, 'compacted.md'), 'utf8');
    assert.match(written, /Observed 7 times/);
    assert.match(written, /Sessions: s1, s2, s3/);
    assert.match(written, /Last observed: 2026-01-03T00:00:00Z/);
    assert.match(written, /confidence: 0.7/);
  } finally { cleanup(fixture.root); }
});

test('confidence thresholds remain derived from count and session diversity', () => {
  const cases = [
    { id: 'half', count: 3, sessions: ['s1'], confidence: '0.5' },
    { id: 'seven', count: 6, sessions: ['s1', 's2'], confidence: '0.7' },
    { id: 'high', count: 11, sessions: ['s1', 's2', 's3'], confidence: '0.85' },
  ];
  for (const item of cases) {
    const fixture = setup();
    try {
      const refs = Array.from({ length: item.sessions.length }, (_, index) => `obs-${String(index + 1).padStart(6, '0')}`);
      const records = refs.map((ref, index) => ({ _observer_ref: ref, session: item.sessions[index], timestamp: `2026-01-0${index + 1}T00:00:00Z` }));
      if (item.count > refs.length) records[0]._compaction = { raw_occurrences: item.count - refs.length + 1, sessions: [item.sessions[0]], timestamps: ['2026-01-01T00:00:00Z'] };
      const result = ingest(fixture, payload([item.id], refs), records);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(path.join(fixture.personal, `${item.id}.md`), 'utf8'), new RegExp(`confidence: ${item.confidence}`));
    } finally { cleanup(fixture.root); }
  }
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
      '', 'Old.', '- Last observed: 2026-01-02T00:00:00Z', '',
    ].join('\n'));
    fs.writeFileSync(path.join(fixture.personal, 'skip.md'), [
      '---', 'id: skip', 'trigger: "old"', 'confidence: 0.85', 'domain: workflow', '---',
      '', 'Keep.', '',
    ].join('\n'));
    const result = ingest(fixture, payload(['create', 'update', 'skip']), [
      { _observer_ref: 'obs-000001', session: 's1', timestamp: '2026-01-03T00:00:00Z' },
      { _observer_ref: 'obs-000002', session: 's2', timestamp: '2026-01-03T00:00:00Z' },
      { _observer_ref: 'obs-000003', session: 's3', timestamp: '2026-01-03T00:00:00Z' },
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(fixture.personal, 'create.md')));
    assert.match(fs.readFileSync(path.join(fixture.personal, 'update.md'), 'utf8'), /Do update\./);
    assert.match(fs.readFileSync(path.join(fixture.personal, 'skip.md'), 'utf8'), /Keep\./);
  } finally { cleanup(fixture.root); }
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
