import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Frontend UI English copy (#540)', () => {
  const publicDir = path.join(__dirname, '..', '..', 'public');
  const jsDir = path.join(publicDir, 'js');
  const publicRoot = path.join(__dirname, '..', '..');
  const vendorFiles = new Set([
    'mammoth.browser.min.js',
    'xlsx.full.min.js',
    'jszip.min.js',
  ]);
  const filesToScan = [
    ...fs
      .readdirSync(publicDir)
      .filter((name) => name.endsWith('.html'))
      .map((name) => path.join(publicDir, name)),
    ...fs
      .readdirSync(jsDir)
      .filter((name) => name.endsWith('.js') && !vendorFiles.has(name))
      .map((name) => path.join(jsDir, name)),
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
    const commonJs = fs.readFileSync(path.join(jsDir, 'common.js'), 'utf-8');
    const dashboardJs = fs.readFileSync(
      path.join(jsDir, 'dashboard.js'),
      'utf-8'
    );
    const projectJs = fs.readFileSync(path.join(jsDir, 'project.js'), 'utf-8');

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
