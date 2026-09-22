import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable, screenshotHtml } from '../src/lib/browser.js';
import { protectMathInMarkdown, renderEquationPngs } from '../src/lib/wechat-math.js';
import { sourceDocumentFromHtml } from '../src/workflows/translation-source-text.js';

let browserExecutable;
try { browserExecutable = resolveBrowserExecutable(); } catch {}
const options = { skip: !browserExecutable, timeout: 30000 };
const svg = (color) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="${color}"/></svg>`).toString('base64')}`;

test('真实 Chrome: 取消表格、图片、公式、封面截图均关闭浏览器，后续任务可取得资源', options, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-render-cancel-'));
  const launch = chromium.launch.bind(chromium);
  try {
    for (const kind of ['table', 'image', 'math', 'cover']) {
      const controller = new AbortController();
      const reason = Object.assign(new Error(`cancel ${kind}`), { code: 'TASK_CANCELLED' });
      const browsers = [];
      const patchPage = (page) => {
        const setContent = page.setContent.bind(page);
        page.setContent = async (...args) => {
          await setContent(...args);
          controller.abort(reason);
        };
        return page;
      };
      chromium.launch = async (...args) => {
        const browser = await launch(...args);
        browsers.push(browser);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (...contextArgs) => {
          const context = await newContext(...contextArgs);
          const newPage = context.newPage.bind(context);
          context.newPage = async (...pageArgs) => patchPage(await newPage(...pageArgs));
          return context;
        };
        const newPage = browser.newPage.bind(browser);
        browser.newPage = async (...pageArgs) => patchPage(await newPage(...pageArgs));
        return browser;
      };
      let operation;
      if (kind === 'math') {
        operation = renderEquationPngs(protectMathInMarkdown('Math $x^2$.').equations, {
          outDir: path.join(workDir, kind), executablePath: browserExecutable, signal: controller.signal,
        });
      } else if (kind === 'cover') {
        operation = screenshotHtml('<html><body>Cover</body></html>', path.join(workDir, 'cover.png'),
          { browser: browserExecutable }, { signal: controller.signal });
      } else {
        const html = kind === 'table'
          ? '<table><tr><th>Header</th></tr><tr><td>Value</td></tr></table>'
          : `<figure><img src="${svg('red')}"><figcaption>Figure</figcaption></figure>`;
        operation = sourceDocumentFromHtml({ html: `<article><h1>Title</h1><p>Body</p>${html}</article>`,
          sourceUrl: 'https://example.com/fixture', workDir: path.join(workDir, kind),
          config: { browserExecutablePath: browserExecutable }, signal: controller.signal });
      }
      await assert.rejects(operation, error => error === reason);
      assert.equal(browsers.length, 1, kind);
      assert.equal(browsers[0].isConnected(), false, kind);
    }
    chromium.launch = launch;
    const recovered = await sourceDocumentFromHtml({
      html: '<article><h1>Recovered</h1><table><tr><td>After cancellation</td></tr></table></article>',
      sourceUrl: 'https://example.com/recovered', workDir: path.join(workDir, 'recovered'),
      config: { browserExecutablePath: browserExecutable },
    });
    assert.ok(fs.existsSync(recovered.blocks.find(block => block.type === 'table').localPath));
  } finally {
    chromium.launch = launch;
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('真实 Chrome: 多个 SVG 转换复用浏览器且每张图片使用独立 context', options, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-render-reuse-'));
  const launch = chromium.launch.bind(chromium);
  let launches = 0, contexts = 0;
  chromium.launch = async (...args) => {
    launches++;
    const browser = await launch(...args);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...options) => { contexts++; return newContext(...options); };
    return browser;
  };
  try {
    const source = await sourceDocumentFromHtml({
      html: `<article><h1>Images</h1>${['red', 'blue'].map(color => `<figure><img src="${svg(color)}"></figure>`).join('')}</article>`,
      sourceUrl: 'https://example.com/images', workDir,
      config: { browserExecutablePath: browserExecutable },
    });
    assert.equal(launches, 1);
    assert.equal(contexts, 2);
    const images = source.blocks.filter(block => block.type === 'figure').flatMap(block => block.images);
    assert.equal(images.length, 2);
    assert.notDeepEqual(fs.readFileSync(images[0].localPath), fs.readFileSync(images[1].localPath));
  } finally {
    chromium.launch = launch;
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
