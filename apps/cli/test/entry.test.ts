import test from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../src/index.ts';

// Resolve from this file, so the suite passes from the repo root or the package dir.
const entryPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function runSpawn(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('node', ['--experimental-strip-types', entryPath, ...args], {
    // Node 22 warns on stderr about experimental type stripping; tests parse stderr.
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function createCaptureIO() {
  let stdoutData = '';
  let stderrData = '';
  return {
    stdout: {
      write: (s: string) => {
        stdoutData += s;
        return true;
      },
    },
    stderr: {
      write: (s: string) => {
        stderrData += s;
        return true;
      },
    },
    get stdoutData() {
      return stdoutData;
    },
    get stderrData() {
      return stderrData;
    },
  };
}

test('CLI entry - help is available without credentials and exits 0', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const res = runSpawn([flag], { UPTIMER_URL: '', UPTIMER_ADMIN_TOKEN: '' });
    assert.equal(res.status, 0, `Expected 0 exit status for ${flag}`);
    assert.equal(res.stderr, '');
    assert.match(res.stdout, /Uptimer Agent Configuration CLI/);
    assert.match(res.stdout, /monitors/);
    assert.match(res.stdout, /monitors groups/);
    assert.match(res.stdout, /notification-channels/);
    assert.match(res.stdout, /status-pages/);
    assert.match(res.stdout, /settings/);
    assert.match(res.stdout, /settings uptime-rating/);
    assert.match(res.stdout, /skill\n +install/);
    assert.match(res.stdout, /--dir <path>/);
    assert.match(res.stdout, /--file <path\|->/);
    assert.match(res.stdout, /1-200, default 50/);
    assert.match(res.stdout, /bounded slices and do not claim to represent a complete inventory/);
    assert.match(res.stdout, /HTTP Monitor:/);
    assert.match(res.stdout, /TCP Monitor \(target is host:port\):/);
    assert.match(res.stdout, /Custom Webhook Channel:/);
    assert.match(res.stdout, /Telegram Channel \(type stays "webhook"\):/);
    assert.match(res.stdout, /Status Page:/);
    assert.match(res.stdout, /Global Settings:/);
    assert.match(res.stdout, /Uptime Rating:/);
    assert.match(res.stdout, /EXIT CODES & OUTPUT/);

    // Examples must use live API field names, not the retired ones.
    for (const field of [
      '"target":',
      '"interval_sec":',
      '"timeout_ms":',
      '"http_method":',
      '"config_json":',
      '"retention_check_results_days":',
    ]) {
      assert.ok(res.stdout.includes(field), `help examples must document ${field}`);
    }
    for (const retired of [
      '"url": "https://api.example.com/health"',
      '"interval_seconds":',
      '"timeout_seconds":',
      '"expected_status_codes":',
      '"retention_days":',
    ]) {
      assert.ok(!res.stdout.includes(retired), `help examples must not document ${retired}`);
    }
  }
});

test('CLI entry - unknown command, missing command, unknown option exit 2 with empty stdout and structured stderr', () => {
  // Empty arguments
  {
    const res = runSpawn([]);
    assert.equal(res.status, 2);
    assert.equal(res.stdout, '');
    const errObj = JSON.parse(res.stderr);
    assert.equal(errObj.error.code, 'INVALID_ARGUMENT');
    assert.equal(errObj.error.status, undefined);
  }

  // Unknown command
  {
    const res = runSpawn(['nonexistent-resource', 'list']);
    assert.equal(res.status, 2);
    assert.equal(res.stdout, '');
    const errObj = JSON.parse(res.stderr);
    assert.equal(errObj.error.code, 'INVALID_ARGUMENT');
    assert.equal(errObj.error.status, undefined);
  }

  // Unknown option
  {
    const res = runSpawn(['monitors', 'list', '--invalid-flag']);
    assert.equal(res.status, 2);
    assert.equal(res.stdout, '');
    const errObj = JSON.parse(res.stderr);
    assert.equal(errObj.error.code, 'INVALID_ARGUMENT');
    assert.match(errObj.error.message, /Unknown option/);
  }
});

test('CLI runner - extra positional arguments exit 2 with empty stdout', async () => {
  const io = createCaptureIO();
  const code = await run(['monitors', 'list', 'extra-arg'], {}, io);
  assert.equal(code, 2);
  assert.equal(io.stdoutData, '');
  const errObj = JSON.parse(io.stderrData);
  assert.equal(errObj.error.code, 'INVALID_ARGUMENT');
  assert.match(errObj.error.message, /Unexpected positional/);
});

test('CLI runner - missing required body (--file) exits 2 before making requests', async () => {
  let fetchCalled = false;
  const dummyFetch: typeof fetch = async () => {
    fetchCalled = true;
    return new Response('{}');
  };

  const commandsNeedingBody = [
    ['monitors', 'create'],
    ['monitors', 'update', '10'],
    ['monitors', 'groups', 'reorder'],
    ['monitors', 'groups', 'assign'],
    ['notification-channels', 'create'],
    ['notification-channels', 'update', '5'],
    ['status-pages', 'create'],
    ['status-pages', 'update', '3'],
    ['settings', 'update'],
    ['settings', 'uptime-rating', 'update'],
  ];

  for (const cmd of commandsNeedingBody) {
    const io = createCaptureIO();
    const code = await run(
      cmd,
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
      io,
      dummyFetch,
    );
    assert.equal(
      code,
      2,
      `Command ${cmd.join(' ')} should fail with exit code 2 when --file is missing`,
    );
    assert.equal(io.stdoutData, '');
    const errObj = JSON.parse(io.stderrData);
    assert.equal(errObj.error.code, 'INVALID_ARGUMENT');
    assert.match(errObj.error.message, /--file/);
    assert.equal(fetchCalled, false, 'Fetch should not be called when argument validation fails');
  }
});

test('CLI runner - boundary checks for ID validation reject before requests', async () => {
  let fetchCalled = false;
  const dummyFetch: typeof fetch = async () => {
    fetchCalled = true;
    return new Response('{}');
  };

  const invalidIds = ['0', '-1', '1.5', 'abc', '9007199254740992'];
  for (const badId of invalidIds) {
    const io = createCaptureIO();
    const code = await run(
      ['monitors', 'delete', badId],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
      io,
      dummyFetch,
    );
    assert.equal(code, 2, `ID "${badId}" should reject with exit 2`);
    assert.equal(io.stdoutData, '');
    const errObj = JSON.parse(io.stderrData);
    assert.equal(errObj.error.code, 'INVALID_ARGUMENT');
    assert.match(errObj.error.message, /Invalid ID/);
    assert.equal(fetchCalled, false);
  }
});

test('CLI runner - boundary checks for list limit: 1 and 200 accepted, 0 and 201 rejected', async () => {
  const calls: string[] = [];
  const dummyFetch: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ monitors: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // Rejection boundaries: 0, 201, -5, non-numeric
  for (const badLimit of ['0', '201', '-5', 'abc']) {
    const io = createCaptureIO();
    const code = await run(
      ['monitors', 'list', '--limit', badLimit],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
      io,
      dummyFetch,
    );
    assert.equal(code, 2, `Limit "${badLimit}" should reject with exit 2`);
    assert.equal(io.stdoutData, '');
    const errObj = JSON.parse(io.stderrData);
    assert.equal(errObj.error.code, 'INVALID_ARGUMENT');
    assert.match(errObj.error.message, /Invalid limit/);
  }
  assert.equal(calls.length, 0, 'No fetch calls on rejected limits');

  // Acceptance boundaries: 1, 200, and omitted (default 50)
  for (const [limitArg, expectedParam] of [
    ['1', 'limit=1'],
    ['200', 'limit=200'],
  ] as Array<[string, string]>) {
    const io = createCaptureIO();
    const code = await run(
      ['monitors', 'list', '--limit', limitArg],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
      io,
      dummyFetch,
    );
    assert.equal(code, 0, `Limit "${limitArg}" should succeed with exit 0`);
    assert.match(calls.pop()!, new RegExp(expectedParam));
  }

  // Omitted limit defaults to 50
  {
    const io = createCaptureIO();
    const code = await run(
      ['monitors', 'list'],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
      io,
      dummyFetch,
    );
    assert.equal(code, 0);
    assert.match(calls.pop()!, /limit=50/);
  }
});

test('CLI runner - body validation: non-object JSON payloads reject before request', async () => {
  let fetchCalled = false;
  const dummyFetch: typeof fetch = async () => {
    fetchCalled = true;
    return new Response('{}');
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uptimer-cli-test-'));
  try {
    const arrayFile = path.join(tempDir, 'array.json');
    const stringFile = path.join(tempDir, 'string.json');
    const nullFile = path.join(tempDir, 'null.json');
    const malformedFile = path.join(tempDir, 'malformed.json');

    await fs.writeFile(arrayFile, '[{"name": "test"}]', 'utf8');
    await fs.writeFile(stringFile, '"just a string"', 'utf8');
    await fs.writeFile(nullFile, 'null', 'utf8');
    await fs.writeFile(malformedFile, '{ incomplete json', 'utf8');

    for (const testFile of [arrayFile, stringFile, nullFile, malformedFile]) {
      const io = createCaptureIO();
      const code = await run(
        ['monitors', 'create', '--file', testFile],
        { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
        io,
        dummyFetch,
      );
      assert.equal(code, 2, `File ${testFile} should reject with exit code 2`);
      assert.equal(io.stdoutData, '');
      const errObj = JSON.parse(io.stderrData);
      assert.equal(errObj.error.code, 'INVALID_ARGUMENT');
      assert.equal(fetchCalled, false);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('CLI runner - malformed JSON is reported without echoing the payload', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uptimer-cli-json-'));
  try {
    const file = path.join(tempDir, 'payload.json');
    await fs.writeFile(file, '{"bot_token": FAKE_BOT_SECRET_123}', 'utf8');

    const io = createCaptureIO();
    const code = await run(
      ['notification-channels', 'create', '--file', file],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
      io,
      async () => new Response('{}'),
    );

    assert.equal(code, 2);
    const message = JSON.parse(io.stderrData).error.message as string;
    assert.match(message, /^Malformed JSON in payload/);
    assert.ok(!message.includes('FAKE_BOT_SECRET_123'), 'parser message must not quote input');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('CLI runner - a repeated payload option is rejected instead of silently overwritten', async () => {
  let fetchCalls = 0;
  const io = createCaptureIO();
  const code = await run(
    ['settings', 'update', '--file', 'ignored.json', '--file', '-'],
    { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
    io,
    async () => {
      fetchCalls += 1;
      return Response.json({ settings: {} });
    },
  );

  assert.equal(code, 2);
  assert.equal(fetchCalls, 0);
  assert.match(JSON.parse(io.stderrData).error.message, /--file may only be given once/);
});

test('CLI runner - duplicate --limit and --dir are rejected', async () => {
  for (const argv of [
    ['monitors', 'list', '--limit', '10', '--limit', '20'],
    ['skill', 'install', '--dir', 'first', '--dir', 'second'],
  ]) {
    const io = createCaptureIO();
    const code = await run(
      argv,
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'secret' },
      io,
      async () => Response.json({ monitors: [] }),
    );
    assert.equal(code, 2, argv.join(' '));
    assert.match(JSON.parse(io.stderrData).error.message, /may only be given once/);
  }
});
