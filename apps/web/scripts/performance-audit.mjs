// No package dependencies. Start a dedicated Chrome with --headless=new
// --remote-debugging-port=9237 --user-data-dir=/tmp/uptimer-perf-chrome, then:
// node apps/web/scripts/performance-audit.mjs <dist-directory> <output.json>
// This is a deterministic browser/network benchmark, not a Lighthouse score
// or a substitute for deployed Cloudflare CPU / D1 metrics.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = resolve(process.argv[2] ?? 'apps/web/dist');
const output = resolve(process.argv[3] ?? '/tmp/uptimer-browser-audit.json');
const browserPort = Number(process.env.UPTIMER_CHROME_PORT ?? 9237);
const now = Math.floor(Date.now() / 1000);
const day = Math.floor(now / 86400) * 86400;
function homepage(live) {
  const generated = Math.floor(Date.now() / 1000) - (live ? 5 : 30);
  return {
    generated_at: generated,
    bootstrap_mode: 'full',
    monitor_count_total: 30,
    site_title: 'Uptimer benchmark',
    site_description: '30 monitors, complete history',
    site_locale: 'en',
    site_timezone: 'UTC',
    uptime_rating_level: 3,
    overall_status: 'up',
    banner: {
      source: 'monitors',
      status: 'operational',
      title: 'All Systems Operational',
      down_ratio: 0,
    },
    summary: { up: 30, down: 0, paused: 0, maintenance: 0, unknown: 0 },
    monitors: Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `API ${String(i + 1).padStart(2, '0')} · ${live ? 'live' : 'snapshot'}`,
      type: 'http',
      display_url: null,
      group_name: 'Services',
      status: 'up',
      is_stale: false,
      last_checked_at: generated,
      heartbeat_strip: {
        checked_at: Array.from({ length: 60 }, (_, j) => generated - j * 60),
        status_codes: 'u'.repeat(60),
        latency_ms: Array.from({ length: 60 }, (_, j) => 40 + ((j * 13 + i) % 160)),
      },
      uptime_30d: { uptime_pct: 99.99 },
      uptime_day_strip: {
        day_start_at: Array.from({ length: 60 }, (_, j) => day - (59 - j) * 86400),
        downtime_sec: Array(60).fill(0),
        unknown_sec: Array(60).fill(0),
        uptime_pct_milli: Array(60).fill(100000),
      },
    })),
    active_incidents: [],
    maintenance_windows: { active: [], upcoming: [] },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  };
}
const calls = [];
const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const path = requestUrl.pathname;
  const send = (body, type) => {
    const data = gzipSync(Buffer.from(body));
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  };
  if (path.startsWith('/api/')) {
    calls.push({ path, at: Date.now() });
    setTimeout(() => {
      const payload = path.endsWith('/homepage')
        ? homepage(true)
        : path.endsWith('/outages')
          ? { range: '30d', outages: [], next_cursor: null }
          : path.endsWith('/day-context')
            ? {
                day_start_at: Number(requestUrl.searchParams.get('day_start_at')),
                maintenance_windows: [],
                incidents: [],
              }
            : {
                monitor: { id: 1, name: 'API 01' },
                range: '24h',
                range_start_at: now - 86400,
                range_end_at: now,
                avg_latency_ms: 100,
                p95_latency_ms: 190,
                points: Array.from({ length: 1440 }, (_, i) => ({
                  checked_at: now - 86400 + i * 60,
                  status: 'up',
                  latency_ms: 40 + ((i * 13) % 160),
                })),
              };
      send(JSON.stringify(payload), 'application/json');
    }, 150);
    return;
  }
  try {
    const file = path.startsWith('/assets/')
      ? resolve(dist, '.' + path)
      : resolve(dist, 'index.html');
    if (!file.startsWith(dist + '/')) throw new Error('Invalid path');
    let body = await readFile(file);
    if (file.endsWith('index.html')) {
      body = Buffer.from(
        body
          .toString()
          .replace(
            '</head>',
            `<script>globalThis.__UPTIMER_INITIAL_HOMEPAGE__=${JSON.stringify(homepage(false))}</script></head>`,
          ),
      );
    }
    send(
      body,
      { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] ??
        'application/octet-stream',
    );
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(Number(process.env.UPTIMER_PERF_PORT ?? 0), '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes('--serve')) {
  console.log(url);
  await new Promise(() => {});
}
const version = await (await fetch(`http://127.0.0.1:${browserPort}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => {
  socket.onopen = r;
  socket.onerror = j;
});
let id = 0;
const pending = new Map();
const traceEvents = [];
let traceCompleted;
socket.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Tracing.dataCollected') traceEvents.push(...m.params.value);
  if (m.method === 'Tracing.tracingComplete') traceCompleted?.();
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
try {
  for (let run = 0; run < 3; run++) {
    const { browserContextId } = await send('Target.createBrowserContext');
    try {
      const { targetId } = await send('Target.createTarget', {
        url: 'about:blank',
        browserContextId,
      });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const c = (m, p) => send(m, p, sessionId);
      const evaluate = async (expression) => {
        const r = await c('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      };
      await c('Page.enable');
      await c('Page.bringToFront');
      await c('Emulation.setFocusEmulationEnabled', { enabled: true });
      const motionPreference = process.env.UPTIMER_PERF_MOTION;
      if (motionPreference) {
        if (!['reduce', 'no-preference'].includes(motionPreference))
          throw new Error('Invalid motion preference');
        await c('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: motionPreference }],
        });
      }
      await c('Network.enable');
      await c('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: 200000,
        uploadThroughput: 93750,
      });
      await c('Emulation.setCPUThrottlingRate', { rate: 4 });
      await c('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await c('Page.addScriptToEvaluateOnNewDocument', {
        source: `globalThis.audit={lcp:0,cls:0,longTaskMs:0}; new PerformanceObserver(l=>{for(const e of l.getEntries())audit.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)audit.cls+=e.value}).observe({type:'layout-shift',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())audit.longTaskMs+=Math.max(0,e.duration-50)}).observe({type:'longtask',buffered:true});`,
      });
      const captureTrace = run === 0 && process.env.UPTIMER_PERF_TRACE;
      if (captureTrace)
        await send('Tracing.start', {
          categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline',
          transferMode: 'ReportEvents',
        });
      const captureCpu = run === 0 && process.env.UPTIMER_PERF_CPU_PROFILE;
      if (captureCpu) {
        await c('Profiler.enable');
        await c('Profiler.setSamplingInterval', { interval: 100 });
        await c('Profiler.start');
      }
      const callStart = calls.length;
      await c('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      await c('Page.navigate', { url });
      let firstReady = 0;
      for (let i = 0; i < 200; i++) {
        firstReady = await evaluate(
          `document.querySelector('[role="button"] h3') ? performance.now() : 0`,
        );
        if (firstReady) break;
        await sleep(100);
      }
      if (!firstReady) throw new Error('Status page did not render');
      let freshReadyMs = 0;
      for (let i = 0; i < 18; i++) {
        if (!freshReadyMs)
          freshReadyMs = await evaluate(
            `document.body.innerText.includes('API 01 · live') ? performance.now() : 0`,
          );
        await sleep(100);
      }
      if (captureCpu) {
        const { profile } = await c('Profiler.stop');
        await writeFile(process.env.UPTIMER_PERF_CPU_PROFILE, JSON.stringify(profile));
        await c('Profiler.disable');
      }
      if (captureTrace) {
        const complete = new Promise((resolve) => {
          traceCompleted = resolve;
        });
        await send('Tracing.end');
        await complete;
        await writeFile(process.env.UPTIMER_PERF_TRACE, JSON.stringify({ traceEvents }));
      }
      const freshness = await evaluate(
        `({live:document.body.innerText.includes('API 01 · live'),...audit})`,
      );
      const screenshot = async (name) => {
        if (!process.env.UPTIMER_PERF_SCREENSHOT_DIR || run !== 0) return;
        await mkdir(process.env.UPTIMER_PERF_SCREENSHOT_DIR, { recursive: true });
        const shot = await c('Page.captureScreenshot', { format: 'png' });
        await writeFile(
          resolve(process.env.UPTIMER_PERF_SCREENSHOT_DIR, `${name}.png`),
          Buffer.from(shot.data, 'base64'),
        );
      };
      await screenshot('homepage');
      let dateFocusSkippedChartPrefetch = null;
      if (process.env.UPTIMER_PERF_INTERACTIONS === '1' && run === 0) {
        const before = calls.length;
        await evaluate(
          `(()=>{const el=document.querySelector('button[aria-label^="Uptime:"]');el.blur();el.focus();return true})()`,
        );
        await sleep(150);
        dateFocusSkippedChartPrefetch = !calls
          .slice(before)
          .some((call) => call.path.includes('/latency'));
        if (!dateFocusSkippedChartPrefetch)
          throw new Error('Date focus started an unrelated latency request');
        await evaluate(`document.activeElement.blur();true`);
      }
      const clickAt = await evaluate(
        `(()=>{const el=[...document.querySelectorAll('[role="button"]')].find(el=>el.querySelector('h3'));el.click();return performance.now()})()`,
      );
      let chartReady = 0;
      for (let i = 0; i < 200; i++) {
        chartReady = await evaluate(
          `document.querySelector('.recharts-line-curve') ? performance.now() : 0`,
        );
        if (chartReady) break;
        await sleep(100);
      }
      const metrics = await evaluate(
        `({paints:performance.getEntriesByType('paint').map(e=>({name:e.name,ms:e.startTime})),scripts:performance.getEntriesByType('resource').filter(e=>e.initiatorType==='script').map(e=>({name:e.name.split('/').pop(),bytes:e.encodedBodySize,start:e.startTime,end:e.responseEnd})),...audit})`,
      );
      let motion = null;
      if (motionPreference && run === 0) {
        const dash = () =>
          evaluate(
            `document.querySelector('.recharts-line-curve')?.getAttribute('stroke-dasharray') ?? null`,
          );
        const initial = await dash();
        await sleep(400);
        const next = await dash();
        if (motionPreference === 'reduce' && (initial || next))
          throw new Error('Reduced motion still animates the curve');
        if (motionPreference === 'no-preference' && (!initial || initial === next))
          throw new Error('Normal curve animation did not advance');
        await c('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await sleep(150);
        const disabledLive = !(await dash());
        if (!disabledLive) throw new Error('Changing the system preference did not stop animation');
        motion = {
          preference: motionPreference,
          animated: !!initial,
          advanced: initial !== next,
          disabledLive,
        };
      }
      let interactions = null;
      if (process.env.UPTIMER_PERF_INTERACTIONS === '1' && run === 0) {
        if (!chartReady) throw new Error('Latency chart did not render');
        await screenshot('chart');
        await evaluate(`document.querySelector('.ui-modal-panel button').click();true`);
        const dayButtons = await evaluate(
          `document.querySelectorAll('button[aria-label^="Uptime:"]').length`,
        );
        if (dayButtons !== 30 * 60) throw new Error(`Missing date buttons: ${dayButtons}`);
        const beforeScroll = await evaluate('document.documentElement.scrollHeight');
        const offscreenFocus = await evaluate(
          `(()=>{const b=[...document.querySelectorAll('button[aria-label^="Uptime:"]')].at(-1);b.focus();return document.activeElement===b})()`,
        );
        await sleep(100);
        const afterScroll = await evaluate('document.documentElement.scrollHeight');
        if (!offscreenFocus || Math.abs(beforeScroll - afterScroll) > 1)
          throw new Error('Offscreen date focus changed the page geometry');
        await evaluate('document.activeElement.blur();window.scrollTo(0,0);true');
        await c('Accessibility.enable');
        const tree = await c('Accessibility.getFullAXTree');
        const accessibleDates = tree.nodes.filter(
          (n) => n.role?.value === 'button' && n.name?.value?.startsWith('Uptime:'),
        ).length;
        if (accessibleDates !== 1800)
          throw new Error('Offscreen date controls missing from accessibility tree');

        await evaluate(
          `(()=>{const el=document.querySelector('button[aria-label^="Uptime:"]');el.blur();el.focus();return true})()`,
        );
        await sleep(100);
        const focusTooltip = await evaluate(`document.body.innerText.includes('100.000%')`);
        await evaluate(
          `document.querySelector('button[aria-label^="Uptime:"]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));true`,
        );
        await sleep(100);
        const focusedTooltipAfterPointerExit = await evaluate(
          `document.body.innerText.includes('100.000%')`,
        );
        if (!focusedTooltipAfterPointerExit)
          throw new Error('Pointer exit dismissed the focused date hint');
        const tooltipBounds = await evaluate(
          `(()=>{const r=[...document.querySelectorAll('body > div')].find(el=>el.innerText.includes('100.000%'))?.getBoundingClientRect();return r ? {left:r.left,right:r.right,width:innerWidth} : null})()`,
        );
        if (!tooltipBounds || tooltipBounds.left < 0 || tooltipBounds.right > tooltipBounds.width)
          throw new Error(`Tooltip clipped: ${JSON.stringify(tooltipBounds)}`);
        await screenshot('date-tooltip');
        await evaluate(
          `(()=>{const el=document.querySelector('button[aria-label^="Uptime:"]');el.blur();el.scrollIntoView({block:'start'});el.focus({preventScroll:true});return true})()`,
        );
        await sleep(100);
        const topTooltipBounds = await evaluate(
          `(()=>{const r=[...document.querySelectorAll('body > div')].find(el=>el.innerText.includes('100.000%'))?.getBoundingClientRect();return r ? {top:r.top,bottom:r.bottom,height:innerHeight} : null})()`,
        );
        if (
          !topTooltipBounds ||
          topTooltipBounds.top < 0 ||
          topTooltipBounds.bottom > topTooltipBounds.height
        )
          throw new Error(`Tooltip clipped vertically: ${JSON.stringify(topTooltipBounds)}`);
        await screenshot('date-tooltip-top');
        await evaluate(
          `(()=>{const el=document.querySelector('button[aria-label^="Uptime:"]');el.blur();window.scrollTo(0,0);el.focus({preventScroll:true});return true})()`,
        );
        await c('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          text: '\r',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        });
        await c('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        });
        await sleep(750);
        const dayDetail = await evaluate(
          `({open:!!document.querySelector('.ui-modal-panel'),empty:document.body.innerText.includes('No downtime recorded for this day.'),chart:!!document.querySelector('.recharts-line-curve'),tooltip:document.body.innerText.includes('100.000%')})`,
        );
        if (
          !focusTooltip ||
          !dayDetail.open ||
          !dayDetail.empty ||
          dayDetail.chart ||
          dayDetail.tooltip
        )
          throw new Error(
            `Date keyboard interaction failed: ${JSON.stringify({ focusTooltip, ...dayDetail })}`,
          );
        await screenshot('day-detail');
        const curveReadsBeforeReopen = calls.filter(
          (call) => call.path === '/api/v1/public/monitors/1/latency',
        ).length;
        await evaluate(`document.querySelector('.ui-modal-panel button').click();true`);
        await evaluate(`document.querySelector('[role="button"]:has(h3)').focus();true`);
        await c('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: ' ',
          text: ' ',
          code: 'Space',
          windowsVirtualKeyCode: 32,
        });
        await c('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: ' ',
          code: 'Space',
          windowsVirtualKeyCode: 32,
        });
        await sleep(300);
        const keyboardChart = await evaluate(`!!document.querySelector('.recharts-line-curve')`);
        if (!keyboardChart) throw new Error('Card Space activation did not reopen latency chart');
        await sleep(350);
        if (
          calls.filter((call) => call.path === '/api/v1/public/monitors/1/latency').length !==
          curveReadsBeforeReopen + 1
        )
          throw new Error('Reopening a prefetched curve did not revalidate exactly once');
        interactions = {
          dateFocusSkippedChartPrefetch,
          focusedTooltipAfterPointerExit,
          dayButtons,
          focusTooltip,
          tooltipBounds,
          topTooltipBounds,
          dayDetail,
          keyboardChart,
        };
      }
      let offline = null;
      if (process.env.UPTIMER_PERF_OFFLINE === '1' && run === 0) {
        await screenshot('chart');
        await c('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        });
        await evaluate(
          `window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('visibilitychange'));true`,
        );
        await sleep(1000);
        offline = await evaluate(
          `({readable:document.body.innerText.includes('API 01 · live'),notice:document.body.innerText.includes('Showing saved data'),curveNotice:document.querySelector('.ui-modal-panel [role="status"]')?.textContent.includes('Showing saved data')})`,
        );
        await screenshot('offline');
        if (!offline.readable || !offline.notice || !offline.curveNotice)
          throw new Error(`Offline UI failed: ${JSON.stringify(offline)}`);
      }
      results.push({
        run,
        interactions,
        motion,
        offline,
        firstReadyMs: Math.round(firstReady),
        freshReadyMs: freshReadyMs ? Math.round(freshReadyMs) : null,
        liveWithin1800ms: freshness.live,
        chartReadyMs: chartReady ? Math.round(chartReady - clickAt) : null,
        requests: calls.slice(callStart).map((x) => x.path),
        ...metrics,
      });
      console.log(
        JSON.stringify({
          run,
          firstReadyMs: Math.round(firstReady),
          freshReadyMs: freshReadyMs ? Math.round(freshReadyMs) : null,
          liveWithin1800ms: freshness.live,
          chartReadyMs: Math.round(chartReady - clickAt),
        }),
      );
    } finally {
      await send('Target.disposeBrowserContext', { browserContextId });
    }
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        browser: version.Browser,
        conditions: {
          monitors: 30,
          intervalSeconds: 60,
          latencyMs: 150,
          downloadBytesPerSecond: 200000,
          cpuSlowdown: 4,
        },
        results,
      },
      null,
      2,
    ),
  );
} finally {
  socket.close();
  await new Promise((r) => server.close(r));
}
