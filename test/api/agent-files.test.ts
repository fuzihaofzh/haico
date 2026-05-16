import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ApiTestHarness } from './helpers';
import { createApiTestHarness } from './helpers';

describe('Agent File API', () => {
  let ctx: ApiTestHarness;
  let projectId: string;
  let fileAgentId: string;
  let noWorkdirAgentId: string;
  let tmpDir: string;

  before(async () => {
    ctx = await createApiTestHarness('agent-files');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haico-files-'));
    fs.mkdirSync(path.join(tmpDir, 'nested'));
    fs.writeFileSync(path.join(tmpDir, 'visible.txt'), 'hello from file api');
    fs.writeFileSync(path.join(tmpDir, '.hidden.txt'), 'hidden');
    fs.writeFileSync(
      path.join(tmpDir, 'nested', 'child.ts'),
      'export const value = 1;\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'binary.bin'),
      Buffer.from([0, 1, 2, 3])
    );
    fs.writeFileSync(
      path.join(tmpDir, 'test.html'),
      '<html><body><h1>Hello</h1></body></html>'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'test.pdf'),
      '%PDF-1.4 fake pdf content'
    );

    const project = await ctx.api('/api/projects', {
      method: 'POST',
      body: {
        name: 'agent-files-project',
        description: 'Agent files test',
        task_description: 'Test file APIs',
        command_template: 'echo',
      },
    });
    assert.equal(project.status, 201);
    projectId = project.body.id;

    const fileAgent = await ctx.api(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: {
        name: 'file-api-agent',
        role: 'File API test agent',
        working_directory: tmpDir,
      },
    });
    assert.equal(fileAgent.status, 201);
    fileAgentId = fileAgent.body.id;

    const noWorkdirAgent = await ctx.api(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: { name: 'no-workdir-agent', role: 'No workdir agent' },
    });
    assert.equal(noWorkdirAgent.status, 201);
    noWorkdirAgentId = noWorkdirAgent.body.id;
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists visible files by default and hides dotfiles', async () => {
    const { status, body } = await ctx.api(`/api/agents/${fileAgentId}/files`);
    assert.equal(status, 200);
    assert.equal(body.path, '');
    assert.equal(body.showHidden, false);
    assert.ok(Array.isArray(body.entries));

    const names = body.entries.map((entry: any) => entry.name);
    assert.deepEqual(
      new Set(names),
      new Set(['nested', 'binary.bin', 'test.html', 'test.pdf', 'visible.txt'])
    );
    assert.ok(!names.includes('.hidden.txt'));
    assert.equal(
      body.entries.find((entry: any) => entry.name === 'nested')?.type,
      'dir'
    );
    assert.equal(
      typeof body.entries.find((entry: any) => entry.name === 'binary.bin')
        ?.size,
      'number'
    );
  });

  it('includes dotfiles when showHidden is enabled', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${fileAgentId}/files?showHidden=1`
    );
    assert.equal(status, 200);
    assert.ok(body.entries.some((entry: any) => entry.name === '.hidden.txt'));
  });

  it('rejects path traversal outside the working directory', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${fileAgentId}/files?path=../`
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Path is outside the working_directory');
  });

  it('returns 400 when the agent has no working directory configured', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${noWorkdirAgentId}/files`
    );
    assert.equal(status, 400);
    assert.equal(
      body.error,
      'Agent does not have a working_directory configured'
    );
  });

  it('reads text files as plain text', async () => {
    const res = await ctx.inject({
      url: `/api/agents/${fileAgentId}/files/content?path=${encodeURIComponent(
        'nested/child.ts'
      )}`,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).includes('text/plain'));
    assert.equal(res.body, 'export const value = 1;\n');
  });

  it('rejects binary file previews', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${fileAgentId}/files/content?path=${encodeURIComponent(
        'binary.bin'
      )}`
    );
    assert.equal(status, 415);
    assert.equal(body.error, 'Cannot preview binary files');
  });

  it('writes file contents within the working directory', async () => {
    const update = await ctx.api(`/api/agents/${fileAgentId}/files/content`, {
      method: 'PUT',
      body: { path: 'visible.txt', content: 'updated content\n' },
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.path, 'visible.txt');
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'visible.txt'), 'utf-8'),
      'updated content\n'
    );
  });

  it('serves HTML files with correct content-type and CSP header', async () => {
    const res = await ctx.inject({
      url: `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent(
        'test.html'
      )}`,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).includes('text/html'));
    assert.ok(
      String(res.headers['content-security-policy']).includes(
        "default-src 'none'"
      )
    );
    assert.ok(res.body.includes('<h1>Hello</h1>'));
  });

  it('serves PDF files with correct content-type', async () => {
    const res = await ctx.inject({
      url: `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent(
        'test.pdf'
      )}`,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).includes('application/pdf'));
    assert.ok(res.body.includes('%PDF'));
  });

  it('rejects non-previewable files from serve endpoint', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent(
        'visible.txt'
      )}`
    );
    assert.equal(status, 415);
    assert.ok(body.error.includes('cannot be served for preview'));
  });

  it('rejects path traversal on serve endpoint', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent(
        '../etc/passwd.html'
      )}`
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Path is outside the working_directory');
  });

  it('serve endpoint requires path parameter', async () => {
    const { status } = await ctx.api(`/api/agents/${fileAgentId}/files/serve`);
    assert.equal(status, 400);
  });

  it('serve endpoint returns 404 for nonexistent file', async () => {
    const { status } = await ctx.api(
      `/api/agents/${fileAgentId}/files/serve?path=${encodeURIComponent(
        'nonexistent.pdf'
      )}`
    );
    assert.equal(status, 404);
  });

  it('uploads a text file to valid path', async () => {
    const boundary = `----TestBoundary${Date.now()}`;
    const fileContent = 'uploaded file content';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="uploaded.txt"',
      'Content-Type: text/plain',
      '',
      fileContent,
      `--${boundary}--`,
    ].join('\r\n');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${fileAgentId}/files/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 200);
    const result = JSON.parse(res.body);
    assert.equal(result.success, true);
    assert.equal(result.name, 'uploaded.txt');
    assert.equal(result.path, 'uploaded.txt');
    assert.equal(typeof result.size, 'number');
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'uploaded.txt'), 'utf-8'),
      fileContent
    );
  });

  it('uploads a file to a subdirectory via path field', async () => {
    const boundary = `----TestBoundary${Date.now()}`;
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="path"',
      '',
      'nested',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="sub-upload.txt"',
      'Content-Type: text/plain',
      '',
      'sub dir content',
      `--${boundary}--`,
    ].join('\r\n');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${fileAgentId}/files/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 200);
    const result = JSON.parse(res.body);
    assert.equal(result.success, true);
    assert.equal(result.path, 'nested/sub-upload.txt');
    assert.ok(fs.existsSync(path.join(tmpDir, 'nested', 'sub-upload.txt')));
  });

  it('rejects upload with path traversal attack', async () => {
    const boundary = `----TestBoundary${Date.now()}`;
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="path"',
      '',
      '../../etc',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="passwd"',
      'Content-Type: text/plain',
      '',
      'malicious content',
      `--${boundary}--`,
    ].join('\r\n');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${fileAgentId}/files/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(
      JSON.parse(res.body).error,
      'Path is outside the working_directory'
    );
  });

  it('returns 400 when no file is provided in upload', async () => {
    const boundary = `----TestBoundary${Date.now()}`;
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="path"',
      '',
      '',
      `--${boundary}--`,
    ].join('\r\n');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${fileAgentId}/files/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'No files uploaded');
  });

  it('upload creates parent directories automatically', async () => {
    const boundary = `----TestBoundary${Date.now()}`;
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="path"',
      '',
      'new-dir/sub-dir',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="deep.txt"',
      'Content-Type: text/plain',
      '',
      'deep content',
      `--${boundary}--`,
    ].join('\r\n');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${fileAgentId}/files/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 200);
    const result = JSON.parse(res.body);
    assert.equal(result.success, true);
    assert.equal(result.path, 'new-dir/sub-dir/deep.txt');
    assert.ok(
      fs.existsSync(path.join(tmpDir, 'new-dir', 'sub-dir', 'deep.txt'))
    );
  });

  it('rejects upload for agent without working_directory', async () => {
    const boundary = `----TestBoundary${Date.now()}`;
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="test.txt"',
      'Content-Type: text/plain',
      '',
      'content',
      `--${boundary}--`,
    ].join('\r\n');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${noWorkdirAgentId}/files/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(
      JSON.parse(res.body).error,
      'Agent does not have a working_directory configured'
    );
  });

  it('downloads an existing text file with correct headers', async () => {
    const res = await ctx.inject({
      url: `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent(
        'visible.txt'
      )}`,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(
      String(res.headers['content-disposition']).includes('attachment')
    );
    assert.ok(
      String(res.headers['content-disposition']).includes('visible.txt')
    );
    assert.ok(String(res.headers['content-type']).includes('text/plain'));
  });

  it('downloads a binary file with correct content-type', async () => {
    const res = await ctx.inject({
      url: `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent(
        'binary.bin'
      )}`,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(
      String(res.headers['content-disposition']).includes('attachment')
    );
    assert.ok(
      String(res.headers['content-disposition']).includes('binary.bin')
    );
    assert.ok(
      String(res.headers['content-type']).includes('application/octet-stream')
    );
  });

  it('downloads a PDF file with application/pdf content-type', async () => {
    const res = await ctx.inject({
      url: `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent(
        'test.pdf'
      )}`,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).includes('application/pdf'));
    assert.ok(
      String(res.headers['content-disposition']).includes('attachment')
    );
  });

  it('returns 404 when downloading a nonexistent file', async () => {
    const { status } = await ctx.api(
      `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent(
        'nonexistent.txt'
      )}`
    );
    assert.equal(status, 404);
  });

  it('rejects download path traversal attack', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent(
        '../../etc/passwd'
      )}`
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'Path is outside the working_directory');
  });

  it('download requires path parameter', async () => {
    const { status } = await ctx.api(
      `/api/agents/${fileAgentId}/files/download`
    );
    assert.equal(status, 400);
  });

  it('rejects download for agent without working_directory', async () => {
    const { status, body } = await ctx.api(
      `/api/agents/${noWorkdirAgentId}/files/download?path=test.txt`
    );
    assert.equal(status, 400);
    assert.equal(
      body.error,
      'Agent does not have a working_directory configured'
    );
  });

  it('uploaded file appears in file listing', async () => {
    const boundary = `----TestBoundary${Date.now()}`;
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="integration-test.txt"',
      'Content-Type: text/plain',
      '',
      'integration test content',
      `--${boundary}--`,
    ].join('\r\n');

    const uploadRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${fileAgentId}/files/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(uploadRes.statusCode, 200);

    const { status, body } = await ctx.api(`/api/agents/${fileAgentId}/files`);
    assert.equal(status, 200);
    const fileNames = body.entries.map((entry: any) => entry.name);
    assert.ok(
      fileNames.includes('integration-test.txt'),
      `Expected integration-test.txt in file list, got: ${fileNames}`
    );
  });

  it('downloaded file content matches original', async () => {
    const originalContent =
      'exact content for roundtrip test\nwith multiple lines';
    fs.writeFileSync(path.join(tmpDir, 'roundtrip.txt'), originalContent);

    const res = await ctx.inject({
      url: `/api/agents/${fileAgentId}/files/download?path=${encodeURIComponent(
        'roundtrip.txt'
      )}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, originalContent);
  });
});
