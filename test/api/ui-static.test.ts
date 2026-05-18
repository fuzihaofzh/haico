import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Frontend UI English copy (#540)', () => {
  const publicDir = path.join(__dirname, '..', '..', 'public');
  const jsDir = path.join(publicDir, 'js');
  const vendorDir = path.join(publicDir, 'vendor');
  const publicRoot = path.join(__dirname, '..', '..');
  const vendorFiles = new Set([
    'docx-preview.min.js',
    'mammoth.browser.min.js',
    'xlsx.full.min.js',
    'jszip.min.js',
  ]);
  function listFilesRecursive(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      return entry.isDirectory() ? listFilesRecursive(entryPath) : [entryPath];
    });
  }
  const filesToScan = [
    ...fs
      .readdirSync(publicDir)
      .filter((name) => name.endsWith('.html'))
      .map((name) => path.join(publicDir, name)),
    ...listFilesRecursive(jsDir).filter((filePath) => filePath.endsWith('.js')),
  ];
  const hanRegex = /\p{Script=Han}/u;

  it('public HTML and JS files do not contain Han characters', () => {
    const offenders: string[] = [];

    for (const filePath of filesToScan) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (hanRegex.test(content)) {
        offenders.push(path.relative(publicRoot, filePath));
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('third-party browser bundles live under public/vendor', () => {
    for (const fileName of vendorFiles) {
      assert.equal(fs.existsSync(path.join(jsDir, fileName)), false);
      assert.equal(fs.existsSync(path.join(vendorDir, fileName)), true);
    }
  });

  it('first-party browser scripts are classified under role directories', () => {
    const rootJsFiles = fs
      .readdirSync(jsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => entry.name);

    assert.deepEqual(rootJsFiles, []);
  });

  it('representative UI strings are translated to English', () => {
    const dashboardHtml = fs.readFileSync(
      path.join(publicDir, 'index.html'),
      'utf-8'
    );
    const projectHtml = fs.readFileSync(
      path.join(publicDir, 'project.html'),
      'utf-8'
    );
    const agentHtml = fs.readFileSync(
      path.join(publicDir, 'agent.html'),
      'utf-8'
    );
    const commonJs = fs.readFileSync(
      path.join(jsDir, 'shared', 'common.js'),
      'utf-8'
    );
    const dashboardJs = fs.readFileSync(
      path.join(jsDir, 'pages', 'dashboard.js'),
      'utf-8'
    );
    const projectJs = fs.readFileSync(
      path.join(jsDir, 'pages', 'project.js'),
      'utf-8'
    );

    assert.ok(dashboardHtml.includes('Search issues...'));
    assert.ok(projectHtml.includes('Share Settings'));
    assert.ok(projectHtml.includes('+ Add Knowledge'));
    assert.ok(projectHtml.includes('Grant Access'));
    assert.ok(agentHtml.includes('Activity Summary'));
    assert.ok(commonJs.includes('Loading...'));
    assert.ok(commonJs.includes('Live updates connected'));
    assert.ok(dashboardJs.includes('No notifications'));
    assert.ok(projectJs.includes('No knowledge entries yet.'));
  });
});
