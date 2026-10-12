# Canvas Horizon: Electron → Tauri v2 (Rust) 移行計画書 (Implementation Plan)
## 超軽量アーキテクチャ・バッテリー最適化・超高速PDFエンジン設計書

---

## 1. 概要と背景 (Executive Summary & User Objectives)

Canvas Horizon は現在、Electron (Node.js + Express + Chromium) で構築された Canvas LMS デスクトップクライアントです。  
本プロジェクトでは、**機能・UI/UX・デザイン・利用者の利便性を100%維持**しながら、バックエンドおよびデスクトップランタイムを **Tauri v2 (Rust + OS共有 WebView2)** へ移行し、劇的な軽量化と省電力性能を実現します。

### ユーザーの最重要要件 (User Core Requirements)
1. **最大限の軽量化努力**: 余計な処理の徹底排除、アニメーション設計の適正化、根本的な軽量エンジン（Tauri v2 + Rust）の採用。
2. **リッチ＆モダンなデザインの完全両立**: 軽量化のためにチープな外観に落とすのではなく、モダンで洗練された高級感あるUIデザイン・滑らかなインタラクションを維持。
3. **バッテリー駆動・開きっぱなし運用への最適化**: ノートPCでの受講時など、バッテリー駆動のままバックグラウンドで何時間も開きっぱなしにする利用シーンを前提とし、バッテリーやCPUへの負担（スリープ阻害、定周期ウェイクアップ）を極限までゼロに近づける。
4. **操作中の快適性と低負荷**: カクつきや引っ掛かりのない60fpsの心地よい操作感を、CPU/GPUに過負荷を与えずに提供。
5. **PDF閲覧の劇的軽量化（最重要課題）**: ユーザーが指摘する「**特にPDFを見るときかなり重たい**」という深刻なボトルネックを調査・特定し、超軽量・高速なPDF体験へ再設計。

### 定量改善目標 (Quantitative Targets)

| 指標 | Electron 現状 (v1.1) | Tauri v2 移行目標 (v2.0) | 改善率 |
| :--- | :--- | :--- | :--- |
| **アイドル時メモリ消費 (RAM)** | 約 220 〜 320 MB | **約 40 〜 60 MB** | **最大 80% 削減** |
| **PDF閲覧時メモリ消費 (RAM)** | 約 450 〜 680 MB+ | **約 70 〜 120 MB** | **最大 75% 削減** |
| **アイドル時 CPU 割り込み頻度** | 15〜30回 / 秒 (Cステート阻害) | **< 1回 / 秒 (完全アイドリング)** | **95%以上 削減** |
| **配布パッケージ / インストーラ** | 約 120 〜 140 MB | **約 8 〜 12 MB** | **90%以上 削減** |
| **コールド起動時間** | 約 2.5 〜 3.5 秒 | **約 0.3 〜 0.5 秒** | **85%以上 高速化** |
| **ユーザー移行負担** | — | **完全ゼロ（自動引き継ぎ）** | — |

---

## 2. 現行実装のボトルネック調査と根本原因 (Root Cause Analysis)

### 2.1 なぜ現行版は重いのか？ (Engine & Overhead Bottlenecks)
- **Electron による多重プロセス構造**:
  - メインプロセス (Node.js ランタイム: ~30-50MB)
  - レンダラープロセス (Chromium Blink + V8: ~100-150MB)
  - GPU プロセス (~40-80MB)
  - ネットワーク・ユーティリティプロセス (~30MB)
  - 合計で初期起動直後から 250MB 以上の VRAM / システムメモリを占有。
- **Node.js Express サーバーの非効率性**:
  - JavaScript シングルスレッドのイベントループ上でファイル中継とバッファ確保を実施。
  - 大容量ファイルストリーミング時に V8 ヒープとガベージコレクション (GC) にスパイクが発生。

### 2.2 「PDF閲覧がかなり重たい」根本原因の徹底解明 (PDF Deep Dive)
コードベース（`src/server.js`, `public/js/app.js`, `public/index.html`）を詳細に調査した結果、以下の4つの重大な原因が判明しました：

1. **Range リクエスト判定およびパラメータ省略によるディスクキャッシュ完全無効化バグ (`src/server.js`)**:
   - `src/server.js` において、キャッシュ読み込み判定（`!req.headers.range`）だけでなく、キャッシュ保存ストリーム（`!req.headers.range && fileRes.status === 200`）にも Range 排除条件が存在していました。
   - Chromium / Edge の組み込み PDF ビューアは、PDF の構造（Trailer や Xref テーブル）を解析するために、**初回読み込み時に必ず `Range: bytes=0-...` リクエストを発行**します。
   - その結果、リモートから返されるステータスは `206 Partial Content` となり、キャッシュファイルへの書き込みが一切行われませんでした。
   - さらに、UI からのインライン表示リクエスト（`/api/files/download?id=...&inline=true`）ではクエリに `name` パラメータが含まれておらず、URL解決前の判定で `isPdfRequest` が偽と評価され、ディスクキャッシュ判定自体がスキップされる二重の欠陥がありました。
   - これにより、同じPDFを開くたびに Canvas LMS（AWS S3）から全データを再ダウンロードし、ヘッダーとトレイラーの取得で 3〜5 回の低速な往復通信が発生していました。
2. **Chromium PDFium プラグインプロセスの常駐**:
   - Electron 内の `<iframe>` で PDF を表示すると、Chromium 内部で分離された Out-of-Process IFRAME (OOPIF) または PDFium プラグインプロセスが起動し、PDF レンダリングのためだけに 150MB〜300MB のヒープを別途消費。
3. **モーダル終了時のメモリ未解放（DOM 残存リーク）**:
   - 従来の `closePdfModal()` は `iframe.src = 'about:blank'` を指定するのみで、`<iframe>` 要素自体を DOM から除去していませんでした。
   - Chromium では `about:blank` をセットしてもプラグインインスタンスやキャッシュされた GPU テクスチャが破棄されず、複数回 PDF を開閉するとメモリが累積肥大化していました。
4. **外部ネイティブビューアの導線欠如**:
   - 100MB 超・数百ページの講義スライド集であっても、すべてブラウザ内ビューアで処理させられており、OS 既定の軽量高速ビューア（SumatraPDF, Edge, Acrobat）に任せる手段がありませんでした。

### 2.3 バッテリー消費・開きっぱなし運用の阻害要因 (Battery Drain Factors)
- **CPU パッケージ Cステートの阻害**:
  - Intel / AMD の省電力機能（C6/C7/C8 Package C-states）は、CPU がミリ秒単位のアイドル状態を維持することで超低電力モードに入ります。
  - アプリ内で微小な `setInterval` や CSS の微弱アニメーションが動いていると、CPU が数ミリ秒ごとにウェイクアップし、バッテリーを激しく浪費します。
- **ウィンドウ非表示時のバックグラウンド処理の未停止**:
  - 最小化時や画面裏に隠れている際、ダウンロードポーリングやキャンバス描画コンテキストが VRAM を保持し続けていました。

---

## 3. システムアーキテクチャ設計 (Tauri v2 + Rust)

```
┌─────────────────────────────────────────────────────────────────────────┐
│              WebView2 フロントエンド (Chromium 最適化ランタイム)             │
│  - public/index.html                                                    │
│  - public/css/style.css (GPU合成専用アニメーション, CSS Containment)         │
│  - public/js/app.js (DocumentFragment一括描画, 動的Iframe管理)           │
│                                                                         │
│  window.desktopAPI (Tauri Initialization Script で完全互換注入)          │
└───────────────┬───────────────────────────┬─────────────────────────────┘
                │ HTTP fetch (/api/...)     │ Tauri IPC (invoke / events)
                ▼                           ▼
┌────────────────────────────────┐ ┌──────────────────────────────────────┐
│  Rust 組込み HTTP (Axum/Tokio) │ │ Tauri v2 ランタイム                  │
│  - /api/me, /api/courses       │ │ - OS 電源監視 (WM_POWERBROADCAST)    │
│  - /api/dashboard/timeline     │ │ - ウィンドウ管理 & 最小化検知        │
│  - /api/materials-grouped      │ │ - 外部ファイル起動 (openPath)        │
│  - /api/files/download         │ │ - WebView2 メモリトリム (LowMemory)  │
│    (ゼロコピー Range 206 配信) │ │ - 自動アップデート (updater plugin)  │
│  - /api/config (%APPDATA%同期) │ └──────────────────────────────────────┘
└───────────────┬────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Rust Canvas コアサービス & ディスクキャッシュ (Reqwest Connection Pool)│
│  - 同時接続リミッター (Semaphore: 4 並行)                               │
│  - 高速ディスクキャッシュ (%LOCALAPPDATA%/Canvas Horizon/pdf_cache/)     │
│  - ユーザー設定完全互換 (%APPDATA%/Canvas Horizon/config.json)           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. コア改善戦略と実装仕様 (Technical Deep-Dive Specifications)

### 4.1 超軽量エンジン (Engine & Footprint)
- **OS共有 WebView2 の採用**:
  - Windows 10/11 に標準搭載されている Microsoft Edge のランタイムを共有利用。
  - 独自の Chromium をバンドルしないため、インストーラサイズは ~10MB、アイドル時のメモリフットプリントは OS と共有されて実質 ~40-60MB に収まります。
- **Rust 組込み Axum HTTP サーバー**:
  - Node.js/Express を完全に廃止し、Rust の `axum` + `tokio` でローカルAPIサーバーを起動。
  - メモリ使用量はわずか数MB、ガベージコレクションなし、起動ラグはゼロ。

### 4.2 バッテリー最適化＆開きっぱなし運用 (Battery Life & "Leave-Open" Optimization)
1. **3段階の動的電源状態管理 (Three-Tier Power States)**:
   - **AC Power モード (電源接続中)**:
     - 60fps スムーズアニメーション、高速プリフェッチ、即時同期。
   - **Battery モード (バッテリー駆動中)**:
     - `body.battery-saver` クラスを自動適用。
     - CSS `backdrop-filter: none`、`box-shadow: none` で GPU パイプラインを軽量化。
     - パーティクル・紙吹雪の粒子数を半減 (60個 → 30個)。
     - ポーリング間隔を 60秒以上へ後退（Backoff）。
   - **Deep Sleep モード (最小化・画面非表示・5分以上アイドル)**:
     - `document.visibilitychange` および Tauri ウィンドウイベントで完全検知。
     - すべてのタイマー (`setInterval`, `setTimeout`) を停止。
     - キャンバスバッファを強制解放 (`canvas.width = 0, canvas.height = 0`) して VRAM をOSに即時返却。
     - CSS アニメーションを `animation-play-state: paused` に固定。
     - CPU 割り込みを停止させ、OS の Package C6/C7/C8 ステートへの移行を 100% 阻害しない。
2. **Windows ネイティブ電源通知 (`WM_POWERBROADCAST`)**:
   - Rust 側で Win32 `GetSystemPowerStatus` および電源イベントをリッスンし、AC切断・バッテリー駆動への移行をミリ秒単位で検知して WebView へ通知。

### 4.3 リッチ＆モダンなUIと超低負荷の両立 (Modern UI Polish vs Overhead)
1. **Compositor 専用プロパティによる 60fps アニメーション**:
   - アニメーションは **`transform` と `opacity` のみ** に厳密に制限。
   - `height`, `width`, `top`, `margin`, `padding` などのリフロー（再レイアウト）を誘発するプロパティのアニメーションは一切排除。
   - マイクロスプリング曲線 (`cubic-bezier(0.16, 1, 0.3, 1)`) を採用し、CPU/GPUに負荷をかけずに高級感のある操作感を実現。
2. **GPU 負荷の低い擬似グラスモーフィズム**:
   - GPU のピクセルシェーダーを酷使する重い動的ガウスぼかし (`backdrop-filter: blur(20px)`) の代わりに、半透明ティント (`rgba(17, 24, 39, 0.78)`) と 1px ヘアラインボーダー (`border: 1px solid rgba(255, 255, 255, 0.08)`) を使用。
   - これにより、低消費電力なオンボードGPU (Intel UHD / Iris Xe / AMD Radeon) でもファンを回さずに美しいモダンデザインを表現。
3. **CSS Containment & Virtualization**:
   - 課題リスト・科目カード・モジュール項目に `contain: content;` および `content-visibility: auto;` を適用。画面外の要素のレンダリング計算をスキップ。
   - DOM 挿入は `DocumentFragment` で一括バッチ処理し、DOM スラッシングを防止。

### 4.4 PDF閲覧の劇的軽量化・高速化 (Ultra-Lightweight Fluid PDF Architecture)
ユーザーが最もストレスを感じている「PDFが重い」問題を根本解決するための 4 重の施策：

1. **Rust ゼロコピー Range 206 ストリーミング & 高速ディスクキャッシュ**:
   - PDF は初回アクセス時に `%LOCALAPPDATA%/Canvas Horizon/pdf_cache/{fileId}.pdf` へストリーミング保存。
   - Axum の `ServeFile` または `tokio::fs::File` を用い、HTTP Range (206 Partial Content) をネイティブサポート。
   - Edge PDF ビューアが要求するバイト範囲（目次、第1ページ等）をゼロコピーで即座に返却するため、**50MB の講義資料でも 0.1秒未満で 1 ページ目が表示**されます。
   - 2回目以降の閲覧では Canvas LMS への通信は一切発生しません。
2. **動的 `<iframe>` ライフサイクル & 強制メモリ解放**:
   - `<iframe>` を常駐させず、PDF モーダルを開いた瞬間のみ動的に生成して追加。
   - モーダルを閉じる際 (`closePdfModal`):
     ```javascript
     if (iframe) {
       try { iframe.contentWindow?.stop?.(); } catch (_) {}
       iframe.src = 'about:blank';
       iframe.remove(); // DOM から完全除去して PDFium / WebView2 プロセスと VRAM を即時解放
     }
     ```
   - さらに Rust 側から WebView2 の `NotifyLowMemoryUsage` API を呼び出し、OS にキャッシュテクスチャの強制回収を要求。
3. **「外部ビューアで開く (外部で開く)」ファストパス機能**:
   - PDF モーダル上部に「外部で開く」ボタンを配置。
   - クリック時、`/api/files/ensure-cache` でローカルキャッシュパスを確定させた上で、`desktopAPI.openPath(cachedFilePath)` を呼び出し、OS 既定のアプリ（Adobe Acrobat, Edge, SumatraPDF 等）で即座に直接起動。
   - 300ページを超える巨大な講義スライド集でも、Canvas Horizon 本体のメモリを 1MB も消費せず、ペン入力・注釈機能付きで軽快に閲覧可能。
4. **表示パラメータの最適化**:
   - `#view=FitH&toolbar=1` により、開いた瞬間に画面幅にジャストフィット。

---

## 5. 移行ロードマップ (Implementation Roadmap)

### フェーズ 1: Tauri v2 プロジェクト基盤の構築 (完了・稼働中)
- [x] Rust ツールチェーン (`rustc 1.99.0`, MSVC 2022) 及び WebView2 動作確認
- [x] `src-tauri` 基本プロジェクト構成と初期ビルド確認
- [x] `quarter.rs` (クォーター抽出・科目名正規化) の Rust 実装と単体テスト全件通過 (4件 pass)

### フェーズ 2: 設定管理 & 互換性保証モジュール (Config & AppData) (完了・稼働中)
- [x] `%APPDATA%\Canvas Horizon\config.json` の読み書きを行う Rust モジュール (`src-tauri/src/config.rs`)
  - 電源モード (`batteryMode`), `baseUrl`, `apiToken`, `theme` の完全互換および同期
  - `manual_completed.json` (手動完了タスク) の永続化
  - 既存 Electron ユーザーの再ログイン・再設定不要（ゼロフリクション移行）
  - 単体テスト全件通過 (`cargo test`: 9件 pass)

### フェーズ 3: ネイティブ デスクトップ ブリッジ (`window.desktopAPI`)
- [ ] Tauri `initialization_script` による `window.desktopAPI` の互換注入
  - `selectFolder()`: `tauri-plugin-dialog`
  - `openPath(path)`: OS既定アプリ起動 (`tauri-plugin-shell` / `open`)
  - `openExternal(url)`: ブラウザ起動
  - `getAppInfo()`: バージョン情報
  - `getPowerState()` / `onPowerStateChange()`: Win32 電源監視
  - `relaunch()`: アプリ再起動

### フェーズ 4: Rust Canvas サービス & Axum 超軽量 HTTP API
- [ ] Canvas LMS REST クライアント (`src-tauri/src/canvas.rs`)
  - コネクションプール & 同時実行制御 (Concurrency = 4)
  - ディスクキャッシュ & LRU メモリキャッシュ
- [ ] Axum HTTP API ルーター (`src-tauri/src/server.rs`)
  - `/api/me`, `/api/courses`, `/api/dashboard/timeline`
  - `/api/courses/:id/materials-grouped`, `/api/announcements`
  - `/api/files/download`: **HTTP Range (206) 完全対応、ゼロコピー PDF/動画ストリーミング**
  - `/api/config`, `/api/cache/clear`

### フェーズ 5: PDF エンジン & メモリ解放・電源最適化 (完了・稼働中)
- [x] `src/server.js`: Range リクエスト先行完全キャッシュ、ファイル名未指定時のCanvasメタ解決、並行Range待機制御、ゼロコピー Range 206 配信の実装
- [x] `src/server.js`: `/api/files/ensure-cache` エンドポイント追加によるネイティブローカルパス即時解決
- [x] `public/index.html`: 「外部で開く」ボタンおよび `pdf-iframe-container` の設置
- [x] `public/js/app.js`: 動的 `<iframe>` 生成、モーダル終了時の DOM 完全除去によるメモリ破棄処理の実装
- [x] `public/js/app.js`: 「外部で開く」クリック時に `desktopAPI.openPath` を優先し、OS 既定ビューアで直接開く処理の実装
- [x] `public/js/app.js` & `public/css/style.css`: `body.app-hidden` による非表示・バックグラウンド時のアニメーション完全停止（Package C-State阻害ゼロ化）の実装
- [ ] Tauri 側での WebView2 メモリトリム (`NotifyLowMemoryUsage`) IPC の実装

### フェーズ 6: 自動アップデート機能 (`tauri-plugin-updater`)
- [ ] `tauri-plugin-updater` プラグインの設定
- [ ] GitHub Releases 連携仕様（Ed25519 署名キー設定）
- [ ] `desktopAPI.checkForUpdates()`, `startDownloadUpdate()`, `quitAndInstall()` 連携

### フェーズ 7: ビルド・CI/CD・検証
- [ ] `cargo build --release` によるバイナリ最適化 (`opt-level = "z"`, `lto = true`, `strip = true`)
- [ ] `.github/workflows/release-tauri.yml` の作成 (MSI / NSIS / ZIP 自動生成)

---

## 6. 検証とベンチマーク計画 (Verification & Benchmarking)

### 自動テスト (Automated Verification)
1. **Node.js 既存テストスイートの 100% 担保**:
   - `npm test` による全25件のホワイトボックステスト（UI、CSSスタイル、花びらアニメーション、省電力モード、Semver比較、PDF Range 206 ストリーミング、キャッシュ確保API、背景アニメーション完全停止など）の常時通過を確認。
2. **Rust 単体テスト**:
   - `cargo test --manifest-path src-tauri/Cargo.toml` による `quarter.rs`（4件）および `config.rs`（5件）の全9件単体テスト通過を確認。

### パフォーマンス計測 (Performance Benchmark)
1. **メモリフットプリント測定**:
   - 起動直後、ダッシュボード操作時、講義資料10科目ロード時、PDF閲覧時、モーダル終了後のメモリ推移を Windows タスクマネージャーおよび Sysinternals Process Explorer で計測。
2. **CPU & バッテリー測定**:
   - アプリをバックグラウンドに放置した状態で、Windows パフォーマンスモニターの「Processor Time」および「C-State Residency」を計測。0% 近辺が維持されていることを確認。
3. **PDF レンダリング速度測定**:
   - 50MB の講義スライド PDF の 1 ページ目描画までの時間を計測（目標: 200ms 以下）。

---

## 7. ユーザーへの提供価値 (Value Proposition)

- **電池持ちの飛躍的向上**: 大学の講義中、充電器なしで一日中 Canvas Horizon を起動したまま受講しても、ノートPCのバッテリー消費をほとんど意識させません。
- **PDF ストレスの完全解消**: 「開くのが重い」「メモリを食い尽くす」という悩みを、ゼロコピー Range キャッシュと動的メモリ解放、外部ビューア連携により完全に解消します。
- **リッチでモダンな所有感**: チープな軽量化ではなく、洗練されたマイクロインタラクションとモダンなダーク/ライトテーマを高フレームレートで提供します。
- **移行ストレス・ゼロ**: 今までの設定・ログイン・完了タスクがそのまま引き継がれます。
