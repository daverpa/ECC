/**
 * Tests for observer-loop archive-on-failure fixes (#2370, #2673).
 *
 * A batch may be archived only when the Claude process exits successfully and
 * its current stdout contains one exact completion record as the final
 * non-empty line. Process failures, semantic failures, stderr/log markers,
 * duplicate markers, and tampering with the result path must fail closed.
 *
 * Run with: node tests/hooks/observer-loop-archive.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

let passed = 0;
let failed = 0;
let skipped = 0;
const SKIP = Symbol('skip');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    if (err === SKIP) {
      console.log(`  - ${name} (skipped: requires bash fixture)`);
      skipped++;
      return;
    }
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function skipOnWindows() {
  if (process.platform === 'win32') {
    throw SKIP;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-observer-archive-'));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors in an already-isolated test directory.
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const repoRoot = path.resolve(__dirname, '..', '..');
const observerLoopPath = path.join(
  repoRoot, 'skills', 'continuous-learning-v2', 'agents', 'observer-loop.sh'
);
const observerProviderRunnerPath = path.join(
  repoRoot, 'skills', 'continuous-learning-v2', 'agents', 'observer-provider-runner.sh'
);
const startObserverPath = path.join(
  repoRoot, 'skills', 'continuous-learning-v2', 'agents', 'start-observer.sh'
);
const ANALYSIS_COMPLETE_RECORD = '{"status":"analysis_complete"}';
const ORIGINAL_OBSERVATIONS = '{"a":1}\n{"a":2}\n{"a":3}\n';
const EMPTY_CODEX_RESULT = '{"status":"analysis_complete","instincts":[]}';

/**
 * Source observer-loop.sh in a sandbox and invoke analyze_observations once.
 */
function runAnalyzeOnce(options = {}) {
  const {
    claudeExitCode = 0,
    claudeOutput = '',
    claudeStderr = '',
    claudeDelaySeconds = 0,
    claudeIgnoreTerm = false,
    claudeSpawnChild = false,
    codexExitCode = 0,
    codexWritesResult = true,
    codexModel = undefined,
    observerModel = undefined,
    ingestExitCode = 0,
    existingLog = '',
    observerTimeoutSeconds = 10,
    probeResultPath = false,
    provider = 'claude',
    captureAnalysis = false,
    observations = ORIGINAL_OBSERVATIONS,
  } = options;
  const sandbox = createTempDir();

  try {
    const binDir = path.join(sandbox, 'bin');
    const projectDir = path.join(sandbox, 'project');
    const observerFixtureDir = path.join(sandbox, 'observer');
    const scriptsFixtureDir = path.join(sandbox, 'scripts');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(observerFixtureDir, { recursive: true });
    fs.mkdirSync(scriptsFixtureDir, { recursive: true });

    const claudeStub = path.join(binDir, 'claude');
    const analysisCaptureFile = path.join(projectDir, 'analysis-capture.jsonl');
    const claudeModelFile = path.join(projectDir, 'claude-model');
    fs.writeFileSync(claudeStub, [
      '#!/usr/bin/env bash',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--model" ]; then',
      '    shift',
      '    printf "%s\\n" "${1:-}" > "$CLAUDE_MODEL_FILE"',
      '    break',
      '  fi',
      '  shift || true',
      'done',
      'if [ "${CLAUDE_STUB_CAPTURE_ANALYSIS:-false}" = "true" ]; then',
      '  for candidate in "${PROJECT_DIR}"/.observer-tmp/ecc-observer-analysis.*; do',
      '    [ -f "$candidate" ] || continue',
      '    cp "$candidate" "${CLAUDE_STUB_ANALYSIS_CAPTURE_FILE}"',
      '    break',
      '  done',
      'fi',
      "printf '%s\n' \"$$\" > \"${CLAUDE_STUB_PID_FILE}\"",
      "if [ \"${CLAUDE_STUB_IGNORE_TERM:-false}\" = \"true\" ]; then trap '' TERM; fi",
      'if [ "${CLAUDE_STUB_SPAWN_CHILD:-false}" = "true" ]; then',
      '  sleep "${CLAUDE_STUB_DELAY_SECONDS:-10}" &',
      "  printf '%s\n' \"$!\" > \"${CLAUDE_STUB_CHILD_PID_FILE}\"",
      '  wait',
      'fi',
      'if [ "${CLAUDE_STUB_PROBE_RESULT_PATH:-false}" = "true" ]; then',
      '  for candidate in "${PROJECT_DIR}"/.observer-tmp/ecc-observer-result.*; do',
      '    [ -e "$candidate" ] || [ -L "$candidate" ] || continue',
      "    printf 'found\n' > \"${CLAUDE_STUB_ATTACK_FILE}\"",
      '    rm -f "$candidate"',
      `    printf '%s\n' '${ANALYSIS_COMPLETE_RECORD}' > "$candidate"`,
      '  done',
      'fi',
      'if [ "${CLAUDE_STUB_DELAY_SECONDS:-0}" != "0" ]; then',
      '  sleep "${CLAUDE_STUB_DELAY_SECONDS}"',
      'fi',
      "printf '%s' \"${CLAUDE_STUB_OUTPUT:-}\"",
      "printf '%s' \"${CLAUDE_STUB_STDERR:-}\" >&2",
      'exit "${CLAUDE_STUB_EXIT:-0}"',
      '',
    ].join('\n'));
    fs.chmodSync(claudeStub, 0o755);

    const codexStub = path.join(binDir, 'codex');
    const codexArgsFile = path.join(projectDir, 'codex-args.json');
    fs.writeFileSync(codexStub, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const argv = process.argv.slice(2);',
      'fs.writeFileSync(process.env.CODEX_ARGS_FILE, JSON.stringify(argv));',
      'let resultPath = "";',
      'for (let index = 0; index < argv.length; index += 1) {',
      '  if (argv[index] === "-o") resultPath = argv[index + 1] || "";',
      '}',
      'if (process.env.CODEX_STUB_WRITES_RESULT !== "false" && resultPath) {',
      `  fs.writeFileSync(resultPath, '${EMPTY_CODEX_RESULT}\\n');`,
      '}',
      'if (process.env.CODEX_STUB_REPLACE_RESULT_WITH_SYMLINK === "true" && resultPath) {',
      '  fs.unlinkSync(resultPath);',
      '  fs.symlinkSync(process.env.CODEX_SYMLINK_TARGET, resultPath);',
      '}',
      'process.exit(Number(process.env.CODEX_STUB_EXIT || "0"));',
      '',
    ].join('\n'));
    fs.chmodSync(codexStub, 0o755);

    // Source a sandbox copy so the sibling guardian is deterministic.
    const observerFixture = path.join(observerFixtureDir, 'observer-loop.sh');
    const observerProviderRunnerFixture = path.join(observerFixtureDir, 'observer-provider-runner.sh');
    const guardianStub = path.join(observerFixtureDir, 'session-guardian.sh');
    fs.copyFileSync(observerLoopPath, observerFixture);
    fs.copyFileSync(observerProviderRunnerPath, observerProviderRunnerFixture);
    fs.chmodSync(observerProviderRunnerFixture, 0o755);
    fs.writeFileSync(guardianStub, '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(guardianStub, 0o755);
    const instinctCliStub = path.join(scriptsFixtureDir, 'instinct-cli.py');
    fs.writeFileSync(instinctCliStub, [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$CLAUDE_PROJECT_DIR" > "$INGEST_PROJECT_ROOT_FILE"',
      'exit "${INGEST_STUB_EXIT:-0}"',
      '',
    ].join('\n'));
    fs.chmodSync(instinctCliStub, 0o755);

    const driver = path.join(sandbox, 'driver.sh');
    fs.writeFileSync(
      driver,
      `#!/usr/bin/env bash\nsource ${JSON.stringify(observerFixture)}\nanalyze_observations\n`
    );
    fs.chmodSync(driver, 0o755);

    const observationsFile = path.join(projectDir, 'observations.jsonl');
    const logFile = path.join(projectDir, 'observer.log');
    const claudePidFile = path.join(projectDir, 'claude-stub.pid');
    const claudeChildPidFile = path.join(projectDir, 'claude-stub-child.pid');
    const attackFile = path.join(projectDir, 'result-path-attack-found');
    fs.writeFileSync(observationsFile, observations);
    const originalObservations = fs.readFileSync(observationsFile, 'utf8');
    if (existingLog) fs.writeFileSync(logFile, existingLog);

    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'CLAUDE_PLUGIN_ROOT' && !key.startsWith('ECC_OBSERVER_')
      )
    );
    const childEnv = {
      ...inheritedEnv,
      PATH: binDir + path.delimiter + process.env.PATH,
      CLAUDE_MODEL_FILE: claudeModelFile,
      CLAUDE_STUB_EXIT: String(claudeExitCode),
      CLAUDE_STUB_OUTPUT: claudeOutput,
      CLAUDE_STUB_STDERR: claudeStderr,
      CLAUDE_STUB_DELAY_SECONDS: String(claudeDelaySeconds),
      CLAUDE_STUB_IGNORE_TERM: String(claudeIgnoreTerm),
      CLAUDE_STUB_SPAWN_CHILD: String(claudeSpawnChild),
      CLAUDE_STUB_PROBE_RESULT_PATH: String(probeResultPath),
      CLAUDE_STUB_PID_FILE: claudePidFile,
      CLAUDE_STUB_CHILD_PID_FILE: claudeChildPidFile,
      CLAUDE_STUB_ATTACK_FILE: attackFile,
      CLAUDE_STUB_CAPTURE_ANALYSIS: String(captureAnalysis),
      CLAUDE_STUB_ANALYSIS_CAPTURE_FILE: analysisCaptureFile,
      CODEX_STUB_EXIT: String(codexExitCode),
      CODEX_STUB_WRITES_RESULT: String(codexWritesResult),
      CODEX_STUB_REPLACE_RESULT_WITH_SYMLINK: String(options.codexReplaceResultWithSymlink || false),
      CODEX_SYMLINK_TARGET: path.join(projectDir, 'attacker-result.json'),
      CODEX_ARGS_FILE: codexArgsFile,
      INGEST_STUB_EXIT: String(ingestExitCode),
      INGEST_PROJECT_ROOT_FILE: path.join(projectDir, 'ingest-project-root'),
      OBSERVATIONS_FILE: observationsFile,
      MIN_OBSERVATIONS: '1',
      PROJECT_DIR: projectDir,
      PROJECT_ROOT: path.join(sandbox, 'actual-user-project'),
      LOG_FILE: logFile,
      PROJECT_NAME: 'test-project',
      PROJECT_ID: 'test-project',
      INSTINCTS_DIR: path.join(projectDir, 'instincts'),
      CONFIG_DIR: projectDir,
      CLV2_IS_WINDOWS: 'false',
      ECC_OBSERVER_TIMEOUT_SECONDS: String(observerTimeoutSeconds),
      ECC_OBSERVER_MAX_ANALYSIS_LINES: '500',
      ECC_OBSERVER_MAX_TURNS: '20',
      ECC_OBSERVER_PROVIDER: provider,
      ECC_OBSERVER_ALLOW_WINDOWS: 'false',
      CLV2_PYTHON_CMD: 'bash',
      CLV2_COMPACTION_PYTHON_CMD: process.env.PYTHON3 || 'python3',
    };
    if (observerModel !== undefined) {
      childEnv.ECC_OBSERVER_MODEL = observerModel;
    }
    if (codexModel !== undefined) {
      childEnv.ECC_OBSERVER_CODEX_MODEL = codexModel;
    }

    const startedAt = Date.now();
    const result = spawnSync('bash', [driver], {
      encoding: 'utf8',
      timeout: 15000,
      env: childEnv,
    });
    const durationMs = Date.now() - startedAt;

    assert.ifError(result.error);
    assert.strictEqual(
      result.status,
      0,
      `driver should exit 0, got ${result.status}; stderr: ${result.stderr}`
    );

    const archiveDir = path.join(projectDir, 'observations.archive');
    const archivedContents = fs.existsSync(archiveDir)
      ? fs.readdirSync(archiveDir)
        .filter(file => /^processed-.*\.jsonl$/.test(file))
        .sort()
        .map(file => fs.readFileSync(path.join(archiveDir, file), 'utf8'))
      : [];
    const liveContent = fs.existsSync(observationsFile)
      ? fs.readFileSync(observationsFile, 'utf8')
      : null;
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const claudeModel = fs.existsSync(claudeModelFile)
      ? fs.readFileSync(claudeModelFile, 'utf8').trim()
      : null;
    const codexArgs = fs.existsSync(codexArgsFile)
      ? JSON.parse(fs.readFileSync(codexArgsFile, 'utf8'))
      : null;
    const ingestProjectRootFile = childEnv.INGEST_PROJECT_ROOT_FILE;
    const ingestProjectRoot = fs.existsSync(ingestProjectRootFile)
      ? fs.readFileSync(ingestProjectRootFile, 'utf8').trim()
      : null;
    const observerTempDir = path.join(projectDir, '.observer-tmp');
    const tempEntries = fs.existsSync(observerTempDir)
      ? fs.readdirSync(observerTempDir)
      : [];
    const claudePid = fs.existsSync(claudePidFile)
      ? Number(fs.readFileSync(claudePidFile, 'utf8').trim())
      : null;
    const claudeChildPid = fs.existsSync(claudeChildPidFile)
      ? Number(fs.readFileSync(claudeChildPidFile, 'utf8').trim())
      : null;

    return {
      archivedContents,
      attackFound: fs.existsSync(attackFile),
      claudeModel,
      claudeStillRunning: processExists(claudePid),
      claudeChildStillRunning: processExists(claudeChildPid),
      codexArgs,
      durationMs,
      ingestProjectRoot,
      liveContent,
      log,
      projectRoot: childEnv.PROJECT_ROOT,
      tempEntries,
      rawObservations: originalObservations,
      analysisPayload: fs.existsSync(analysisCaptureFile)
        ? fs.readFileSync(analysisCaptureFile, 'utf8')
        : null,
    };
  } finally {
    cleanupDir(sandbox);
  }
}

function runProviderRunner(options = {}) {
  const {
    provider = 'claude',
    claudeExitCode = 0,
    codexHome = '',
    model = provider === 'codex' ? 'gpt-5-codex' : 'haiku',
    prompt = 'prompt',
  } = options;
  const sandbox = createTempDir();

  try {
    const binDir = path.join(sandbox, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const claudeStub = path.join(binDir, 'claude');
    fs.writeFileSync(claudeStub, [
      '#!/usr/bin/env bash',
      'exit "${CLAUDE_STUB_EXIT:-0}"',
      '',
    ].join('\n'));
    fs.chmodSync(claudeStub, 0o755);
    const codexRecord = path.join(sandbox, 'codex-record.json');
    const codexStub = path.join(binDir, 'codex');
    fs.writeFileSync(codexStub, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'fs.writeFileSync(process.env.CODEX_RECORD_PATH, JSON.stringify({',
      '  argv: process.argv.slice(2),',
      '  codexHome: process.env.CODEX_HOME || "",',
      '}));',
      'process.exit(0);',
      '',
    ].join('\n'));
    fs.chmodSync(codexStub, 0o755);

    const resultPath = path.join(sandbox, 'result.json');
    const schemaPath = path.join(sandbox, 'schema.json');
    const workingDir = path.join(sandbox, 'work');
    fs.writeFileSync(schemaPath, '{}');
    fs.mkdirSync(workingDir, { recursive: true });

    const env = {
      ...process.env,
      PATH: binDir + path.delimiter + process.env.PATH,
      CLAUDE_STUB_EXIT: String(claudeExitCode),
      CODEX_RECORD_PATH: codexRecord,
    };
    if (codexHome) env.ECC_OBSERVER_CODEX_HOME = codexHome;

    const args = provider === 'codex'
      ? [observerProviderRunnerPath, provider, model, '20', prompt, resultPath, schemaPath, workingDir]
      : [observerProviderRunnerPath, provider, model, '20', prompt];
    const result = spawnSync(
      'bash',
      args,
      { encoding: 'utf8', env }
    );
    result.codexRecord = fs.existsSync(codexRecord)
      ? JSON.parse(fs.readFileSync(codexRecord, 'utf8'))
      : null;
    result.codexPaths = { resultPath, schemaPath, workingDir };
    return result;
  } finally {
    cleanupDir(sandbox);
  }
}

function assertOriginalBatchIsRetryable(state) {
  assert.strictEqual(
    state.liveContent,
    ORIGINAL_OBSERVATIONS,
    'the live batch must remain byte-for-byte intact for retry'
  );
  assert.deepStrictEqual(state.archivedContents, []);
}

console.log('\n=== Observer-loop Archive-on-Failure Tests (#2370, #2673) ===\n');
console.log('--- behavioral ---');

test('failed analysis retains observations and archives nothing', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeExitCode: 1,
    claudeOutput: `${ANALYSIS_COMPLETE_RECORD}\n`,
  });
  assertOriginalBatchIsRetryable(state);
  assert.match(state.log, /retaining observations for retry/);
  assert.deepStrictEqual(state.tempEntries, []);
});

test('zero-exit analysis without a completion record retains observations', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: 'Analysis blocked because the sampled file was not found.\n',
  });
  assertOriginalBatchIsRetryable(state);
  assert.match(state.log, /completion record missing.*retaining observations for retry/i);
  assert.deepStrictEqual(state.tempEntries, []);
});

test('mentioning the completion record in prose does not authorize archival', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: `I would emit ${ANALYSIS_COMPLETE_RECORD} after analysis, but the read failed.\n`,
  });
  assertOriginalBatchIsRetryable(state);
});

test('completion record followed by failure text does not authorize archival', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: `${ANALYSIS_COMPLETE_RECORD}\nLater failure: instinct write did not complete.\n`,
  });
  assertOriginalBatchIsRetryable(state);
});

test('a completion record from an older log entry cannot authorize this run', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    existingLog: `prior run\n${ANALYSIS_COMPLETE_RECORD}\n`,
    claudeOutput: 'Current run could not read its analysis file.\n',
  });
  assertOriginalBatchIsRetryable(state);
});

test('a completion record written only to stderr does not authorize archival', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: 'Analysis did not complete.\n',
    claudeStderr: `${ANALYSIS_COMPLETE_RECORD}\n`,
  });
  assertOriginalBatchIsRetryable(state);
  assert.ok(state.log.includes(ANALYSIS_COMPLETE_RECORD));
});

test('duplicate exact completion records do not authorize archival', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: `${ANALYSIS_COMPLETE_RECORD}\n${ANALYSIS_COMPLETE_RECORD}\n`,
  });
  assertOriginalBatchIsRetryable(state);
});

test('replacing the result pathname cannot forge completion', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: 'Analysis did not complete.\n',
    probeResultPath: true,
  });
  assertOriginalBatchIsRetryable(state);
  assert.strictEqual(state.attackFound, false, 'the open result inode must not remain path-addressable');
});

test('successful analysis archives the original batch byte-for-byte', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: `Analysis finished.\n\n${ANALYSIS_COMPLETE_RECORD}\n\n`,
  });
  assert.strictEqual(state.liveContent, null);
  assert.deepStrictEqual(state.archivedContents, [ORIGINAL_OBSERVATIONS]);
  assert.deepStrictEqual(state.tempEntries, []);
});

test('analysis payload compacts exact repeats without changing persisted observations', () => {
  skipOnWindows();
  const repetitive = [1, 2, 3].map(() => JSON.stringify({
    timestamp: '2026-01-01T00:00:00Z', event: 'tool_complete', tool: 'Read',
    output: 'same output', session: 'session-1', tool_use_id: 'use-1', turn_id: 'turn-1',
  })).join('\n') + '\n';
  const state = runAnalyzeOnce({
    observations: repetitive,
    captureAnalysis: true,
    claudeOutput: `${ANALYSIS_COMPLETE_RECORD}\n`,
  });
  assert.strictEqual(state.rawObservations, repetitive);
  assert.strictEqual(state.analysisPayload.trim().split('\n').length, 1);
  const compacted = JSON.parse(state.analysisPayload);
  assert.strictEqual(compacted._compaction.raw_occurrences, 3);
  assert.deepStrictEqual(compacted._compaction.sessions, ['session-1']);
  assert.strictEqual(state.archivedContents[0], repetitive);
});

test('analysis payload keeps meaningful observation differences separate', () => {
  skipOnWindows();
  const observations = [
    { timestamp: '2026-01-01T00:00:00Z', event: 'tool_complete', tool: 'Read', output: 'one', session: 's1' },
    { timestamp: '2026-01-01T00:00:01Z', event: 'tool_complete', tool: 'Read', output: 'two', session: 's1' },
  ].map(JSON.stringify).join('\n') + '\n';
  const state = runAnalyzeOnce({
    observations,
    captureAnalysis: true,
    claudeOutput: `${ANALYSIS_COMPLETE_RECORD}\n`,
  });
  assert.strictEqual(state.analysisPayload.trim().split('\n').length, 2);
  assert.strictEqual(state.rawObservations, observations);
});

test('codex success archives after ingest succeeds', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({ provider: 'codex' });
  assert.strictEqual(state.liveContent, null);
  assert.deepStrictEqual(state.archivedContents, [ORIGINAL_OBSERVATIONS]);
  assert.deepStrictEqual(state.tempEntries, []);
  assert.strictEqual(state.ingestProjectRoot, state.projectRoot);
});

test('codex non-zero exit retains observations', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({ provider: 'codex', codexExitCode: 9 });
  assertOriginalBatchIsRetryable(state);
  assert.match(state.log, /Codex analysis failed.*retaining observations for retry/);
  assert.deepStrictEqual(state.tempEntries, []);
});

test('codex zero exit without result retains observations', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({ provider: 'codex', codexWritesResult: false });
  assertOriginalBatchIsRetryable(state);
  assert.match(state.log, /Codex analysis result file missing or invalid.*retaining observations for retry/);
  assert.deepStrictEqual(state.tempEntries, []);
});

test('codex result pathname replaced with symlink retains observations', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({ provider: 'codex', codexReplaceResultWithSymlink: true });
  assertOriginalBatchIsRetryable(state);
  assert.match(state.log, /Codex analysis result file missing or invalid.*retaining observations for retry/);
  assert.deepStrictEqual(state.tempEntries, []);
});

test('codex ingest failure retains observations', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({ provider: 'codex', ingestExitCode: 4 });
  assertOriginalBatchIsRetryable(state);
  assert.match(state.log, /Codex observer ingest failed.*retaining observations for retry/);
  assert.deepStrictEqual(state.tempEntries, []);
});

test('codex empty valid result archives after ingest succeeds', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({ provider: 'codex' });
  assert.strictEqual(state.liveContent, null);
  assert.deepStrictEqual(state.archivedContents, [ORIGINAL_OBSERVATIONS]);
});

test('claude observer defaults to haiku without model override', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: `${ANALYSIS_COMPLETE_RECORD}\n`,
    observerModel: undefined,
  });
  assert.strictEqual(state.claudeModel, 'haiku');
});

test('codex observer omits model override without codex model override', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    provider: 'codex',
    observerModel: undefined,
  });
  assert.ok(!state.codexArgs.includes('-m'));
});

test('codex observer uses explicit codex model override', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    provider: 'codex',
    codexModel: 'gpt-5.5',
  });
  assert.deepStrictEqual(
    state.codexArgs.slice(state.codexArgs.indexOf('-m'), state.codexArgs.indexOf('-m') + 2),
    ['-m', 'gpt-5.5']
  );
});

test('codex observer ignores generic observer model override', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    provider: 'codex',
    observerModel: 'haiku',
  });
  assert.ok(!state.codexArgs.includes('-m'));
});

test('completion record accepts a CRLF line ending', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeOutput: `Analysis complete.\r\n${ANALYSIS_COMPLETE_RECORD}\r\n\r\n`,
  });
  assert.strictEqual(state.liveContent, null);
  assert.deepStrictEqual(state.archivedContents, [ORIGINAL_OBSERVATIONS]);
});

test('watchdog force-stops a process that ignores TERM and retains observations', () => {
  skipOnWindows();
  const state = runAnalyzeOnce({
    claudeDelaySeconds: 10,
    claudeIgnoreTerm: true,
    claudeSpawnChild: true,
    observerTimeoutSeconds: 1,
  });
  assertOriginalBatchIsRetryable(state);
  assert.ok(state.durationMs < 8000, `watchdog should return promptly; took ${state.durationMs}ms`);
  assert.strictEqual(state.claudeStillRunning, false, 'timed-out Claude process must be reaped');
  assert.strictEqual(state.claudeChildStillRunning, false, 'timed-out Claude descendants must stop');
  assert.match(state.log, /timed out after 1s/);
  assert.deepStrictEqual(state.tempEntries, []);
});

console.log('--- static guards ---');

test('unsupported observer provider exits non-zero', () => {
  skipOnWindows();
  const result = runProviderRunner({ provider: 'unsupported' });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /unsupported observer provider: unsupported/);
});

test('claude observer provider preserves exit code', () => {
  skipOnWindows();
  const result = runProviderRunner({ claudeExitCode: 17 });
  assert.strictEqual(result.status, 17);
});

test('codex observer provider command contract', () => {
  skipOnWindows();
  const prompt = 'prompt with spaces; $(not-run)';
  const result = runProviderRunner({
    provider: 'codex',
    codexHome: '/tmp/ecc-codex-home',
    prompt,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = result.codexRecord.argv;
  assert.deepStrictEqual(argv.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.ok(argv.indexOf('--ask-for-approval') < argv.indexOf('exec'));
  assert.ok(argv.includes('--ephemeral'));
  assert.ok(argv.includes('--ignore-user-config'));
  assert.ok(argv.includes('--skip-git-repo-check'));
  assert.deepStrictEqual(argv.slice(argv.indexOf('-m'), argv.indexOf('-m') + 2), ['-m', 'gpt-5-codex']);
  assert.deepStrictEqual(
    argv.slice(argv.indexOf('-c'), argv.indexOf('-c') + 2),
    ['-c', 'model_reasoning_effort=low']
  );
  assert.deepStrictEqual(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-C'), argv.indexOf('-C') + 2), ['-C', result.codexPaths.workingDir]);
  assert.deepStrictEqual(
    argv.slice(argv.indexOf('--output-schema'), argv.indexOf('--output-schema') + 2),
    ['--output-schema', result.codexPaths.schemaPath]
  );
  assert.deepStrictEqual(argv.slice(argv.indexOf('-o'), argv.indexOf('-o') + 2), ['-o', result.codexPaths.resultPath]);
  assert.strictEqual(argv[argv.length - 1], prompt);
  assert.strictEqual(result.codexRecord.codexHome, '/tmp/ecc-codex-home');
});

test('start-observer propagates PROJECT_ROOT into observer environment', () => {
  const content = fs.readFileSync(startObserverPath, 'utf8');
  assert.match(content, /PROJECT_ROOT="\$PROJECT_ROOT"\s*\\/);
});

test('process and semantic failure guards run before archival', () => {
  const content = fs.readFileSync(observerLoopPath, 'utf8');
  const processGuardIdx = content.search(/exit_code"?\s+-ne\s+0/);
  const semanticGuardIdx = content.indexOf('if [ "$analysis_complete" -ne 1 ]');
  const archiveIdx = content.indexOf('observations.archive', semanticGuardIdx);
  assert.ok(processGuardIdx !== -1);
  assert.ok(semanticGuardIdx !== -1);
  assert.ok(archiveIdx !== -1);
  assert.ok(processGuardIdx < archiveIdx);
  assert.ok(semanticGuardIdx < archiveIdx);
});

test('observer-loop.sh has a source guard', () => {
  const content = fs.readFileSync(observerLoopPath, 'utf8');
  assert.ok(
    content.includes('BASH_SOURCE[0]') && content.includes('return 0 2>/dev/null')
  );
});

console.log('\n=== Test Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Skipped: ${skipped}`);
console.log(`Total:  ${passed + failed + skipped}\n`);

process.exit(failed > 0 ? 1 : 0);
