#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

function parseArgs(argv) {
  const out = { url: '', n: 60, mode: '', token: '', concurrency: 1 };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith('-')) {
    out.url = rest[0];
    rest.shift();
  }
  for (let i = 0; i < rest.length; i += 1) {
    const cur = rest[i];
    const next = rest[i + 1];
    if (!cur) continue;
    if (cur === '--n' && next) {
      out.n = Number.parseInt(next, 10) || out.n;
      i += 1;
      continue;
    }
    if (cur === '--mode' && next) {
      out.mode = next;
      i += 1;
      continue;
    }
    if (cur === '--token' && next) {
      out.token = next;
      i += 1;
      continue;
    }
    if (cur === '--concurrency' && next) {
      out.concurrency = Number.parseInt(next, 10) || out.concurrency;
      i += 1;
      continue;
    }
  }
  if (!out.url) out.url = process.env.UPTIMER_TRACE_URL || '';
  if (!out.token) out.token = process.env.UPTIMER_TRACE_TOKEN || '';
  return out;
}

function parseServerTiming(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [namePart, ...rest] = trimmed.split(';');
    const name = (namePart || '').trim();
    if (!name) continue;
    let dur = null;
    for (const it of rest) {
      const kv = it.trim();
      if (kv.startsWith('dur=')) {
        const n = Number.parseFloat(kv.slice('dur='.length));
        if (Number.isFinite(n)) dur = n;
      }
    }
    if (dur !== null) out[name] = dur;
  }
  return out;
}

function parseKvHeader(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = v;
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function formatMs(value) {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(2)}ms`;
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error(
      'Usage: node tools/trace-homepage.mjs <url> [--n 120] [--mode bypass-cache] [--token ...]',
    );
    process.exit(2);
  }

  const headers = {
    Accept: 'text/html',
    'X-Uptimer-Trace': '1',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  if (args.mode) headers['X-Uptimer-Trace-Mode'] = args.mode;
  if (args.token) headers['X-Uptimer-Trace-Token'] = args.token;

  const runs = new Array(args.n);

  async function one(index) {
    const t0 = performance.now();
    const res = await fetch(args.url, { headers, redirect: 'follow' });
    const t1 = performance.now();
    const serverTiming = parseServerTiming(res.headers.get('server-timing') || '');
    const info = parseKvHeader(res.headers.get('x-uptimer-trace') || '');
    const traceId = res.headers.get('x-uptimer-trace-id') || '';
    const body = await res.text();
    return {
      index,
      ok: res.ok,
      status: res.status,
      wall_ms: t1 - t0,
      server_timing: serverTiming,
      info,
      trace_id: traceId,
      html_chars: body.length,
    };
  }

  const concurrency = Math.max(1, Math.min(32, args.concurrency || 1));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, args.n) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= args.n) return;
        runs[index] = await one(index);
      }
    }),
  );

  const okRuns = runs.filter((r) => r.ok);
  const groups = new Map();
  for (const r of okRuns) {
    const g = r.info.p_path || 'unknown';
    const list = groups.get(g) || [];
    list.push(r);
    groups.set(g, list);
  }

  const allMetrics = new Set();
  for (const r of okRuns) {
    for (const k of Object.keys(r.server_timing)) allMetrics.add(k);
  }

  console.log(`url=${args.url}`);
  console.log(
    `n=${runs.length} ok=${okRuns.length} mode=${args.mode || '-'} concurrency=${concurrency}`,
  );
  console.log('');

  for (const [group, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const walls = list.map((r) => r.wall_ms).sort((a, b) => a - b);
    console.log(
      `[${group}] count=${list.length} wall_p50=${formatMs(percentile(walls, 50))} wall_p90=${formatMs(percentile(walls, 90))}`,
    );

    for (const metric of [...allMetrics].sort()) {
      const values = list
        .map((r) => r.server_timing[metric])
        .filter((v) => typeof v === 'number')
        .sort((a, b) => a - b);
      if (values.length === 0) continue;
      const p50 = percentile(values, 50);
      const p90 = percentile(values, 90);
      console.log(`  ${metric}: p50=${formatMs(p50)} p90=${formatMs(p90)} n=${values.length}`);
    }
    console.log('');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
