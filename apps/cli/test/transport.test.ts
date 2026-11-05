import test from 'node:test';
import * as assert from 'node:assert/strict';
import { run } from '../src/index.ts';

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

test('Transport - Bearer authentication header sent and loopback HTTP origins accepted', async () => {
  const loopbackOrigins = [
    'https://uptimer.example.com',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://[::1]:8787',
  ];

  for (const origin of loopbackOrigins) {
    let capturedAuth = '';
    const mockFetch: typeof fetch = async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedAuth = headers['Authorization'] ?? '';
      return new Response(JSON.stringify({ settings: { site_title: 'Test' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const io = createCaptureIO();
    const code = await run(
      ['settings', 'get'],
      { UPTIMER_URL: origin, UPTIMER_ADMIN_TOKEN: 'secret-token-abc' },
      io,
      mockFetch,
    );
    assert.equal(code, 0, `Origin ${origin} should be accepted`);
    assert.equal(capturedAuth, 'Bearer secret-token-abc');
  }
});

test('Transport - URL and environment validation rejects invalid configurations before fetch', async () => {
  let fetchCalled = false;
  const mockFetch: typeof fetch = async () => {
    fetchCalled = true;
    return new Response('{}');
  };

  const invalidConfigs: Array<{ env: Record<string, string>; reason: string }> = [
    {
      env: { UPTIMER_URL: '', UPTIMER_ADMIN_TOKEN: 'token' },
      reason: 'missing origin',
    },
    {
      env: { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: '' },
      reason: 'missing token',
    },
    {
      env: { UPTIMER_URL: 'https://user:pass@example.com', UPTIMER_ADMIN_TOKEN: 'token' },
      reason: 'userinfo in URL',
    },
    {
      env: { UPTIMER_URL: 'https://example.com?foo=bar', UPTIMER_ADMIN_TOKEN: 'token' },
      reason: 'query parameter in URL',
    },
    {
      env: { UPTIMER_URL: 'https://example.com#fragment', UPTIMER_ADMIN_TOKEN: 'token' },
      reason: 'fragment in URL',
    },
    {
      env: { UPTIMER_URL: 'https://example.com/subpath', UPTIMER_ADMIN_TOKEN: 'token' },
      reason: 'non-root pathname in URL',
    },
    {
      env: { UPTIMER_URL: 'ftp://example.com', UPTIMER_ADMIN_TOKEN: 'token' },
      reason: 'unsupported ftp protocol',
    },
    {
      env: { UPTIMER_URL: 'http://remote.example.com', UPTIMER_ADMIN_TOKEN: 'token' },
      reason: 'insecure remote HTTP protocol',
    },
  ];

  for (const { env, reason } of invalidConfigs) {
    const io = createCaptureIO();
    const code = await run(['settings', 'get'], env, io, mockFetch);
    assert.equal(code, 2, `Expected exit code 2 for ${reason}`);
    assert.equal(io.stdoutData, '');
    const errObj = JSON.parse(io.stderrData);
    assert.equal(errObj.error.status, undefined);
    assert.equal(fetchCalled, false, 'Fetch must not be called when environment validation fails');
  }
});

test('Transport - Redirects, HTTP error status codes, non-JSON, and wrong envelopes exit 1 without success output', async () => {
  const cases: Array<{
    name: string;
    response: () => Response;
    expectedCode: string;
    expectedStatus?: number;
  }> = [
    {
      name: 'HTTP 301 Redirect',
      response: () => new Response(null, { status: 301, headers: { Location: '/redirect' } }),
      expectedCode: 'REDIRECT_REJECTED',
      expectedStatus: 301,
    },
    {
      name: 'HTTP 302 Redirect',
      response: () => new Response(null, { status: 302, headers: { Location: '/redirect' } }),
      expectedCode: 'REDIRECT_REJECTED',
      expectedStatus: 302,
    },
    {
      name: 'HTTP 401 Unauthorized',
      response: () =>
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid admin token' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      expectedCode: 'UNAUTHORIZED',
      expectedStatus: 401,
    },
    {
      name: 'HTTP 403 Forbidden',
      response: () =>
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Forbidden access' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      expectedCode: 'FORBIDDEN',
      expectedStatus: 403,
    },
    {
      name: 'HTTP 404 Not Found',
      response: () =>
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Item not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      expectedCode: 'NOT_FOUND',
      expectedStatus: 404,
    },
    {
      name: 'HTTP 409 Conflict',
      response: () =>
        new Response(
          JSON.stringify({ error: { code: 'CONFLICT', message: 'Slug already in use by another page' } }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      expectedCode: 'CONFLICT',
      expectedStatus: 409,
    },
    {
      name: 'HTTP 429 Rate Limit',
      response: () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      expectedCode: 'RATE_LIMITED',
      expectedStatus: 429,
    },
    {
      name: 'HTTP 500 Internal Server Error',
      response: () =>
        new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Database query failed' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      expectedCode: 'INTERNAL',
      expectedStatus: 500,
    },
    {
      name: 'Non-JSON response (e.g. HTML gateway error)',
      response: () =>
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
      expectedCode: 'HTTP_ERROR',
      expectedStatus: 502,
    },
    {
      name: 'Wrong envelope 200 response',
      response: () =>
        new Response(JSON.stringify({ wrong_key: 'some data' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      expectedCode: 'INVALID_RESPONSE',
      expectedStatus: 200,
    },
  ];

  for (const tc of cases) {
    const io = createCaptureIO();
    const mockFetch: typeof fetch = async () => tc.response();
    const code = await run(
      ['settings', 'get'],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'valid-token' },
      io,
      mockFetch,
    );
    assert.equal(code, 1, `Expected exit 1 for ${tc.name}`);
    assert.equal(io.stdoutData, '', `stdout must be empty on error for ${tc.name}`);
    const errObj = JSON.parse(io.stderrData);
    assert.equal(errObj.error.code, tc.expectedCode, `Expected code ${tc.expectedCode} for ${tc.name}`);
    if (tc.expectedStatus !== undefined) {
      assert.equal(errObj.error.status, tc.expectedStatus, `Expected status ${tc.expectedStatus} for ${tc.name}`);
    }
  }
});

test('Transport - Fetch network failure, whole-response deadline timeout, and single mutation attempt', async () => {
  // 1. Fetch network rejection
  {
    const io = createCaptureIO();
    const mockFetch: typeof fetch = async () => {
      const error = new Error('connect ECONNREFUSED with password=FAKE_TRANSPORT_SECRET');
      (error as Error & { code?: string }).code = 'ECONNREFUSED';
      throw error;
    };
    const code = await run(
      ['settings', 'get'],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'token' },
      io,
      mockFetch,
    );
    assert.equal(code, 1);
    assert.equal(io.stdoutData, '');
    const errObj = JSON.parse(io.stderrData);
    assert.equal(errObj.error.code, 'NETWORK_ERROR');
    assert.equal(errObj.error.message, 'Network request failed (ECONNREFUSED)');
    assert.ok(!io.stderrData.includes('FAKE_TRANSPORT_SECRET'));
  }

  // 2. Deadline exceeded during response body consumption
  {
    const io = createCaptureIO();
    let streamCancelled = false;
    const slowStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"settings":'));
        // Never enqueue the rest; simulate stalled stream
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(slowStream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const code = await run({
      argv: ['settings', 'get'],
      env: { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'token' },
      stdout: io.stdout,
      stderr: io.stderr,
      fetchFn: mockFetch,
      timeoutMs: 50, // Short injected deadline
    });

    assert.equal(code, 1);
    assert.equal(io.stdoutData, '');
    const errObj = JSON.parse(io.stderrData);
    assert.equal(errObj.error.code, 'TIMEOUT');
    assert.match(errObj.error.message, /deadline/);
    assert.equal(streamCancelled, true, 'Unconsumed stream must be cancelled when timing out');
  }

  // 3. Single mutation attempt - no retries on failure
  {
    let callCount = 0;
    const mockFetch: typeof fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Fail' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const io = createCaptureIO();
    const code = await run(
      ['monitors', 'delete', '1'],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'token' },
      io,
      mockFetch,
    );
    assert.equal(code, 1);
    assert.equal(callCount, 1, 'Mutation attempt must remain exactly one (no automatic retry)');
  }
});

test('Transport - Credential redaction on both stdout success and stderr error paths', async () => {
  const adminToken = 'SUPER_SECRET_ADMIN_TOKEN_98765';

  // 1. Success path redaction
  {
    const responsePayload = {
      settings: {
        site_title: 'My Uptimer',
        // Response that maliciously or accidentally echoes the admin token
        reflected_token: `Current token is ${adminToken}`,
        // Sensitive keys
        authorization: 'Bearer secret',
        password: 'my-password',
        bot_token: '12345:telegram_token',
        bot_token_encrypted: 'encrypted_bytes',
        api_key: 'stripe_key',
        cookie: 'session=123',
        // Complete redacted values
        http_headers: { 'X-Secret': 'private' },
        http_headers_json: { 'X-Api-Key': 'FAKE_MONITOR_HEADER_SECRET' },
        http_body: 'sensitive payload',
        // Config sensitive keys
        config: {
          url: 'https://hooks.slack.com/services/SECRET',
          headers: { Authorization: 'Bearer webhook_token' },
          payload_template: '{"token": "$SECRET"}',
        },
        // Non-sensitive fields & secret references that MUST remain readable
        config_json: {
          preset: 'custom',
          url: 'https://hooks.example.com/FAKE_HOOK_SECRET',
          headers: { 'X-Api-Key': 'FAKE_CHANNEL_HEADER_SECRET' },
          payload_template: { text: 'FAKE_TEMPLATE_SECRET' },
          chat_id: '@visible_channel',
        },
        bot_token_secret_ref: 'MY_TELEGRAM_SECRET_BINDING',
        signing_secret_ref: 'WEBHOOK_SIGNING_SECRET',
        status: 'active',
      },
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const io = createCaptureIO();
    const code = await run(
      ['settings', 'get'],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: adminToken },
      io,
      mockFetch,
    );
    assert.equal(code, 0);

    const stdout = io.stdoutData;
    assert.ok(!stdout.includes(adminToken), 'Admin token must never appear in stdout');
    for (const leaked of ['FAKE_MONITOR_HEADER_SECRET', 'FAKE_HOOK_SECRET', 'FAKE_CHANNEL_HEADER_SECRET', 'FAKE_TEMPLATE_SECRET']) {
      assert.ok(!stdout.includes(leaked), `stdout must not contain ${leaked}`);
    }
    const result = JSON.parse(stdout);
    const s = result.settings;

    // Verify redactions
    assert.equal(s.reflected_token, 'Current token is [REDACTED]');
    assert.equal(s.authorization, '[REDACTED]');
    assert.equal(s.password, '[REDACTED]');
    assert.equal(s.bot_token, '[REDACTED]');
    assert.equal(s.bot_token_encrypted, '[REDACTED]');
    assert.equal(s.api_key, '[REDACTED]');
    assert.equal(s.cookie, '[REDACTED]');
    assert.equal(s.http_headers, '[REDACTED]');
    assert.equal(s.http_headers_json, '[REDACTED]');
    assert.equal(s.config_json.url, '[REDACTED]');
    assert.equal(s.config_json.headers, '[REDACTED]');
    assert.equal(s.config_json.payload_template, '[REDACTED]');
    assert.equal(s.config_json.chat_id, '@visible_channel');
    assert.equal(s.config_json.preset, 'custom');
    assert.equal(s.http_body, '[REDACTED]');
    assert.equal(s.config.url, '[REDACTED]');
    assert.equal(s.config.headers, '[REDACTED]');
    assert.equal(s.config.payload_template, '[REDACTED]');

    // Verify preserved fields and secret references
    assert.equal(s.site_title, 'My Uptimer');
    assert.equal(s.status, 'active');
    assert.equal(s.bot_token_secret_ref, 'MY_TELEGRAM_SECRET_BINDING');
    assert.equal(s.signing_secret_ref, 'WEBHOOK_SIGNING_SECRET');
  }

  // 2. Error path redaction
  {
    const errorResponse = {
      error: {
        code: 'UNAUTHORIZED',
        message: `Token ${adminToken} was rejected by server`,
      },
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(errorResponse), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const io = createCaptureIO();
    const code = await run(
      ['settings', 'get'],
      { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: adminToken },
      io,
      mockFetch,
    );
    assert.equal(code, 1);
    assert.equal(io.stdoutData, '');

    const stderr = io.stderrData;
    assert.ok(!stderr.includes(adminToken), 'Admin token must never appear in stderr');
    const errObj = JSON.parse(stderr);
    assert.equal(errObj.error.code, 'UNAUTHORIZED');
    assert.equal(errObj.error.message, 'Token [REDACTED] was rejected by server');
    assert.equal(errObj.error.status, 401);
  }
});

test('Transport - reflected credential keys are redacted', async () => {
  const adminToken = 'FAKE_REFLECTED_ADMIN_TOKEN';
  const mockFetch: typeof fetch = async () =>
    Response.json({ settings: { [adminToken]: 'value', site_locale: 'en' } });

  const io = createCaptureIO();
  const code = await run(
    ['settings', 'get'],
    { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: adminToken },
    io,
    mockFetch,
  );

  assert.equal(code, 0);
  assert.ok(!io.stdoutData.includes(adminToken), 'token must not survive as an object key');
  assert.deepEqual(JSON.parse(io.stdoutData).settings, { '[REDACTED]': 'value', site_locale: 'en' });
});

test('Transport - redirected responses release their body', async () => {
  let cancelled = false;
  const mockFetch: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 302, headers: { Location: 'https://other.example.com' } },
    );

  const io = createCaptureIO();
  const code = await run(
    ['settings', 'get'],
    { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'token' },
    io,
    mockFetch,
  );

  assert.equal(code, 1);
  assert.equal(JSON.parse(io.stderrData).error.code, 'REDIRECT_REJECTED');
  assert.equal(cancelled, true, 'rejected redirect must cancel its body');
});

test('Transport - a stalled body whose cancellation never settles still exits', async () => {
  const mockFetch: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"settings":'));
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const io = createCaptureIO();
  const runPromise = run({
    argv: ['settings', 'get'],
    env: { UPTIMER_URL: 'https://example.com', UPTIMER_ADMIN_TOKEN: 'token' },
    stdout: io.stdout,
    stderr: io.stderr,
    fetchFn: mockFetch,
    timeoutMs: 20,
  });

  const outcome = await Promise.race([
    runPromise,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
  ]);

  assert.equal(outcome, 1, 'deadline must terminate even when stream cancellation never settles');
  assert.equal(JSON.parse(io.stderrData).error.code, 'TIMEOUT');
});
