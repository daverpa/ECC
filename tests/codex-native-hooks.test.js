/**
 * Integration checks for the native Codex plugin hook boundary.
 *
 * Run with: node tests/codex-native-hooks.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const hookConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks', 'codex-hooks.json'), 'utf8'));
const sessionStart = hookConfig.hooks.SessionStart[0].hooks[0];
const preToolUse = hookConfig.hooks.PreToolUse[0].hooks[0];
const postToolUse = hookConfig.hooks.PostToolUse[0].hooks[0];
const sessionEnd = hookConfig.hooks.SessionEnd[0].hooks[0];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function createFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-hook-'));
  const userHome = path.join(fixtureRoot, 'user-home');
  const projectDir = path.join(fixtureRoot, 'project');
  const pluginData = path.join(fixtureRoot, 'plugin-data');
  const xdgDataHome = path.join(fixtureRoot, 'xdg-data');
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  fs.mkdirSync(xdgDataHome, { recursive: true });

  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    XDG_DATA_HOME: xdgDataHome,
    PLUGIN_DATA: pluginData,
    PLUGIN_ROOT: repoRoot
  };
  delete env.CLAUDE_PLUGIN_ROOT;

  return { fixtureRoot, userHome, projectDir, pluginData, xdgDataHome, env };
}

function runCommand(command, { projectDir, env, payload, timeout = 15_000 }) {
  return spawnSync(command, {
    cwd: projectDir,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    shell: true,
    timeout
  });
}

function runSessionStart({ pluginRoot }) {
  const fixture = createFixture();
  if (pluginRoot) {
    fixture.env.PLUGIN_ROOT = pluginRoot;
  } else {
    delete fixture.env.PLUGIN_ROOT;
  }

  const payload = {
    session_id: 'codex-native-hook-test',
    transcript_path: path.join(fixture.fixtureRoot, 'transcript.jsonl'),
    cwd: fixture.projectDir,
    hook_event_name: 'SessionStart',
    source: 'startup'
  };

  try {
    return runCommand(sessionStart.command, { ...fixture, payload });
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function collectFiles(rootPath) {
  const files = [];
  if (!fs.existsSync(rootPath)) return files;

  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const nextPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(nextPath));
    } else if (entry.isFile()) {
      files.push(nextPath);
    }
  }
  return files;
}

function filesContaining(rootPath, needle) {
  return collectFiles(rootPath).filter((filePath) => {
    try {
      return fs.readFileSync(filePath, 'utf8').includes(needle);
    } catch (_) {
      return false;
    }
  });
}

test('installed Codex SessionStart hook resolves from PLUGIN_ROOT and emits Codex output', () => {
  const result = runSessionStart({ pluginRoot: repoRoot });
  assert.strictEqual(result.status, 0, result.stderr || result.error?.message);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.strictEqual(typeof output.hookSpecificOutput.additionalContext, 'string');
});

test('Codex SessionStart hook fails closed when PLUGIN_ROOT is absent', () => {
  const result = runSessionStart({ pluginRoot: null });
  assert.notStrictEqual(result.status, 0, 'Hook must not fall through to a stale ~/.claude plugin');
  assert.match(result.stderr, /Missing Codex PLUGIN_ROOT/);
});

test('Codex PreToolUse hook runs from PLUGIN_ROOT without caller CLAUDE_PLUGIN_ROOT', () => {
  const fixture = createFixture();
  const payload = {
    session_id: 'codex-native-prepost-test',
    turn_id: 'turn-1',
    cwd: fixture.projectDir,
    hook_event_name: 'PreToolUse',
    model: 'gpt-5-codex',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'printf ok' },
    tool_use_id: 'tool-use-1'
  };

  try {
    const result = runCommand(preToolUse.command, { ...fixture, payload });
    assert.strictEqual(result.status, 0, result.stderr || result.error?.message);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('Codex PostToolUse hook runs for the same native tool identity', () => {
  const fixture = createFixture();
  const payload = {
    session_id: 'codex-native-prepost-test',
    turn_id: 'turn-1',
    cwd: fixture.projectDir,
    hook_event_name: 'PostToolUse',
    model: 'gpt-5-codex',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'printf ok' },
    tool_response: { stdout: 'ok', stderr: '', exit_code: 0 },
    tool_use_id: 'tool-use-1'
  };

  try {
    const result = runCommand(postToolUse.command, { ...fixture, payload });
    assert.strictEqual(result.status, 0, result.stderr || result.error?.message);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('Codex SessionEnd hook releases the observer lease for the native session boundary', () => {
  const fixture = createFixture();
  const sessionId = 'codex-native-session-lifecycle-test';
  const startPayload = {
    session_id: sessionId,
    transcript_path: path.join(fixture.fixtureRoot, 'transcript.jsonl'),
    cwd: fixture.projectDir,
    hook_event_name: 'SessionStart',
    source: 'startup'
  };
  const endPayload = {
    session_id: sessionId,
    transcript_path: null,
    cwd: fixture.projectDir,
    hook_event_name: 'SessionEnd'
  };

  try {
    const startResult = runCommand(sessionStart.command, { ...fixture, payload: startPayload });
    assert.strictEqual(startResult.status, 0, startResult.stderr || startResult.error?.message);
    assert.ok(filesContaining(fixture.fixtureRoot, sessionId).length > 0, 'Expected observer lease/state for the started session');

    const endResult = runCommand(sessionEnd.command, { ...fixture, payload: endPayload, timeout: 5_000 });
    assert.strictEqual(endResult.status, 0, endResult.stderr || endResult.error?.message);
    if (endResult.stdout.trim()) {
      assert.doesNotThrow(() => JSON.parse(endResult.stdout), 'SessionEnd stdout passthrough should remain JSON when emitted');
    }
    assert.deepStrictEqual(filesContaining(fixture.fixtureRoot, sessionId), [], 'Expected SessionEnd to remove observer lease/state');
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
