/**
 * Focused Step B regression test for start-observer Python propagation.
 *
 * Run with: node tests/hooks/start-observer-python.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const SKIP_BASH = process.platform === 'win32';

function toBashPath(filePath) {
  if (process.platform !== 'win32') {
    return filePath;
  }

  return String(filePath)
    .replace(/^([A-Za-z]):/, (_, driveLetter) => `/${driveLetter.toLowerCase()}`)
    .replace(/\\/g, '/');
}

function fromBashPath(filePath) {
  if (process.platform !== 'win32') {
    return filePath;
  }

  const rawPath = String(filePath || '');
  if (!rawPath) {
    return rawPath;
  }

  try {
    return execFileSync('bash', ['-lc', 'cygpath -w -- "$1"', 'bash', rawPath], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // Fall through to common Git Bash path shapes when cygpath is unavailable.
  }

  const match = rawPath.match(/^\/(?:cygdrive\/)?([A-Za-z])\/(.*)$/) || rawPath.match(/^\/\/([A-Za-z])\/(.*)$/);
  if (match) {
    return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
  }

  if (/^[A-Za-z]:\//.test(rawPath)) {
    return rawPath.replace(/\//g, '\\');
  }

  return rawPath;
}

function normalizeComparablePath(filePath) {
  const nativePath = fromBashPath(filePath);
  if (!nativePath) {
    return nativePath;
  }

  let comparablePath = nativePath;
  try {
    comparablePath = fs.realpathSync.native ? fs.realpathSync.native(nativePath) : fs.realpathSync(nativePath);
  } catch {
    comparablePath = path.resolve(nativePath);
  }

  comparablePath = comparablePath.replace(/[\\/]+/g, '/');
  if (comparablePath.length > 1 && !/^[A-Za-z]:\/$/.test(comparablePath)) {
    comparablePath = comparablePath.replace(/\/+$/, '');
  }

  return process.platform === 'win32' ? comparablePath.toLowerCase() : comparablePath;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'start-observer-python-'));
}

function cleanupTestDir(testDir) {
  const comparableRoot = normalizeComparablePath(testDir);
  const comparableTmp = normalizeComparablePath(os.tmpdir());
  assert.ok(comparableRoot && comparableRoot.startsWith(comparableTmp), `refusing to clean unsafe fixture path: ${testDir}`);

  const retryableCodes = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryableCodes.has(error.code) || attempt === 4) {
        throw error;
      }
      sleepMs(50 * (attempt + 1));
    }
  }
}

function runShellScript(scriptPath, args = [], env = {}, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [toBashPath(scriptPath), ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => (stdout += data));
    proc.stderr.on('data', data => (stderr += data));
    proc.on('close', code => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

async function main() {
  console.log('start-observer Python propagation regression:');

  if (SKIP_BASH) {
    console.log('  ⊘ start-observer launches observer with resolved Python executable (skipped on Windows)');
    return;
  }

  const testRoot = createTestDir();
  const homeDir = path.join(testRoot, 'home');
  const repoDir = path.join(testRoot, 'repo');
  const binDir = path.join(testRoot, 'bin');
  const stablePython = path.join(binDir, 'stable-python');
  const skillRoot = path.join(testRoot, 'continuous-learning-v2');
  const sourceSkillRoot = path.join(__dirname, '..', '..', 'skills', 'continuous-learning-v2');

  try {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.cpSync(sourceSkillRoot, skillRoot, { recursive: true });

    fs.writeFileSync(path.join(skillRoot, 'config.json'), JSON.stringify({
      observer: {
        enabled: true,
        run_interval_minutes: 1,
        min_observations_to_analyze: 1
      }
    }));
    fs.writeFileSync(path.join(skillRoot, 'agents', 'observer-loop.sh'), [
      '#!/usr/bin/env bash',
      'cd "$PROJECT_DIR"',
      'printf "%s\\n" "$$" > "$PID_FILE"',
      'printf "%s\\n" "$CLV2_PYTHON_CMD" > "$PROJECT_DIR/launched-python.txt"',
      'printf "%s\\n" "$(pwd)" > "$PROJECT_DIR/observer-cwd.txt"',
      'sleep 2'
    ].join('\n'));
    fs.chmodSync(path.join(skillRoot, 'agents', 'observer-loop.sh'), 0o755);

    const fakePython = [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$0 $*" >> "$PYTHON_INVOCATIONS_LOG"',
      'case "$*" in',
      '  *"sys.executable"*) printf "%s\\n" "$STABLE_PYTHON_PATH"; exit 0 ;;',
      '  *) printf "1\\n1\\ntrue\\n"; exit 0 ;;',
      'esac'
    ].join('\n');
    fs.writeFileSync(path.join(binDir, 'python3'), fakePython);
    fs.writeFileSync(stablePython, fakePython);
    fs.chmodSync(path.join(binDir, 'python3'), 0o755);
    fs.chmodSync(stablePython, 0o755);

    const providerLog = path.join(testRoot, 'provider-invocations.log');
    const providerShim = [
      '#!/usr/bin/env bash',
      `printf "%s\\n" "$0 $*" >> "${toBashPath(providerLog)}"`,
      'exit 99'
    ].join('\n');
    fs.writeFileSync(path.join(binDir, 'claude'), providerShim);
    fs.writeFileSync(path.join(binDir, 'codex'), providerShim);
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
    fs.chmodSync(path.join(binDir, 'codex'), 0o755);

    spawnSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });

    const pythonLog = path.join(testRoot, 'python-invocations.log');
    const result = await runShellScript(path.join(skillRoot, 'agents', 'start-observer.sh'), ['start'], {
      HOME: homeDir,
      USERPROFILE: homeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      PYTHON_INVOCATIONS_LOG: pythonLog,
      STABLE_PYTHON_PATH: stablePython,
      CLAUDE_PROJECT_DIR: repoDir,
      CLV2_PYTHON_CMD: 'python3'
    }, repoDir);

    assert.strictEqual(result.code, 0, `start-observer should launch cleanly, stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.ok(fs.readFileSync(pythonLog, 'utf8').includes('python3 -c'), 'start-observer should invoke the explicit CLV2_PYTHON_CMD=python3 for resolution');

    const homunculusDir = path.join(homeDir, '.local', 'share', 'ecc-homunculus');
    const projectsDir = path.join(homunculusDir, 'projects');
    assert.ok(fs.existsSync(projectsDir), 'observer runtime data should be created only under the fixture HOME');
    assert.ok(!fs.existsSync(path.join(os.homedir(), '.local', 'share', 'ecc-homunculus', 'projects', path.basename(testRoot))), 'test must not touch the real homunculus runtime');

    const projectIds = fs.readdirSync(projectsDir);
    assert.strictEqual(projectIds.length, 1, 'expected one project-scoped observer directory');

    const projectDir = path.join(projectsDir, projectIds[0]);
    const launchedPython = fs.readFileSync(path.join(projectDir, 'launched-python.txt'), 'utf8').trim();
    const observerCwd = fs.readFileSync(path.join(projectDir, 'observer-cwd.txt'), 'utf8').trim();

    assert.ok(path.isAbsolute(launchedPython), 'observer-loop should receive an absolute Python executable path');
    assert.strictEqual(launchedPython, stablePython, 'observer-loop should receive the stable Python executable path from sys.executable');
    assert.notStrictEqual(normalizeComparablePath(observerCwd), normalizeComparablePath(repoDir), 'regression fixture should launch from a different cwd than the project repo');
    assert.ok(!fs.existsSync(providerLog), 'fake observer-loop should prevent real Codex/Claude provider invocation');

    console.log('  ✓ start-observer launches observer with resolved Python executable independent of observer cwd');
  } finally {
    cleanupTestDir(testRoot);
  }
}

main().catch(error => {
  console.log('  ✗ start-observer launches observer with resolved Python executable independent of observer cwd');
  console.log(`    Error: ${error.message}`);
  process.exit(1);
});
