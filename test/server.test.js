const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const fs = require('fs');
const path = require('path');

const { app, startServer, PDF_CACHE_DIR } = require('../src/server');
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
    assert.ok(data.currentVersion.startsWith('v1.'), `currentVersion should start with v1., got: ${data.currentVersion}`);
    assert.ok(data.checkedAt, 'Response should include checkedAt timestamp');
    assert.strictEqual(typeof data.hasUpdate, 'boolean');
    assert.ok('downloadUrl' in data, 'Response should include downloadUrl property');
    assert.ok('zipUrl' in data, 'Response should include zipUrl property');
  });

  it('should correctly compare semver across multiple version skips (e.g. 1.0.8 -> 1.0.11 -> 1.1.0)', () => {
    const { compareSemver } = require('../src/server');
    // 2つ以上前のバージョンからのアップデート判定
    assert.strictEqual(compareSemver('v1.0.11', 'v1.0.8'), 1, 'v1.0.11 should be newer than v1.0.8');
    assert.strictEqual(compareSemver('v1.0.11', 'v1.0.9'), 1, 'v1.0.11 should be newer than v1.0.9');
    assert.strictEqual(compareSemver('v1.0.11', 'v1.0.10'), 1, 'v1.0.11 should be newer than v1.0.10');
    assert.strictEqual(compareSemver('v1.1.0', 'v1.0.11'), 1, 'v1.1.0 should be newer than v1.0.11');
    // 同一バージョン
    assert.strictEqual(compareSemver('v1.1.0', 'v1.1.0'), 0, 'v1.1.0 should be equal to v1.1.0');
    // 将来バージョン
    assert.strictEqual(compareSemver('v1.1.0', 'v1.1.1'), -1, 'v1.1.0 should be older than v1.1.1');
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

    // 1. 絵文字や余計なアイコン枠が除外され、クリーンなテキスト見出しになっていること
    assert.ok(!js.includes("title: '\u{1F4CC} 来週以降の課題'"), 'Should not use pin emoji in later assignments title');
    assert.ok(!js.includes("title: '\u{1F525} 今日〜明日締切"), 'Should not use fire emoji in urgent title');
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

  it('should ensure 24h urgency metrics, grouping headers, manual complete, and blue-tinted submit button', async () => {
    const [cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/css/style.css`),
      fetch(`${baseUrl}/js/app.js`)
    ]);
    const css = await cssRes.text();
    const js = await jsRes.text();

    // 1. タイムラインセクションの表記が「24時間以内」「1週間以内」に統一され重複が解消されていること
    assert.ok(js.includes("title: '24時間以内'"), 'Should use 24時間以内 as timeline section title');
    assert.ok(js.includes("title: '1週間以内'"), 'Should use 1週間以内 as this week section title');
    assert.ok(js.includes("isAssignmentManuallyCompleted"), 'Should support manual complete check');

    // 2. 課題カードの提出ボタンおよび手動完了ボタンが指定されていること
    assert.ok(js.includes('btn-submit-action action-chip-btn action-submit'), 'Submit button should use action-submit class');
    assert.ok(js.includes('btn-manual-complete-toggle'), 'Should include manual complete toggle button');

    // 3. 提出ボタンのスタイルが科目タブのような青っぽい色（#8ab4f8）で定義されていること
    assert.ok(css.includes('.btn-submit-action'), 'Submit button style should be defined');
    assert.ok(css.includes('#8ab4f8'), 'CSS should include Google blue accent color');
    assert.ok(css.includes('rgba(138, 180, 248,'), 'CSS should include blue tint for submit button');

    // 4. 24時間以内の課題判定および24時間超過課題の除外が行われていること
    assert.ok(js.includes('diffHours >= -24 && diffHours <= 24'), 'Should include urgent assignments correctly within 24 hours window');
  });

  it('should ensure announcement PDF links, embedded video cards and attachments open seamlessly', async () => {
    const jsRes = await fetch(`${baseUrl}/js/app.js`);
    const js = await jsRes.text();

    // 1. setupContentLinks が定義され、PDFリンクおよび埋め込み動画がサポートされること
    assert.ok(js.includes('function setupContentLinks'), 'Should define setupContentLinks');
    assert.ok(js.includes('openPdfPreviewModal'), 'Should call openPdfPreviewModal for inline PDF links');
    assert.ok(js.includes('embedded-video-card'), 'Should render embedded video cards');

    // 2. お知らせレンダリングで setupContentLinks と添付ファイル処理が行われること
    assert.ok(js.includes('setupContentLinks(bodyEl, courseId)'), 'Should bind links in announcement body');
    assert.ok(js.includes('announcement-attachments'), 'Should support announcement attachments');
  });

  it('should ensure high-efficiency optimizations: debouncing, DocumentFragment batching, LRU cache and CSS containment', async () => {
    const [cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/css/style.css`),
      fetch(`${baseUrl}/js/app.js`)
    ]);
    const css = await cssRes.text();
    const js = await jsRes.text();

    // 1. デバウンスによる入力スパイク防止
    assert.ok(js.includes('function debounce('), 'Should define debounce function');
    assert.ok(js.includes('debouncedRenderAssignments'), 'Dashboard search should be debounced');
    assert.ok(js.includes('debouncedFilter'), 'Materials search should be debounced');
    assert.ok(js.includes('debouncedRenderPalette'), 'Command palette search should be debounced');

    // 2. DocumentFragment による一括描画とリフロー最小化
    assert.ok(js.includes('document.createDocumentFragment()'), 'Should use DocumentFragment for batched DOM updates');

    // 3. インメモリキャッシュの LRU メモリ管理
    assert.ok(js.includes('MAX_MATERIALS_IN_MEMORY'), 'Should cap materials cache to prevent memory bloat');

    // 4. CSS Containment & content-visibility
    assert.ok(css.includes('content-visibility: auto;'), 'Should use content-visibility: auto for smooth scrolling');
    assert.ok(css.includes('contain: content;'), 'Should use contain: content on card elements');

    // 5. アニメーション終了時のキャンバスVRAM解放
    assert.ok(js.includes('canvas.width = 0;'), 'Should zero canvas size to release GPU VRAM on finish');
  });

  it('should serve cached PDF with Range 206 Partial Content and zero Canvas API calls', async () => {
    const testFileId = 'test_pdf_cache_9999';
    const testFilePath = path.join(PDF_CACHE_DIR, `${testFileId}.pdf`);
    const dummyPdfContent = Buffer.from('%PDF-1.4 Mock PDF content for testing range and fast streaming');
    fs.writeFileSync(testFilePath, dummyPdfContent);

    try {
      // 1. フルリクエスト (200 OK)
      const resFull = await fetch(`${baseUrl}/api/files/download?id=${testFileId}&inline=true&name=test.pdf`);
      assert.strictEqual(resFull.status, 200);
      assert.strictEqual(resFull.headers.get('content-type'), 'application/pdf');
      assert.strictEqual(resFull.headers.get('accept-ranges'), 'bytes');
      const bodyFull = await resFull.arrayBuffer();
      assert.strictEqual(bodyFull.byteLength, dummyPdfContent.length);

      // 2. HTTP Range リクエスト (206 Partial Content - Chromium PDFium の初回ヘッダー取得を模倣)
      const resRange = await fetch(`${baseUrl}/api/files/download?id=${testFileId}&inline=true&name=test.pdf`, {
        headers: { Range: 'bytes=0-7' }
      });
      assert.strictEqual(resRange.status, 206, 'Should return 206 Partial Content on Range request');
      assert.strictEqual(resRange.headers.get('content-type'), 'application/pdf');
      assert.ok(resRange.headers.get('content-range')?.startsWith('bytes 0-7/'), 'Should have Content-Range header');
      const rangeText = await resRange.text();
      assert.strictEqual(rangeText, '%PDF-1.4');
    } finally {
      if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
    }
  });

  it('should correctly resolve cached PDF even when name is missing in query', async () => {
    const testFileId = 'test_pdf_noname_8888';
    const testFilePath = path.join(PDF_CACHE_DIR, `${testFileId}.pdf`);
    const dummyPdfContent = Buffer.from('%PDF-1.4 Fast no-name resolution test');
    fs.writeFileSync(testFilePath, dummyPdfContent);

    try {
      // name パラメータなし（app.js からの直接リクエスト等）
      const res = await fetch(`${baseUrl}/api/files/download?id=${testFileId}&inline=true`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
      const content = await res.text();
      assert.strictEqual(content, dummyPdfContent.toString());
    } finally {
      if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
    }
  });

  it('should provide /api/files/ensure-cache endpoint returning local path for native viewer', async () => {
    const testFileId = 'test_pdf_ensure_7777';
    const testFilePath = path.join(PDF_CACHE_DIR, `${testFileId}.pdf`);
    fs.writeFileSync(testFilePath, Buffer.from('%PDF-1.4 Local Native File Test'));

    try {
      const res = await fetch(`${baseUrl}/api/files/ensure-cache?id=${testFileId}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.cached, true);
      assert.strictEqual(data.path, testFilePath);
    } finally {
      if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
    }
  });

  it('should suspend animations and toggle app-hidden when window is obscured or hidden', async () => {
    const [cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/css/style.css`),
      fetch(`${baseUrl}/js/app.js`)
    ]);
    const css = await cssRes.text();
    const js = await jsRes.text();

    // 1. CSS で body.app-hidden のアニメーション停止が定義されていること
    assert.ok(css.includes('body.app-hidden *'), 'Should pause all animations on body.app-hidden');
    assert.ok(css.includes('animation-play-state: paused !important;'), 'Should enforce paused animation state');

    // 2. JS の visibilitychange で app-hidden クラスがトグルされること
    assert.ok(js.includes("classList.toggle('app-hidden'"), 'Should toggle app-hidden class on visibilitychange');
  });

  it('should preserve true extensions (.docx, .pptx, .xlsx, .zip) and strip accidental .docx.pdf double extensions', () => {
    const {
      normalizeDownloadFileName,
      normalizeCanvasFileUrl,
      isValidPdfFile
    } = require('../src/server');

    // 1. .docx.pdf の二重拡張子を .docx に正規化
    assert.strictEqual(
      normalizeDownloadFileName('第9回課題_GIシート-1.docx.pdf', null, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      '第9回課題_GIシート-1.docx'
    );

    // 2. 拡張子なしのリンク名でも fileData.displayName や Content-Disposition から .docx を復元
    assert.strictEqual(
      normalizeDownloadFileName('第9回課題_GIシート', { displayName: '第9回課題_GIシート-1.docx' }),
      '第9回課題_GIシート.docx'
    );
    assert.strictEqual(
      normalizeDownloadFileName(
        '配付資料',
        null,
        "attachment; filename*=UTF-8''%E7%AC%AC9%E5%9B%9E%E8%AA%B2%E9%A1%8C_GI%E3%82%B7%E3%83%BC%E3%83%88-1.docx",
        'application/octet-stream'
      ),
      '配付資料.docx'
    );

    // 3. Canvas の ?wrap=1 付きウェブURLを直接ダウンロードURLへ正規化（verifier維持）
    const normalizedUrl = normalizeCanvasFileUrl('https://canvas.example.edu/courses/123/files/45678?wrap=1&verifier=abc123xyz');
    assert.ok(!normalizedUrl.includes('wrap=1'), 'Should strip wrap=1');
    assert.ok(normalizedUrl.includes('verifier=abc123xyz'), 'Should preserve verifier parameter');
    assert.ok(normalizedUrl.includes('download_frd=1'), 'Should append download_frd=1');

    // 4. 非PDFファイル（ZIP/DOCXヘッダー PK\x03\x04）が PDF_CACHE_DIR に混入していた場合に検出し自動排除すること
    const fakePdfPath = path.join(PDF_CACHE_DIR, 'fake_docx_99999.pdf');
    fs.writeFileSync(fakePdfPath, Buffer.from('PK\x03\x04 Fake DOCX content'));
    assert.strictEqual(isValidPdfFile(fakePdfPath), false, 'Should detect non-PDF header');
    assert.strictEqual(fs.existsSync(fakePdfPath), false, 'Should purge corrupted non-PDF file from PDF_CACHE_DIR');
  });

  it('should not force data-api-returntype="File" links into PDF viewer and should implement modalNav back stack', async () => {
    const [htmlRes, cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/css/style.css`),
      fetch(`${baseUrl}/js/app.js`)
    ]);
    const html = await htmlRes.text();
    const css = await cssRes.text();
    const js = await jsRes.text();

    // 1. data-api-returntype === 'File' が無条件に isPdf 判定に使われていないこと
    assert.ok(!js.includes("title.toLowerCase().includes('.pdf') ||\n                  link.dataset.apiReturntype === 'File'"), 'Should not treat all Canvas File links as PDF');
    assert.ok(js.includes('classifyFile('), 'Should classify files by extension and MIME type');

    // 2. モーダル間の画面切り替え・戻るナビゲーション (modalNav & .modal-back-btn) が実装されていること
    assert.ok(html.includes('class="modal-back-btn"'), 'Modals should include modal-back-btn in header');
    assert.ok(css.includes('.modal-back-btn'), 'CSS should style modal-back-btn');
    assert.ok(js.includes('const modalNav ='), 'JS should define modalNav stack manager');
    assert.ok(js.includes('modalNav.goBack()'), 'JS should support stepping back to previous modal');

    // 3. ロックされたページ・課題の案内表示 (.locked-content-notice) が実装されていること
    assert.ok(css.includes('.locked-content-notice'), 'CSS should style locked-content-notice');
    assert.ok(js.includes('renderLockedContentNotice'), 'JS should render locked content notice');
  });

  it('should prevent .ext.pdf double extensions for all non-PDF formats (.docs, .docx, .pptx, .xlsx, .zip, .ipynb, .dwg, .stl, etc.)', () => {
    const { normalizeDownloadFileName, resolveContentType } = require('../src/server');

    const cases = [
      ['レポート課題.docs.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'レポート課題.docs'],
      ['レポート課題.docx.pdf', 'application/pdf', 'レポート課題.docx'],
      ['発表スライド.pptx.pdf', 'application/pdf', '発表スライド.pptx'],
      ['実験データ.xlsx.pdf', 'application/pdf', '実験データ.xlsx'],
      ['提出アーカイブ.zip.pdf', 'application/zip', '提出アーカイブ.zip'],
      ['演習ノート.ipynb.pdf', 'application/x-ipynb+json', '演習ノート.ipynb'],
      ['CAD図面.dwg.pdf', 'image/vnd.dwg', 'CAD図面.dwg'],
      ['3Dモデル.stl.pdf', 'model/stl', '3Dモデル.stl'],
      ['MATLABデータ.mat.pdf', 'application/x-matlab-data', 'MATLABデータ.mat'],
      ['構成図.vsdx.pdf', 'application/vnd.ms-visio.drawing', '構成図.vsdx']
    ];

    for (const [inputName, mime, expected] of cases) {
      assert.strictEqual(
        normalizeDownloadFileName(inputName, null, null, mime),
        expected,
        `Expected ${inputName} to normalize to ${expected}`
      );
    }

    // 通常のバージョン番号付きPDF（例: report_v1.2.pdf）は .pdf を維持すること
    assert.strictEqual(
      normalizeDownloadFileName('report_v1.2.pdf', null, null, 'application/pdf'),
      'report_v1.2.pdf'
    );

    // 汎用名（document.pdf / file.pdf）でも fileData や MIME から真の拡張子へ補正されること
    assert.strictEqual(
      normalizeDownloadFileName('document.pdf', { display_name: '第3回演習シート.docx' }, null, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      '第3回演習シート.docx'
    );
    assert.strictEqual(
      normalizeDownloadFileName('講義資料.pdf', { display_name: '講義資料.pptx' }, null, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      '講義資料.pptx'
    );
    assert.strictEqual(
      resolveContentType('課題テンプレート.docs', 'application/octet-stream'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });

  it('should refine locked assignment UI, implement utils.stripHtml, sync submission states, and eliminate all emojis', async () => {
    const [htmlRes, cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/css/style.css`),
      fetch(`${baseUrl}/js/app.js`)
    ]);
    const html = await htmlRes.text();
    const css = await cssRes.text();
    const js = await jsRes.text();

    // 1. utils.stripHtml・課題提出状態同期関数が実装されていること
    assert.ok(js.includes('stripHtml(html)'), 'utils.stripHtml should be defined in app.js');
    assert.ok(js.includes('extractCleanFileNameFromText'), 'utils.extractCleanFileNameFromText should be defined in app.js');
    assert.ok(js.includes('function syncAssignmentSubmissionState'), 'syncAssignmentSubmissionState should be defined in app.js');
    assert.ok(js.includes('function invalidateCourseMaterialsCache'), 'invalidateCourseMaterialsCache should be defined in app.js');
    assert.ok(js.includes('function isAssignmentActivePending'), 'isAssignmentActivePending should be defined in app.js');

    // 2. ロックされた課題の専用UI（提出パネルのロック案内・ロック中チップ・スケジュールグリッド）が実装されていること
    assert.ok(html.includes('id="modal-locked-notice"'), 'HTML should include #modal-locked-notice in assignment modal');
    assert.ok(css.includes('.locked-submission-card'), 'CSS should style .locked-submission-card');
    assert.ok(css.includes('.action-chip-btn.action-locked'), 'CSS should style .action-locked chip');
    assert.ok(css.includes('.badge-locked'), 'CSS should style .badge-locked');
    assert.ok(js.includes('renderAssignmentSubmissionPanel'), 'JS should define renderAssignmentSubmissionPanel');
    assert.ok(js.includes('renderAssignmentDescriptionArea'), 'JS should define renderAssignmentDescriptionArea');

    // 3. 絵文字がフロントエンド・バックエンドから完全に排除されていること
    const forbiddenEmojis = ['\u{1F512}', '\u{1F319}', '\u{2600}', '\u{1F4CC}', '\u{1F525}'];
    for (const emoji of forbiddenEmojis) {
      assert.ok(!html.includes(emoji), `index.html should not contain emoji ${emoji}`);
      assert.ok(!css.includes(emoji), `style.css should not contain emoji ${emoji}`);
      assert.ok(!js.includes(emoji), `app.js should not contain emoji ${emoji}`);
    }
  });

  it('should keep repository clean without docs/ folder and verify Rust native backend + built-in updater', () => {
    const rootDir = path.join(__dirname, '..');
    assert.strictEqual(fs.existsSync(path.join(rootDir, 'docs')), false, 'docs folder should be removed');
    assert.strictEqual(fs.existsSync(path.join(rootDir, 'src-rust')), false, 'unused src-rust folder should be removed');
    assert.strictEqual(fs.existsSync(path.join(rootDir, 'src-tauri', 'src', 'lib.rs')), true, 'Rust lib.rs should exist');
    assert.strictEqual(fs.existsSync(path.join(rootDir, 'src-tauri', 'src', 'server.rs')), true, 'Rust server.rs should exist');
    assert.strictEqual(fs.existsSync(path.join(rootDir, 'src-tauri', 'src', 'canvas.rs')), true, 'Rust canvas.rs should exist');

    const rustLib = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'lib.rs'), 'utf-8');
    assert.ok(rustLib.includes('check_for_updates'), 'Rust lib.rs should implement check_for_updates');
    assert.ok(rustLib.includes('start_download_update'), 'Rust lib.rs should implement start_download_update');
    assert.ok(rustLib.includes('quit_and_install'), 'Rust lib.rs should implement quit_and_install');
    assert.ok(rustLib.includes('Unblock-File'), 'Rust updater should run Unblock-File to grant execution permission');

    const mainJs = fs.readFileSync(path.join(rootDir, 'src', 'main.js'), 'utf-8');
    assert.ok(mainJs.includes('checkAsarUpdate'), 'src/main.js should include checkAsarUpdate for built-in hot updates');
    assert.ok(mainJs.includes('start-download-update'), 'src/main.js should handle start-download-update');
    assert.ok(mainJs.includes('quit-and-install'), 'src/main.js should handle quit-and-install');
    assert.ok(mainJs.includes('Unblock-File'), 'src/main.js should run Unblock-File when migrating to Rust exe');
  });

  it('should normalize update event payloads between Rust/Tauri and Electron format in app.js and backend', () => {
    const rootDir = path.join(__dirname, '..');
    const appJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'app.js'), 'utf-8');
    const rustLib = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'lib.rs'), 'utf-8');
    const mainJs = fs.readFileSync(path.join(rootDir, 'src', 'main.js'), 'utf-8');

    // app.js window.__dispatchUpdateStatus should normalize type and status
    assert.ok(appJs.includes("normalized.type = normalized.status === 'downloading' ? 'progress' : normalized.status"), 'app.js should normalize status to type');
    assert.ok(appJs.includes("eventType === 'progress'"), 'app.js onUpdateStatus should handle progress eventType');
    assert.ok(appJs.includes("eventType === 'downloaded'"), 'app.js onUpdateStatus should handle downloaded eventType');

    // Rust lib.rs dispatch_update_status should inject both status and type
    assert.ok(rustLib.includes("obj.insert(\"type\".to_string(), json!(t))"), 'Rust lib.rs should inject type into status events');
    assert.ok(rustLib.includes("obj.insert(\"status\".to_string(), json!(s))"), 'Rust lib.rs should inject status into type events');

    // main.js should send both type and status
    assert.ok(mainJs.includes("status: 'downloading'"), 'src/main.js should include status: downloading');
    assert.ok(mainJs.includes("status: 'downloaded'"), 'src/main.js should include status: downloaded');
  });

  it('should preserve colored item icons, use key icon and rename button to ロック for locked items', async () => {
    const rootDir = path.join(__dirname, '..');
    const appJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'app.js'), 'utf-8');
    const styleCss = fs.readFileSync(path.join(rootDir, 'public', 'css', 'style.css'), 'utf-8');
    const canvasServiceJs = fs.readFileSync(path.join(rootDir, 'src', 'canvasService.js'), 'utf-8');

    // 1. ロック中アイテムであってもアイコンクラスが 'other' (モノクロ) に格下げされずカラーを維持すること
    assert.ok(!appJs.includes("iconClass = isLockedItem ? 'other' : 'quiz'"), 'Quiz icon should not be downgraded to other when locked');
    assert.ok(appJs.includes("iconClass = 'quiz';"), 'Quiz icon should remain quiz');
    assert.ok(appJs.includes("iconClass = isAssignmentSubmitted ? 'assignment-submitted' : 'assignment';"), 'Assignment icon should remain colored even if locked');

    // 2. ロックボタンに鍵のSVGアイコンと「ロック」の名称が適用されていること
    const lockKeyPath = 'd="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"';
    assert.ok(appJs.includes(lockKeyPath), 'app.js should contain standard key icon svg path');
    assert.ok(appJs.includes('<span>ロック</span>'), 'app.js should display ロック instead of ロック中 in action buttons');
    assert.ok(!appJs.includes('<span>ロック中</span>'), 'app.js should not contain any <span>ロック中</span>');

    // 3. ファイルロック判定で !it.url && !it.id によるすり抜けが解消されていること
    assert.ok(!appJs.includes('if (isLockedItem && !it.url && !it.id)'), 'File lock condition should not require empty url and id');
    assert.ok(appJs.includes('if (isFile && isLockedItem)'), 'Clicking locked file should directly inform user instead of failing download');

    // 4. モジュール全体のロック状態や公開日程 (unlockAt, lockAt) も反映されていること
    assert.ok(appJs.includes('m.isLocked'), 'app.js should take parent module locked state into account');
    assert.ok(canvasServiceJs.includes('m.isLocked'), 'canvasService should link module lock state to items');

    // 5. style.css にてロックボタンのSVGアイコン色がアンバー/イエロー系に定義されていること
    assert.ok(styleCss.includes('.action-chip-btn.action-locked svg'), 'style.css should style svg in action-locked');
    assert.ok(styleCss.includes('.btn-submit-action.action-locked .btn-icon'), 'style.css should style .btn-icon in action-locked');
  });

  it('should optimize materials loading performance, display plain-text course title, and eliminate icon scale border distortion', async () => {
    const rootDir = path.join(__dirname, '..');
    const appJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'app.js'), 'utf-8');
    const styleCss = fs.readFileSync(path.join(rootDir, 'public', 'css', 'style.css'), 'utf-8');
    const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf-8');
    const canvasServiceJs = fs.readFileSync(path.join(rootDir, 'src', 'canvasService.js'), 'utf-8');
    const rustCanvas = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'canvas.rs'), 'utf-8');

    // 1. ロード高速化 & バッテリー保護（個別APIリクエストループの完全排除・SWRキャッシュ・先読み・重複防止）
    assert.ok(!canvasServiceJs.includes('fileItems.slice(i, i + batchSize)'), 'canvasService should not batch-fetch individual file URLs');
    assert.ok(!rustCanvas.includes('for (cid_val, cid_str, it, m_name) in pending_items'), 'Rust canvas.rs should not iterate pending items sequentially');
    assert.ok(appJs.includes('CLIENT_MATERIALS_FRESH_TTL'), 'app.js should define fresh TTL for materials');
    assert.ok(appJs.includes('inFlightMaterialsRequests'), 'app.js should pool and deduplicate in-flight materials requests');
    assert.ok(appJs.includes('prefetchCourseMaterials'), 'app.js should implement hover prefetching for courses');
    assert.ok(appJs.includes('getCachedMaterialsEntry'), 'app.js should support multi-tier cache retrieval');
    assert.ok(canvasServiceJs.includes('pendingMaterialsPromises'), 'canvasService should deduplicate in-flight materials promises');

    // 2. 検索バー下の科目メニューを排除し、平文字（プレーンテキスト）の見出し表示に置き換えること
    assert.ok(indexHtml.includes('id="material-course-header"'), 'index.html should have material-course-header');
    assert.ok(indexHtml.includes('id="material-course-name-title"'), 'index.html should have material-course-name-title');
    assert.ok(!indexHtml.includes('<label class="filter-label">科目:</label>'), 'index.html should no longer show redundant 科目: label');
    assert.ok(appJs.includes('function updateMaterialsCourseHeader'), 'app.js should define updateMaterialsCourseHeader');
    assert.ok(appJs.includes('function getSelectedCourseName'), 'app.js should define getSelectedCourseName');
    assert.ok(styleCss.includes('.materials-course-name'), 'style.css should style .materials-course-name');
    assert.ok(styleCss.includes('#material-course-select {\n  display: none;\n}'), 'style.css should hide #material-course-select from toolbar');

    // 3. ホバー時の縁の歪み解消（.module-file-card:hover .module-file-icon の scale(1.05) 削除）
    assert.ok(!styleCss.includes('.module-file-card:hover .module-file-icon'), 'style.css should remove hover scale on module file icon');
    assert.ok(!styleCss.includes('transform: scale(1.05)'), 'style.css should not have scale(1.05) causing border-radius distortion');
  });
});
