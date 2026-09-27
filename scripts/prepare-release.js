const fs = require('fs');
const { execSync } = require('child_process');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
}

const pkgPath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
let version = pkg.version;
let tag = `v${version}`;

const ref = process.env.GITHUB_REF || '';
const refName = process.env.GITHUB_REF_NAME || '';

if (ref.startsWith('refs/tags/')) {
  tag = refName;
  version = tag.replace(/^v/, '');
  console.log(`Triggered by tag: ${tag} (version ${version})`);
} else {
  console.log(`Checking existing tags for current package version: ${tag}`);
  let existingTags = [];
  try {
    existingTags = run('git tag -l').split(/\r?\n/).map(t => t.trim()).filter(Boolean);
  } catch (e) {
    console.warn('Could not list tags:', e.message);
  }

  if (existingTags.includes(tag)) {
    // Increment patch version
    const parts = version.split('.').map(Number);
    parts[2] = (parts[2] || 0) + 1;
    version = parts.join('.');
    tag = `v${version}`;
    console.log(`Tag already exists. Auto-incremented version to ${version} (${tag})`);

    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    // Commit and push back to branch
    try {
      run('git config user.name "github-actions[bot]"');
      run('git config user.email "github-actions[bot]@users.noreply.github.com"');
      run(`git add ${pkgPath}`);
      run(`git commit -m "chore(release): bump version to ${version} [skip ci]"`);
      run('git push origin HEAD:master');
      console.log(`Committed and pushed updated package.json for ${version}`);
    } catch (err) {
      console.warn('Failed to push bumped package.json:', err.message);
    }
  }

  // Create tag and push tag
  try {
    run(`git tag -f ${tag}`);
    run(`git push origin ${tag} --force`);
    console.log(`Created and pushed tag ${tag}`);
  } catch (err) {
    console.warn('Failed to push tag:', err.message);
  }
}

// Export for GitHub Actions
if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, `RELEASE_TAG=${tag}\n`);
  fs.appendFileSync(process.env.GITHUB_ENV, `RELEASE_VER=${version}\n`);
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

console.log(`Prepared release: tag=${tag}, version=${version}`);
