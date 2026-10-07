import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { emitTelemetry } from './telemetry.js';
import { cancellationErrorFromSignal, throwIfTaskCancelled } from './task-cancellation.js';
import { withRuntimeResource } from '../config/runtime.js';

export function resolveBrowserExecutable(explicit) {
  const candidate = typeof explicit === 'string' ? explicit : explicit?.executablePath;
  const found = [candidate, process.env.BROWSER_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
  if (!found) throw new Error('未找到 Chrome，请设置 BROWSER_EXECUTABLE');
  return found;
}

export async function screenshotHtml(html, target, config, { width = 900, height = 383, signal, onTelemetry } = {}) {
  return withRuntimeResource('browser', () => screenshotLocked(html, target, config, { width, height, signal, onTelemetry }), signal);
}

async function screenshotLocked(html, target, config, { width, height, signal, onTelemetry }) {
  throwIfTaskCancelled(signal);
  const started = performance.now();
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(config.browser), headless: true });
  const abortBrowser = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abortBrowser, { once: true });
  try {
    throwIfTaskCancelled(signal);
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.screenshot({ path: target });
    throwIfTaskCancelled(signal);
  } catch (error) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortBrowser);
    await browser.close().catch(() => {});
    emitTelemetry(onTelemetry, { stage: 'html-screenshot', count: 1, durationMs: performance.now() - started });
  }
}
