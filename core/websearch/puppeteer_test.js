
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('/mnt/work/uitest/node_modules/puppeteer-core');

const DB = '/mnt/work/websearch/demo.db';
const PAGE = 'file:///mnt/work/websearch/index_v31.html';
const PORT = 8600;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitHealth(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) { const d = await r.json(); if (d && d.ok) return true; }
    } catch (e) {  }
    await sleep(200);
  }
  return false;
}

const results = [];
function check(name, cond, extra) {
  results.push([name, !!cond]);
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? ' | ' + extra : ''));
}

(async () => {
  
  const srv = spawn('python3', ['/mnt/work/websearch/server.py', '--db', DB, '--host', '127.0.0.1', '--port', String(PORT)], { stdio: 'ignore' });
  const up = await waitHealth(10000);
  check('server.py /health 就绪', up);
  if (!up) { srv.kill('SIGKILL'); process.exit(1); }

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });

    await page.goto(PAGE, { waitUntil: 'load', timeout: 20000 });
    check('页面加载', true);

    
    await page.click('#modeWeb');
    await sleep(300);
    const pressed = await page.$eval('#modeWeb', el => el.getAttribute('aria-pressed'));
    check('模式按钮 aria-pressed=true', pressed === 'true', 'pressed=' + pressed);
    const noteVisible = await page.$eval('#webNote', el => !el.hidden);
    check('webNote 面板显示', noteVisible);

    
    let statusTxt = '';
    try {
      await page.waitForFunction(() => {
        const b = document.querySelector('#webStatus');
        return b && b.textContent.indexOf('已连接') >= 0;
      }, { timeout: 8000 });
      statusTxt = await page.$eval('#webStatus', el => el.textContent);
      check('全网服务已连接', true, statusTxt.replace(/\s+/g, ' ').slice(0, 80));
    } catch (e) {
      statusTxt = await page.$eval('#webStatus', el => el.textContent).catch(() => '');
      check('全网服务已连接', false, statusTxt.replace(/\s+/g, ' ').slice(0, 80));
    }
    
    check('状态显示收录 24 页', /24\s*页/.test(statusTxt), '');

    
    await page.click('#searchInput');
    await page.type('#searchInput', '咖啡', { delay: 5 });
    await page.keyboard.press('Enter');
    
    let head = '';
    try {
      await page.waitForFunction(() => {
        const h = document.querySelector('#resultMeta');
        return h && (/条结果/.test(h.textContent) || /没有|未完成|未命中|毫秒/.test(h.textContent));
      }, { timeout: 8000 });
      head = await page.$eval('#resultMeta', el => el.textContent);
      check('结果页渲染', true, head.slice(0, 60));
    } catch (e) {
      head = await page.$eval('#resultMeta', el => el.textContent).catch(() => '');
      check('结果页渲染', false, head.slice(0, 60));
    }
    
    check('结果计数>0', /约\s*[1-9]\d*\s*条结果/.test(head), head.slice(0, 40));

    
    const cardCount = await page.$$eval('#resultList a[href]', els => els.length).catch(() => 0);
    check('结果卡片链接数>0', cardCount > 0, 'links=' + cardCount);
    const firstHref = await page.$eval('#resultList a[href]', el => el.getAttribute('href')).catch(() => '');
    check('Top1 命中咖啡/浓缩页', /coffee|espresso/.test(firstHref), firstHref);
    const tag = await page.$eval('.tag, #resultTag, [class*=tag]', el => el.textContent).catch(() => '');
    console.log('  [info] 结果来源标签 =', JSON.stringify(tag));

    const pass = results.filter(r => r[1]).length, fail = results.filter(r => !r[1]).length;
    console.log(`\n══ UI 实测: ${pass} 通过 / ${fail} 失败 ══`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
    srv.kill('SIGKILL');
  }
})().catch(e => { console.error('FATAL', e); try { process.exit(2); } catch (_) {} });
