const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/zhiwu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const latest = '2026-11-06T05:00:00Z', previous = '2026-07-05T09:37:00Z';
const url = id => `https://pan.quark.cn/s/${id}`;
const entry = (id, title, updatedAt) => ({ id, title: `袁东 ${title}`, url: url(id), platform: 'quark', section: '申论', context: title, updatedAt, sources: [{ file: 'test', line: 1 }] });
const current = entry('current', '方法实战班 新版本', latest);
const older = entry('older', '方法实战班 旧版本', previous);
const pending = entry('pending', '待补链', '2026-11-07T00:00:00Z');
const hidden = entry('hidden', '已下架', latest);
const staticItems = [current, { ...current, title: '袁东 已被替换的重复文案', updatedAt: previous, url: `${current.url}#duplicate` }, older, pending, hidden, entry('same-title-1', '同名不同分享', latest), entry('same-title-2', '同名不同分享', latest)];
const serverItems = [{ ...current, title: '袁东 后台旧文案', updatedAt: previous }, hidden, entry('server-new', '后台新资料', latest)];
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  } catch (_) { res.writeHead(404); res.end(); }
});
let browser;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.TEST_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/EdgeCore/156.0.4314.58/msedge.exe';
  browser = await playwright.chromium.launch({ headless: true, executablePath });
  for (const slowHealth of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
    const errors = [];
    let healthDone = false, linksDone = false;
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname === '/pan-search-data.js') return route.fulfill({ body: 'window.PAN_SEARCH_DATA = ' + JSON.stringify({ items: staticItems, totals: {} }) + ';', contentType: 'text/javascript' });
      if (requestUrl.pathname === '/api/link-health') {
        if (slowHealth) await new Promise(resolve => setTimeout(resolve, 600));
        healthDone = true;
        return route.fulfill({ json: { hiddenUrls: [`${hidden.url}/`], items: [{ url: older.url, status: 'healthy', lastHealthyAt: previous }, { url: hidden.url, status: 'hidden' }] } });
      }
      if (requestUrl.pathname === '/api/pan-links') {
        if (!slowHealth) await new Promise(resolve => setTimeout(resolve, 600));
        linksDone = true;
        return route.fulfill({ json: { items: serverItems } });
      }
      if (requestUrl.pathname === '/api/public-insights') return route.fulfill({ json: { ranking: [{ url: pending.url, count: 9999 }], linkCare: [{ url: pending.url, status: 'pending' }] } });
      if (requestUrl.hostname === '127.0.0.1') {
        if (['image', 'media', 'font'].includes(route.request().resourceType())) return route.fulfill({ body: '' });
        return route.continue();
      }
      if (requestUrl.pathname === '/api/shore-letter') return route.fulfill({ json: { letter: { active: false } } });
      if (requestUrl.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, items: [], batches: [] } });
      return route.fulfill({ body: '', contentType: 'text/javascript' });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => panSearchData.items.some(item => item.url.endsWith('/server-new')) && hiddenPanUrls.size === 1 && resourceSearchExperience.linkCareByUrl.size === 1);
    assert(healthDone && linksDone);
    await page.addStyleTag({ content: '#shoreLetterModal { display:none !important }' });
    await page.locator('#searchInput').fill('袁东');
    await page.locator('#searchInput').press('Enter');
    let cards = await page.locator('.pan-result-item h4').allTextContents();
    assert.equal(cards[0], current.title);
    assert.equal(cards.at(-1), pending.title);
    assert.equal(cards.filter(title => title === current.title).length, 1);
    assert.equal(cards.filter(title => title === '袁东 同名不同分享').length, 2);
    assert(!cards.some(title => /旧文案|重复文案|已下架/.test(title)));
    assert.equal(await page.locator('.pan-result-item .search-verified').count(), 0);
    assert.equal(await page.evaluate(() => getSearchAvailability(panSearchData.items.find(item => item.url.endsWith('/older')))), 0);
    assert.equal(await page.evaluate(() => getSearchUpdateTime({ updatedAt: 1793941200000, createdAt: 'invalid' })), 1793941200000);
    for (const mode of ['latest', 'hot', 'relevance', 'available']) {
      await page.locator(`[data-search-sort="${mode}"]`).click();
      cards = await page.locator('.pan-result-item h4').allTextContents();
      assert.equal(cards.at(-1), pending.title, `${mode}: pending should stay last`);
    }
    const mergeResult = await page.evaluate(() => {
      const result = mergePanSearchItems([
        { url: 'https://pan.quark.cn/s/reverse', title: '旧', updatedAt: '2026-07-01' },
        { url: 'https://pan.quark.cn/s/reverse', title: '新', updatedAt: '2026-11-06' }
      ]);
      return { count: result.length, title: result[0].title, totals: panSearchData.totals.unique.total, activeCount: panSearchData.items.length, serverTitles: serverPanLinks.map(item => item.title) };
    });
    assert.equal(mergeResult.title, '新'); assert.equal(mergeResult.count, 1);
    assert.equal(mergeResult.totals, mergeResult.activeCount);
    assert(mergeResult.serverTitles.includes(current.title)); assert(!mergeResult.serverTitles.includes(hidden.title));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS: newest data survives stale API copies; URL duplicates collapse; distinct same-title shares remain; new entries rank ahead of historical checks; flagged links stay last in every sort; retired links stay hidden in both API arrival orders; no false Quark verification; mobile overflow and page errors checked.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});
