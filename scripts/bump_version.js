/**
 * EXTRATJUD - Version Bump Script
 * 
 * Single source of truth: package.json
 * Bump rule: patch++ (3.0.0 → 3.0.1 → ... → 3.0.9 → 3.1.0 → ...)
 * 
 * Usage:
 *   npm run bump-version          # Normal bump
 *   npm run bump-version -- --force  # Force bump even if no changes
 *   npm run bump-version -- --dry-run # Preview without writing
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const updatesPath = path.join(root, 'config', 'updates.json');
const versionsPath = path.join(root, 'VERSIONS.md');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// --- Parse version ---
const pkg = readJSON(pkgPath);
if (!pkg) { console.error('package.json not found'); process.exit(1); }

const oldVersion = String(pkg.version || '0.0.0').replace(/^v/i, '');
const parts = oldVersion.split('.').map(n => parseInt(n) || 0);
let [major, minor, patch] = [parts[0], parts[1], parts[2]];

// Bump: patch++ → if patch > 9 → minor++, patch=0 → if minor > 9 → major++, minor=0
patch += 1;
if (patch > 9) { patch = 0; minor += 1; }
if (minor > 9) { minor = 0; major += 1; }

const newVersion = `${major}.${minor}.${patch}`;

// --- Dry run ---
const dryRun = process.argv.includes('--dry-run') || !!process.env.DRY_RUN;
if (dryRun) {
  console.log(`Current:  v${oldVersion}`);
  console.log(`Proposed: v${newVersion}`);
  console.log('Files to update: package.json, config/updates.json, VERSIONS.md');
  process.exit(0);
}

// --- Force check ---
const force = process.argv.includes('--force') || !!process.env.FORCE_BUMP;
if (!force) {
  try {
    const head = execSync('git rev-parse --verify HEAD').toString().trim();
    const lastPkgCommit = execSync(`git log -1 --pretty=format:%H -- ${pkgPath}`).toString().trim();
    if (lastPkgCommit === head) {
      console.log('No commits since last release. Skipping bump. Use --force to override.');
      process.exit(0);
    }
    const diffRaw = execSync(`git diff --name-only ${lastPkgCommit}..HEAD`).toString().trim();
    const diffFiles = diffRaw ? diffRaw.split(/\r?\n/).filter(Boolean) : [];
    const ignored = ['VERSIONS.md', 'config/updates.json', '.github/'].map(f => f.replace(/\\/g, '/'));
    const relevant = diffFiles.map(f => f.replace(/\\/g, '/')).filter(f => !ignored.some(i => f.startsWith(i) || f === i));
    if (relevant.length === 0) {
      console.log('No app-relevant changes. Skipping bump. Use --force to override.');
      process.exit(0);
    }
  } catch { /* git check failed, proceed */ }
}

// --- Get commit info ---
let commitMsg = '', shortSha = '';
try {
  commitMsg = execSync('git log -1 --pretty=%B').toString().trim().split('\n')[0];
  shortSha = execSync('git rev-parse --short HEAD').toString().trim();
} catch { /* ignore */ }

// --- Update package.json ---
pkg.version = newVersion;
writeJSON(pkgPath, pkg);

// --- Update updates.json ---
const upd = readJSON(updatesPath) || {};
upd.version = newVersion;
upd.published_at = new Date().toISOString();
writeJSON(updatesPath, upd);

// --- Append to VERSIONS.md ---
const dateStr = new Date().toISOString().split('T')[0];
const entry = [
  `## v${newVersion} - ${dateStr}`,
  '',
  `- Commit: ${shortSha}`,
  `- Notes: ${commitMsg || 'n/a'}`,
  ''
].join('\n');

if (fs.existsSync(versionsPath)) {
  fs.appendFileSync(versionsPath, entry, 'utf8');
} else {
  fs.writeFileSync(versionsPath, `# EXTRATJUD - Version History\n\n${entry}`, 'utf8');
}

// --- Git commit ---
try {
  execSync(`git add ${pkgPath} ${updatesPath} ${versionsPath}`);
  execSync(`git commit -m "chore(release): v${newVersion} [skip ci]"`);
  console.log(`Bumped to v${newVersion}`);

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `bumped=true\nversion=${newVersion}\n`, 'utf8');
  }
} catch (e) {
  console.log(`Bumped to v${newVersion} (no commit)`);
}

process.exit(0);
