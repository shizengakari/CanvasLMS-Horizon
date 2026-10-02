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

// package.json のバージョンとタグを同期（ビルド成果物に反映）
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
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
