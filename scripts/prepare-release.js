/**
 * GitHub Actions リリース用バージョン解決スクリプト
 * タグまたは package.json からリリースバージョンを出力します。
 * （※副作用のある勝手なコミットやプッシュ、タグの自動加算は行いません）
 */

const fs = require('fs');

const pkgPath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
let version = pkg.version;
let tag = `v${version}`;

const ref = process.env.GITHUB_REF || '';
const refName = process.env.GITHUB_REF_NAME || '';

if (ref.startsWith('refs/tags/')) {
  tag = refName;
  version = tag.replace(/^v/, '');
  console.log(`Release triggered by tag: ${tag} (version ${version})`);
} else {
  console.log(`Release triggered by manual dispatch/branch: using package.json version ${version} (${tag})`);
}

// package.json / Tauri / Rust のバージョンとタグを同期（ビルド成果物に反映）
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}
try {
  const tauriConfPath = 'src-tauri/tauri.conf.json';
  if (fs.existsSync(tauriConfPath)) {
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    if (tauriConf.version !== version) {
      tauriConf.version = version;
      fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');
    }
  }
  const cargoTomlPath = 'src-tauri/Cargo.toml';
  if (fs.existsSync(cargoTomlPath)) {
    const cargoRaw = fs.readFileSync(cargoTomlPath, 'utf8');
    const updatedCargo = cargoRaw.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
    if (updatedCargo !== cargoRaw) {
      fs.writeFileSync(cargoTomlPath, updatedCargo, 'utf8');
    }
  }
  const serverRsPath = 'src-tauri/src/server.rs';
  if (fs.existsSync(serverRsPath)) {
    const serverRaw = fs.readFileSync(serverRsPath, 'utf8');
    const updatedServer = serverRaw.replace(/pub const APP_VERSION: &str = "[^"]+";/, `pub const APP_VERSION: &str = "${version}";`);
    if (updatedServer !== serverRaw) {
      fs.writeFileSync(serverRsPath, updatedServer, 'utf8');
    }
  }
  const indexHtmlPath = 'public/index.html';
  if (fs.existsSync(indexHtmlPath)) {
    const htmlRaw = fs.readFileSync(indexHtmlPath, 'utf8');
    const updatedHtml = htmlRaw
      .replace(/css\/style\.css\?v=[^"'\s>]+/g, `css/style.css?v=${version}`)
      .replace(/js\/app\.js\?v=[^"'\s>]+/g, `js/app.js?v=${version}`)
      .replace(/\/sw\.js(?:\?v=[^"'\s)]+)?/g, `/sw.js?v=${version}`);
    if (updatedHtml !== htmlRaw) {
      fs.writeFileSync(indexHtmlPath, updatedHtml, 'utf8');
    }
  }
  const swJsPath = 'public/sw.js';
  if (fs.existsSync(swJsPath)) {
    const swRaw = fs.readFileSync(swJsPath, 'utf8');
    const updatedSw = swRaw.replace(/const CACHE_NAME = 'canvas-horizon-v[^']*';/, `const CACHE_NAME = 'canvas-horizon-v${version}';`);
    if (updatedSw !== swRaw) {
      fs.writeFileSync(swJsPath, updatedSw, 'utf8');
    }
  }
} catch (err) {
  console.warn('Warning syncing Rust version metadata:', err.message);
}

// GitHub Actions への環境変数出力
if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, `RELEASE_TAG=${tag}\n`);
  fs.appendFileSync(process.env.GITHUB_ENV, `RELEASE_VER=${version}\n`);
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

console.log(`Prepared release: tag=${tag}, version=${version}`);
