const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-refresh-test-'));
const fixture = path.join(temp, 'fixture.js');
const dataDir = path.join(temp, 'data');
const extraFile = path.join(dataDir, 'extra-links.json');
const statsFile = path.join(dataDir, 'stats.json');
const failFile = path.join(temp, 'fail-write');
const requestsFile = path.join(temp, 'checked-urls.jsonl');
const quark = id => `https://pan.quark.cn/s/${id}`;
const title = '2027年国省考季袁东申论方法实战班';
const importedTitle = `申论】${title}`;
const oldTime = '2026-07-05T09:37:00.000Z';
let child;
function readData() { return JSON.parse(fs.readFileSync(fixture, 'utf8').replace(/^window.PAN_SEARCH_DATA = /, '').replace(/;\s*$/, '')); }
function writeData(value) { fs.writeFileSync(fixture, `window.PAN_SEARCH_DATA = ${JSON.stringify(value)};`); }
function readExtra() { return JSON.parse(fs.readFileSync(extraFile, 'utf8')).items; }
function writeExtra(items) { fs.writeFileSync(extraFile, JSON.stringify({ items })); }

async function main() {
  fs.mkdirSync(dataDir);
  const originals = [
    { id: 'r1', title: `🔥 ${title}（新增！）`, platform: 'quark', url: quark('old1'), createdAt: oldTime, context: `原链接 ${quark('old1')}` },
    { id: 'r2', title: importedTitle, platform: 'quark', url: quark('old2') },
    { id: 'r3', title: title.replace('2027', '2026'), platform: 'quark', url: quark('year2026') },
    { id: 'r4', title: importedTitle, platform: 'baidu', url: 'https://pan.baidu.com/s/untouched' },
    { id: 'r5', title: `${title}（行政执法专项）`, platform: 'quark', url: quark('specialty') },
    { id: 'r6', title: '事业单位】袁东合集', platform: 'quark', url: quark('shiye') },
    { id: 'r7', title: '袁东合集', platform: 'quark', url: quark('collection') },
    { id: 'r8', title: '其他独立资料入口', platform: 'quark', url: quark('old1') }
  ];
  writeData({ items: originals, totals: {} });
  const extraOriginals = [
    { id: 'e1', title: `🔥 ${title}（新增！）`, platform: 'quark', url: quark('extraOld1'), context: `链接 ${quark('extraOld1')}`, createdAt: oldTime },
    { id: 'e2', title: importedTitle, platform: 'quark', url: quark('extraOld2'), createdAt: oldTime },
    { id: 'e3', title: importedTitle, platform: 'baidu', url: 'https://pan.baidu.com/s/extraUntouched', createdAt: oldTime }
  ];
  writeExtra(extraOriginals);
  const initialStats = { brokenLinks: [ { url: quark('old1'), title: '共享链接反馈' }, { url: quark('old2'), title }, { url: quark('unrelated'), title: '其他反馈' } ] };
  fs.writeFileSync(statsFile, JSON.stringify(initialStats));
  const hook = path.join(temp, 'hook.cjs');
  fs.writeFileSync(hook, `const fs=require('fs');global.fetch=async(url,opts={})=>{
    const href=String(url);
    if(href.startsWith('https://api.github.com/')) {
      if(opts.method==='PUT') {
        if(fs.existsSync(process.env.TEST_FAIL_FILE)) return new Response(JSON.stringify({message:'isolated write failure'}),{status:500});
        const body=JSON.parse(opts.body);fs.writeFileSync(process.env.TEST_FIXTURE,Buffer.from(body.content,'base64'));
        return new Response(JSON.stringify({commit:{html_url:'https://github.com/test/commit/local'}}));
      }
      return new Response(JSON.stringify({type:'file',sha:'test-sha',encoding:'base64',content:fs.readFileSync(process.env.TEST_FIXTURE).toString('base64')}));
    }
    if(/^https:\\/\\/pan\\.(quark\\.cn|baidu\\.com)\\/s\\//.test(href)) {
      fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify(href)+'\\n');
      return new Response('<html><body><div id="root"></div><script>'+ '/* SPA shell */'.repeat(50)+'</script></body></html>');
    }
    throw Error('External network disabled');
  };`);
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  child = spawn(process.execPath, ['-r', hook, path.resolve(__dirname, '../server/analytics-server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_TOKEN: 'isolated-test-token', GITHUB_TOKEN: 'isolated-github-token', TEST_FIXTURE: fixture, TEST_FAIL_FILE: failFile, TEST_REQUESTS: requestsFile, LINK_HEALTH_AUTOCHECK: 'false' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('startup timeout')), 10000);
    child.stdout.on('data', data => { if (String(data).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.once('error', reject);
    child.stderr.on('data', data => process.stderr.write(data));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (action, rawText, confirm = '1', token = 'isolated-test-token') => {
    const response = await fetch(`${base}/admin/bulk-quark-${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ rawText, confirm }) });
    return { response, data: await response.json() };
  };
  const raw = `${importedTitle}\n链接：${quark('current')}\n申论】2027袁东全新课程\n链接：${quark('newCourse')}`;
  assert.equal((await post('apply', raw, '1', 'wrong')).response.status, 403);
  assert.equal((await post('apply', raw, '')).response.status, 400);
  const preview = await post('preview', raw);
  assert.equal(preview.data.plan.summary.replace, 2);
  assert.equal(preview.data.plan.summary.extraReplace, 2);
  assert.equal(preview.data.plan.summary.add, 1);
  assert.deepEqual(readData().items, originals, 'Preview must not edit GitHub data');
  assert.deepEqual(readExtra(), extraOriginals, 'Preview must not edit server data');
  fs.writeFileSync(failFile, 'fail');
  assert.equal((await post('apply', raw)).response.status, 400);
  assert.deepEqual(readData().items, originals);
  assert.deepEqual(readExtra(), extraOriginals, 'A failed commit must not change server links');
  assert.deepEqual(JSON.parse(fs.readFileSync(statsFile, 'utf8')), initialStats, 'A failed commit must not retire URLs or resolve feedback');
  fs.unlinkSync(failFile);
  const applied = await post('apply', raw);
  assert.equal(applied.response.status, 200);
  assert.equal(applied.data.extraUpdated, 2);
  assert.equal(applied.data.retired, 3, 'Retire replaced URLs only after successful persistence and only when no remaining entry uses them');
  const afterStats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  assert(!afterStats.linkHealth[quark('old1')], 'Do not globally hide a URL still used by an untouched course');
  assert(afterStats.brokenLinks.find(row => row.url === quark('old2')).resolvedAt);
  assert(!afterStats.brokenLinks.find(row => row.url === quark('old1')).resolvedAt);
  assert(!afterStats.brokenLinks.find(row => row.url === quark('unrelated')).resolvedAt);
  let saved = readData();
  for (const item of saved.items.filter(row => ['r1', 'r2'].includes(row.id))) {
    assert.equal(item.url, quark('current'));
    assert(Date.parse(item.updatedAt) > Date.parse(oldTime));
  }
  assert.equal(saved.items.find(item => item.id === 'r1').createdAt, oldTime);
  assert.equal(saved.items.find(item => item.id === 'r1').context, `原链接 ${quark('current')}`);
  assert.deepEqual(saved.items.filter(item => ['r3', 'r4', 'r5', 'r6', 'r7', 'r8'].includes(item.id)), originals.slice(2), 'Keep different years, specialty suffixes, meaningful category labels, and Baidu untouched');
  const added = saved.items.find(item => item.url === quark('newCourse'));
  assert(added.createdAt && added.updatedAt === added.createdAt);
  assert.equal(readExtra()[0].url, quark('current'));
  assert.equal(readExtra()[0].createdAt, oldTime);
  assert.equal(readExtra()[0].context, `链接 ${quark('current')}`);
  assert.deepEqual(readExtra()[2], extraOriginals[2]);
  assert.equal(saved.updateBatches[0].entries.length, 2);
  const prior = fs.readFileSync(fixture, 'utf8');
  assert.equal((await post('apply', raw)).data.ok, false);
  assert.equal(fs.readFileSync(fixture, 'utf8'), prior, 'An identical import must not refresh timestamps');

  const extras = readExtra();
  extras[0].url = quark('extraOldAgain');
  writeExtra(extras);
  const extraOnly = await post('preview', raw);
  assert.equal(extraOnly.data.plan.summary.replace, 0);
  assert.equal(extraOnly.data.plan.summary.add, 0);
  assert.equal(extraOnly.data.plan.summary.extraReplace, 1);
  assert.equal((await post('apply', raw)).data.extraUpdated, 1, 'Allow an extra-only repair after GitHub was already updated');

  const duplicate = await post('apply', `${importedTitle}\n${quark('discardedInput')}\n🔥${title}（新增！）\n${quark('finalInput')}`);
  assert.equal(duplicate.response.status, 200);
  saved = readData();
  assert.equal(saved.items.find(item => item.id === 'r1').url, quark('finalInput'));
  assert.equal(saved.updateBatches[0].entries.length, 2, 'Keep all submitted URLs in immutable history');

  const retired = quark('retired');
  const retiredAbsent = quark('retiredAbsent');
  saved.items.push({ id: 'r99', title: '旧缓存中的已下架资料', platform: 'quark', url: retired });
  writeData(saved);
  fs.writeFileSync(statsFile, JSON.stringify({ clicks: { retired: { href: retired, label: 'old', count: 100 }, current: { href: quark('finalInput'), label: 'new', count: 10 } }, linkHealth: { [retired]: { url: retired, platform: 'quark', status: 'hidden', retired: true }, [retiredAbsent]: { url: retiredAbsent, platform: 'quark', status: 'hidden', retired: true } } }));
  const insights = await (await fetch(`${base}/api/public-insights`)).json();
  assert(insights.ranking.every(item => item.url !== retired), 'Hidden URLs must not return through the popularity list');
  const health = await fetch(`${base}/admin/check-pan-links`, { method: 'POST', headers: { Authorization: 'Bearer isolated-test-token' }, redirect: 'manual' });
  assert.equal(health.status, 303);
  const checked = fs.readFileSync(requestsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert(!checked.includes(retired), 'Do not recheck and revive a retired share from a stale index');
  const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  assert.equal(stats.linkHealth[retired].status, 'hidden');
  assert.equal(stats.linkHealth[retiredAbsent].status, 'hidden', 'Keep tombstones even after the index drops the URL');
  assert(!Object.values(stats.linkHealth).some(item => item.platform === 'quark' && item.status === 'healthy'), 'A Quark SPA shell is not a successful share validation');
  console.log('PASS: Quark decorative title matching, protected course distinctions, preview/apply auth, timestamps, increment sync, failed-write isolation, extra-only repair, duplicate input history, retired link persistence, rankings and SPA health checks.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
});
