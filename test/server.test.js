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
});
