import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
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

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

test('Resource operations - stateful CRUD round trip for monitors, groups, pause/resume, and field preservation', async () => {
  const capturedRequests: CapturedRequest[] = [];
  const store: Record<number, Record<string, unknown>> = {};
  let nextId = 1;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;

    capturedRequests.push({ url: url.toString(), method, headers, body });

    const p = url.pathname;

    // POST /monitors
    if (p === '/api/v1/admin/monitors' && method === 'POST') {
      const id = nextId++;
      const record = { id, ...body };
      store[id] = record;
      return new Response(JSON.stringify({ monitor: record }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /monitors
    if (p === '/api/v1/admin/monitors' && method === 'GET') {
      const list = Object.values(store);
      return new Response(JSON.stringify({ monitors: list }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // PATCH /monitors/:id
    const patchMatch = p.match(/^\/api\/v1\/admin\/monitors\/(\d+)$/);
    if (patchMatch && method === 'PATCH') {
      const id = Number(patchMatch[1]);
      const existing = store[id] ?? { id };
      const updated = { ...existing, ...body };
      store[id] = updated;
      return new Response(JSON.stringify({ monitor: updated }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /monitors/:id/pause
    const pauseMatch = p.match(/^\/api\/v1\/admin\/monitors\/(\d+)\/pause$/);
    if (pauseMatch && method === 'POST') {
      const id = Number(pauseMatch[1]);
      const existing = store[id] ?? { id };
      existing.status = 'paused';
      return new Response(JSON.stringify({ monitor: existing }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /monitors/:id/resume
    const resumeMatch = p.match(/^\/api\/v1\/admin\/monitors\/(\d+)\/resume$/);
    if (resumeMatch && method === 'POST') {
      const id = Number(resumeMatch[1]);
      const existing = store[id] ?? { id };
      existing.status = 'active';
      return new Response(JSON.stringify({ monitor: existing }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // DELETE /monitors/:id
    const deleteMatch = p.match(/^\/api\/v1\/admin\/monitors\/(\d+)$/);
    if (deleteMatch && method === 'DELETE') {
      const id = Number(deleteMatch[1]);
      delete store[id];
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /monitors/groups/reorder
    if (p === '/api/v1/admin/monitors/groups/reorder' && method === 'POST') {
      return new Response(JSON.stringify({ updated_groups: 2, affected_monitors: 5 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /monitors/groups/assign
    if (p === '/api/v1/admin/monitors/groups/assign' && method === 'POST') {
      return new Response(
        JSON.stringify({ group_name: body.group_name, group_sort_order: 1, updated_monitors: 2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uptimer-monitors-'));
  const env = { UPTIMER_URL: 'https://uptimer.example.com', UPTIMER_ADMIN_TOKEN: 'test-token' };

  try {
    // 1. Create monitor
    const createPayload = {
      name: 'API Service',
      type: 'http',
      url: 'https://api.example.com/health',
      interval_seconds: 60,
    };
    const createFile = path.join(tempDir, 'create-monitor.json');
    await fs.writeFile(createFile, JSON.stringify(createPayload), 'utf8');

    const ioCreate = createCaptureIO();
    const codeCreate = await run(['monitors', 'create', '--file', createFile], env, ioCreate, mockFetch);
    assert.equal(codeCreate, 0);
    const createdResult = JSON.parse(ioCreate.stdoutData);
    assert.equal(createdResult.monitor.id, 1);
    assert.equal(createdResult.monitor.name, 'API Service');

    // 2. Update monitor (verifying preservation of null, false, 0, [], and omitted fields)
    const updatePayload = {
      description: null,
      active: false,
      retry_count: 0,
      tags: [],
    };
    const updateFile = path.join(tempDir, 'update-monitor.json');
    await fs.writeFile(updateFile, JSON.stringify(updatePayload), 'utf8');

    const ioUpdate = createCaptureIO();
    const codeUpdate = await run(['monitors', 'update', '1', '--file', updateFile], env, ioUpdate, mockFetch);
    assert.equal(codeUpdate, 0);
    const updatedResult = JSON.parse(ioUpdate.stdoutData);
    // Explicit values preserved
    assert.equal(updatedResult.monitor.description, null);
    assert.equal(updatedResult.monitor.active, false);
    assert.equal(updatedResult.monitor.retry_count, 0);
    assert.deepEqual(updatedResult.monitor.tags, []);
    // Pre-existing un-updated fields preserved
    assert.equal(updatedResult.monitor.name, 'API Service');
    assert.equal(updatedResult.monitor.url, 'https://api.example.com/health');

    // 3. Pause & Resume
    const ioPause = createCaptureIO();
    const codePause = await run(['monitors', 'pause', '1'], env, ioPause, mockFetch);
    assert.equal(codePause, 0);
    assert.equal(JSON.parse(ioPause.stdoutData).monitor.status, 'paused');

    const ioResume = createCaptureIO();
    const codeResume = await run(['monitors', 'resume', '1'], env, ioResume, mockFetch);
    assert.equal(codeResume, 0);
    assert.equal(JSON.parse(ioResume.stdoutData).monitor.status, 'active');

    // 4. Groups reorder & assign
    const reorderFile = path.join(tempDir, 'reorder.json');
    await fs.writeFile(reorderFile, JSON.stringify({ groups: [{ name: 'Core', sort_order: 1 }] }), 'utf8');
    const ioReorder = createCaptureIO();
    const codeReorder = await run(['monitors', 'groups', 'reorder', '--file', reorderFile], env, ioReorder, mockFetch);
    assert.equal(codeReorder, 0);
    assert.equal(JSON.parse(ioReorder.stdoutData).updated_groups, 2);

    const assignFile = path.join(tempDir, 'assign.json');
    await fs.writeFile(assignFile, JSON.stringify({ monitor_ids: [1], group_name: 'Core' }), 'utf8');
    const ioAssign = createCaptureIO();
    const codeAssign = await run(['monitors', 'groups', 'assign', '--file', assignFile], env, ioAssign, mockFetch);
    assert.equal(codeAssign, 0);
    assert.equal(JSON.parse(ioAssign.stdoutData).group_name, 'Core');

    // 5. List monitors
    const ioList = createCaptureIO();
    const codeList = await run(['monitors', 'list', '--limit', '20'], env, ioList, mockFetch);
    assert.equal(codeList, 0);
    const listResult = JSON.parse(ioList.stdoutData);
    assert.equal(listResult.monitors.length, 1);

    // 6. Delete monitor
    const ioDelete = createCaptureIO();
    const codeDelete = await run(['monitors', 'delete', '1'], env, ioDelete, mockFetch);
    assert.equal(codeDelete, 0);
    assert.equal(JSON.parse(ioDelete.stdoutData).deleted, true);

    // List after delete shows empty
    const ioListAfter = createCaptureIO();
    await run(['monitors', 'list'], env, ioListAfter, mockFetch);
    assert.equal(JSON.parse(ioListAfter.stdoutData).monitors.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Resource operations - stateful CRUD round trip for notification channels', async () => {
  const store: Record<number, Record<string, unknown>> = {};
  let nextId = 1;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    const p = url.pathname;

    if (p === '/api/v1/admin/notification-channels' && method === 'POST') {
      const id = nextId++;
      const record = { id, ...body };
      store[id] = record;
      return new Response(JSON.stringify({ notification_channel: record }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (p === '/api/v1/admin/notification-channels' && method === 'GET') {
      return new Response(JSON.stringify({ notification_channels: Object.values(store) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const itemMatch = p.match(/^\/api\/v1\/admin\/notification-channels\/(\d+)$/);
    if (itemMatch && method === 'PATCH') {
      const id = Number(itemMatch[1]);
      const updated = { ...(store[id] ?? { id }), ...body };
      store[id] = updated;
      return new Response(JSON.stringify({ notification_channel: updated }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (itemMatch && method === 'DELETE') {
      const id = Number(itemMatch[1]);
      delete store[id];
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 });
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uptimer-channels-'));
  const env = { UPTIMER_URL: 'https://uptimer.example.com', UPTIMER_ADMIN_TOKEN: 'test-token' };

  try {
    // Create
    const createFile = path.join(tempDir, 'create-channel.json');
    await fs.writeFile(
      createFile,
      JSON.stringify({ name: 'Slack Alerts', type: 'webhook', config: { url: 'https://slack.com' } }),
      'utf8',
    );
    const ioCreate = createCaptureIO();
    const codeCreate = await run(['notification-channels', 'create', '--file', createFile], env, ioCreate, mockFetch);
    assert.equal(codeCreate, 0);
    assert.equal(JSON.parse(ioCreate.stdoutData).notification_channel.id, 1);

    // Update
    const updateFile = path.join(tempDir, 'update-channel.json');
    await fs.writeFile(updateFile, JSON.stringify({ name: 'Updated Slack' }), 'utf8');
    const ioUpdate = createCaptureIO();
    const codeUpdate = await run(['notification-channels', 'update', '1', '--file', updateFile], env, ioUpdate, mockFetch);
    assert.equal(codeUpdate, 0);
    assert.equal(JSON.parse(ioUpdate.stdoutData).notification_channel.name, 'Updated Slack');

    // List
    const ioList = createCaptureIO();
    const codeList = await run(['notification-channels', 'list'], env, ioList, mockFetch);
    assert.equal(codeList, 0);
    assert.equal(JSON.parse(ioList.stdoutData).notification_channels.length, 1);

    // Delete
    const ioDelete = createCaptureIO();
    const codeDelete = await run(['notification-channels', 'delete', '1'], env, ioDelete, mockFetch);
    assert.equal(codeDelete, 0);
    assert.equal(JSON.parse(ioDelete.stdoutData).deleted, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Resource operations - stateful CRUD round trip for status pages', async () => {
  const store: Record<number, Record<string, unknown>> = {};
  let nextId = 1;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    const p = url.pathname;

    if (p === '/api/v1/admin/status-pages' && method === 'POST') {
      const id = nextId++;
      const record = { id, ...body };
      store[id] = record;
      return new Response(JSON.stringify({ status_page: record }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (p === '/api/v1/admin/status-pages' && method === 'GET') {
      return new Response(JSON.stringify({ status_pages: Object.values(store) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const itemMatch = p.match(/^\/api\/v1\/admin\/status-pages\/(\d+)$/);
    if (itemMatch && method === 'PATCH') {
      const id = Number(itemMatch[1]);
      const updated = { ...(store[id] ?? { id }), ...body };
      store[id] = updated;
      return new Response(JSON.stringify({ status_page: updated }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (itemMatch && method === 'DELETE') {
      const id = Number(itemMatch[1]);
      delete store[id];
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 });
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uptimer-pages-'));
  const env = { UPTIMER_URL: 'https://uptimer.example.com', UPTIMER_ADMIN_TOKEN: 'test-token' };

  try {
    // Create
    const createFile = path.join(tempDir, 'create-page.json');
    await fs.writeFile(
      createFile,
      JSON.stringify({ title: 'Main Status', slug: 'status', is_public: true }),
      'utf8',
    );
    const ioCreate = createCaptureIO();
    const codeCreate = await run(['status-pages', 'create', '--file', createFile], env, ioCreate, mockFetch);
    assert.equal(codeCreate, 0);
    assert.equal(JSON.parse(ioCreate.stdoutData).status_page.slug, 'status');

    // Update
    const updateFile = path.join(tempDir, 'update-page.json');
    await fs.writeFile(updateFile, JSON.stringify({ custom_hostname: 'status.example.com' }), 'utf8');
    const ioUpdate = createCaptureIO();
    const codeUpdate = await run(['status-pages', 'update', '1', '--file', updateFile], env, ioUpdate, mockFetch);
    assert.equal(codeUpdate, 0);
    assert.equal(JSON.parse(ioUpdate.stdoutData).status_page.custom_hostname, 'status.example.com');

    // List
    const ioList = createCaptureIO();
    const codeList = await run(['status-pages', 'list'], env, ioList, mockFetch);
    assert.equal(codeList, 0);
    assert.equal(JSON.parse(ioList.stdoutData).status_pages.length, 1);

    // Delete
    const ioDelete = createCaptureIO();
    const codeDelete = await run(['status-pages', 'delete', '1'], env, ioDelete, mockFetch);
    assert.equal(codeDelete, 0);
    assert.equal(JSON.parse(ioDelete.stdoutData).deleted, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Resource operations - get/update round trip for settings and settings uptime-rating', async () => {
  let settingsStore: Record<string, unknown> = {
    site_title: 'Uptimer Initial',
    retention_days: 30,
  };
  let uptimeRatingLevel = 3;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    const p = url.pathname;

    if (p === '/api/v1/admin/settings' && method === 'GET') {
      return new Response(JSON.stringify({ settings: settingsStore }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (p === '/api/v1/admin/settings' && method === 'PATCH') {
      settingsStore = { ...settingsStore, ...body };
      return new Response(JSON.stringify({ settings: settingsStore }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (p === '/api/v1/admin/settings/uptime-rating' && method === 'GET') {
      return new Response(JSON.stringify({ uptime_rating_level: uptimeRatingLevel }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (p === '/api/v1/admin/settings/uptime-rating' && method === 'PUT') {
      uptimeRatingLevel = body.uptime_rating_level;
      return new Response(JSON.stringify({ uptime_rating_level: uptimeRatingLevel }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 });
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uptimer-settings-'));
  const env = { UPTIMER_URL: 'https://uptimer.example.com', UPTIMER_ADMIN_TOKEN: 'test-token' };

  try {
    // 1. Settings GET
    const ioGet = createCaptureIO();
    const codeGet = await run(['settings', 'get'], env, ioGet, mockFetch);
    assert.equal(codeGet, 0);
    assert.equal(JSON.parse(ioGet.stdoutData).settings.site_title, 'Uptimer Initial');

    // 2. Settings PATCH
    const patchFile = path.join(tempDir, 'patch-settings.json');
    await fs.writeFile(patchFile, JSON.stringify({ site_title: 'Updated Site Title', retention_days: 60 }), 'utf8');
    const ioPatch = createCaptureIO();
    const codePatch = await run(['settings', 'update', '--file', patchFile], env, ioPatch, mockFetch);
    assert.equal(codePatch, 0);
    assert.equal(JSON.parse(ioPatch.stdoutData).settings.site_title, 'Updated Site Title');
    assert.equal(JSON.parse(ioPatch.stdoutData).settings.retention_days, 60);

    // Verify GET readback after PATCH
    const ioGetAfter = createCaptureIO();
    await run(['settings', 'get'], env, ioGetAfter, mockFetch);
    assert.equal(JSON.parse(ioGetAfter.stdoutData).settings.site_title, 'Updated Site Title');

    // 3. Uptime Rating GET
    const ioRatingGet = createCaptureIO();
    const codeRatingGet = await run(['settings', 'uptime-rating', 'get'], env, ioRatingGet, mockFetch);
    assert.equal(codeRatingGet, 0);
    assert.equal(JSON.parse(ioRatingGet.stdoutData).uptime_rating_level, 3);

    // 4. Uptime Rating PUT
    const ratingFile = path.join(tempDir, 'put-rating.json');
    await fs.writeFile(ratingFile, JSON.stringify({ uptime_rating_level: 5 }), 'utf8');
    const ioRatingPut = createCaptureIO();
    const codeRatingPut = await run(
      ['settings', 'uptime-rating', 'update', '--file', ratingFile],
      env,
      ioRatingPut,
      mockFetch,
    );
    assert.equal(codeRatingPut, 0);
    assert.equal(JSON.parse(ioRatingPut.stdoutData).uptime_rating_level, 5);

    // Verify GET readback after PUT
    const ioRatingGetAfter = createCaptureIO();
    await run(['settings', 'uptime-rating', 'get'], env, ioRatingGetAfter, mockFetch);
    assert.equal(JSON.parse(ioRatingGetAfter.stdoutData).uptime_rating_level, 5);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Resource operations - unassigning a group succeeds with a null group_name', async () => {
  const mockFetch: typeof fetch = async () =>
    Response.json({ group_name: null, group_sort_order: 0, updated_monitors: 1 });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uptimer-group-null-'));
  try {
    const file = path.join(tempDir, 'assign.json');
    await fs.writeFile(file, JSON.stringify({ monitor_ids: [7], group_name: null }), 'utf8');

    const io = createCaptureIO();
    const code = await run(
      ['monitors', 'groups', 'assign', '--file', file],
      { UPTIMER_URL: 'https://uptimer.example.com', UPTIMER_ADMIN_TOKEN: 'test-token' },
      io,
      mockFetch,
    );

    assert.equal(code, 0);
    assert.equal(JSON.parse(io.stdoutData).group_name, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
