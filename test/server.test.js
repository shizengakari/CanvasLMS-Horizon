const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { app, startServer } = require('../src/server');
const canvasService = require('../src/canvasService');
const { loadConfig, saveConfig } = require('../src/config');

describe('Server Endpoints & Cache Invalidation Whitebox Tests', () => {
  let server;
  let baseUrl;

  before(async () => {
    // 空きポートで一時起動
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('should serve CSS/JS with Cache-Control: public, max-age=3600', async () => {
    const res = await fetch(`${baseUrl}/css/style.css`);
    assert.strictEqual(res.status, 200);
    const cc = res.headers.get('cache-control') || '';
    assert.ok(cc.includes('max-age=3600'), `Cache-Control should have max-age=3600, got: ${cc}`);
  });

  it('should NOT invalidate canvas cache when updating theme or batteryMode', async () => {
    // キャッシュにダミーデータを注入
    canvasService.cache.courses = [{ id: 999, name: 'テスト科目' }];

    // theme と batteryMode のみを変更
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', batteryMode: 'on' })
    });
    const data = await res.json();
    assert.strictEqual(data.success, true);

    // キャッシュが消えていないことを確認！
    assert.ok(canvasService.cache.courses !== null, 'Cache should NOT be wiped when updating theme/batteryMode');
    assert.strictEqual(canvasService.cache.courses[0].id, 999);
  });

  it('should clear canvas cache when calling /api/cache/clear', async () => {
    canvasService.cache.courses = [{ id: 888, name: '一時科目' }];

    const res = await fetch(`${baseUrl}/api/cache/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(canvasService.cache.courses, null, 'Cache should be wiped after /api/cache/clear');
  });

  it('should return check-update status with valid currentVersion and checkedAt', async () => {
    const res = await fetch(`${baseUrl}/api/app/check-update`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.currentVersion.startsWith('v1.0.'), `currentVersion should start with v1.0, got: ${data.currentVersion}`);
    assert.ok(data.checkedAt, 'Response should include checkedAt timestamp');
    assert.strictEqual(typeof data.hasUpdate, 'boolean');
  });

  it('should ensure battery saver CSS preserves refresh button and spinner animations', async () => {
    const res = await fetch(`${baseUrl}/css/style.css`);
    const css = await res.text();

    // body.battery-saver * に一律 animation: none !important が設定されていないこと
    assert.ok(!css.includes('body.battery-saver * {\n  animation: none !important;'), 'Should not unconditionally disable all animations on *');
    // 省電力モードでも refresh-btn.spinning がスピンする定義があること
    assert.ok(css.includes('body.battery-saver .refresh-btn.spinning .refresh-icon'), 'Should preserve refresh-btn spin in battery-saver mode');
    // .spin クラスが定義されていること
    assert.ok(css.includes('.spin {'), 'Should have .spin class defined');
  });

  it('should ensure app.js implements natural celebration petal animation', async () => {
    const res = await fetch(`${baseUrl}/js/app.js`);
    const js = await res.text();

    assert.ok(js.includes('drawSakuraPetal'), 'Should include drawSakuraPetal function');
    assert.ok(js.includes('flipAngle'), 'Should calculate 3D flipAngle for natural flutter');
    assert.ok(js.includes('drawSparkle'), 'Should include celebratory sparkle particles');
  });

  it('should ensure modal transition matches power-saving behavior without slow resizing', async () => {
    const res = await fetch(`${baseUrl}/css/style.css`);
    const css = await res.text();

    // modal-container に遅延リサイズ (width 0.32s, height 0.32s 等) が含まれていないこと
    assert.ok(!css.includes('width 0.32s'), 'Should not have slow width animation on modal');
    assert.ok(!css.includes('height 0.32s'), 'Should not have slow height animation on modal');
  });

  it('should ensure power-saving mode and background updates follow minimal polling', async () => {
    const res = await fetch(`${baseUrl}/js/app.js`);
    const js = await res.text();

    // 定期バックグラウンド自動同期 (setInterval) が排除されていること
    assert.ok(!js.includes('setInterval(() => {\n    // 省電力モード中'), 'Should not have periodic background polling interval');
    // 人工的な 750ms 回転待機タイマーが排除されていること
    assert.ok(!js.includes('Math.max(0, 750 - elapsed)'), 'Should not artificially prolong refresh button rotation');
    // ヘッダーの省電力ボタンが設定画面を開くこと
    assert.ok(js.includes("switchView('settings')"), 'Power button should navigate to settings');
  });

  it('should ensure simplified timeline headers, clean submit buttons, and centered materials loading', async () => {
    const [cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/css/style.css`),
      fetch(`${baseUrl}/js/app.js`)
    ]);
    const css = await cssRes.text();
    const js = await jsRes.text();

    // 1. 絵文字（📌、🔥、📅等）や余計なアイコン枠が除外され、クリーンなテキスト見出しになっていること
    assert.ok(!js.includes("title: '📌 来週以降の課題'"), 'Should not use pin emoji in later assignments title');
    assert.ok(!js.includes("title: '🔥 今日〜明日締切"), 'Should not use fire emoji in urgent title');
    assert.ok(!js.includes('timeline-section-icon'), 'Should keep section headers clean and icon-free');

    // 2. セクションヘッダーから不要な区切りボーダー（横のバー）が排除されていること
    assert.ok(css.includes('border-bottom: none;'), 'Section header should not have an awkward divider bar');

    // 3. 提出ボタンが過剰な主張のないクリーンなデザインであること
    assert.ok(css.includes('.btn-submit-action'), 'Submit button class should be defined');
    assert.ok(js.includes('<span>提出</span>'), 'Submit button text should be concise and clean');

    // 4. 科目切り替え時のキャッシュと画面中央のシンプルローディング表示
    assert.ok(js.includes('getCachedMaterials'), 'Should have client-side cached materials function');
    assert.ok(js.includes('setCachedMaterials'), 'Should have client-side cache persistence function');
    assert.ok(css.includes('.materials-center-loading'), 'CSS should include centered loading styles');
  });

  it('should ensure unified pill metadata system, direct course selection, and enhanced battery optimization', async () => {
    const [htmlRes, cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/css/style.css`),
      fetch(`${baseUrl}/js/app.js`)
    ]);
    const html = await htmlRes.text();
    const css = await cssRes.text();
    const js = await jsRes.text();

    // 1. サイドバーから不要な「講義資料」タブが除外され、科目を直に選択する構造であること
    assert.ok(!html.includes('id="nav-item-materials"'), 'Should not have redundant materials tab in sidebar');
    assert.ok(html.includes('id="nav-item-dashboard"'), 'Should have dashboard nav item');
    assert.ok(html.includes('id="nav-item-announcements"'), 'Should have announcements nav item');

    // 2. 課題とお知らせのメタ行が高さ25pxの統一ピルバッジシステムとして定義されていること
    assert.ok(css.includes('.assignment-due-time'), 'Should define assignment-due-time');
    assert.ok(css.includes('.announcement-time-badge'), 'Should define announcement-time-badge');
    assert.ok(css.includes('border-radius: var(--radius-full);'), 'Should use full rounded pills');

    // 3. 省電力モード時のトランジション・アニメーション負荷抑制
    assert.ok(css.includes('transition-duration: 0.01ms !important;'), 'Should cut expensive transitions in battery saver mode');

    // 4. バックグラウンド時のリソース休止リスナー
    assert.ok(js.includes('visibilitychange'), 'Should listen for visibilitychange to suspend background resources');
  });
});

