const { app, BrowserWindow, Menu, shell, screen } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

app.setName('HAICO');

const SERVER_PORT = 4567;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

function resolveProjectRoot() {
  const bundledProject = path.join(process.resourcesPath, 'project');
  try {
    fs.accessSync(path.join(bundledProject, 'package.json'));
    console.log('[haico] Using bundled project at:', bundledProject);
    return { root: bundledProject, source: 'bundled' };
  } catch {}

  const appDir = path.dirname(app.getAppPath());
  try {
    fs.accessSync(path.join(appDir, 'package.json'));
    console.log('[haico] Using project next to app:', appDir);
    return { root: appDir, source: 'adjacent' };
  } catch {}

  let dir = __dirname;
  for (let i = 0; i < 5; i += 1) {
    dir = path.dirname(dir);
    try {
      fs.accessSync(path.join(dir, 'package.json'));
      console.log('[haico] Using project at:', dir);
      return { root: dir, source: 'walk' };
    } catch {}
  }

  const cwd = process.cwd();
  console.log('[haico] Fallback to cwd:', cwd);
  return { root: cwd, source: 'cwd' };
}

function getLoginShellPath() {
  const userShell = process.env.SHELL || '/bin/zsh';
  const shellsToTry = userShell.endsWith('/fish')
    ? ['/bin/zsh', userShell]
    : [userShell, '/bin/zsh'];

  for (const sh of shellsToTry) {
    try {
      const cmd = sh.endsWith('/fish') ? 'string join : $PATH' : 'echo $PATH';
      const result = execSync(`${sh} -lic '${cmd}'`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (result && result.includes('/')) {
        return result;
      }
    } catch {}
  }

  return null;
}

function findNode(root) {
  const bundledNode = path.join(root, 'node', 'bin', 'node');
  try {
    fs.accessSync(bundledNode, fs.constants.X_OK);
    return bundledNode;
  } catch {}

  const nvmBase = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmBase).sort().reverse();
    for (const version of versions) {
      const nodePath = path.join(nvmBase, version, 'bin', 'node');
      try {
        fs.accessSync(nodePath, fs.constants.X_OK);
        return nodePath;
      } catch {}
    }
  } catch {}

  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  try {
    const result = execSync('which node', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) return result;
  } catch {}

  return null;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(300);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, '127.0.0.1');
  });
}

async function waitForReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(SERVER_PORT)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

let serverProcess = null;
let ownsServer = false;

function resolveDefaultDbPath(rootInfo) {
  if (process.env.HAICO_DB_PATH) return process.env.HAICO_DB_PATH;
  if (rootInfo.source === 'bundled') {
    return path.join(app.getPath('userData'), 'haico.db');
  }
  return path.join(rootInfo.root, 'haico.db');
}

function startServer(rootInfo) {
  const nodePath = findNode(rootInfo.root);
  if (!nodePath) {
    console.error('[haico-server] Cannot find node binary');
    return false;
  }

  console.log('[haico-server] Using node at:', nodePath);
  const shellPath = getLoginShellPath() || process.env.PATH || '/usr/bin:/bin';
  const nodeBinDir = path.dirname(nodePath);
  const env = {
    ...process.env,
    PATH: `${shellPath}:${nodeBinDir}`,
    HAICO_HOST: '127.0.0.1',
    HAICO_PORT: String(SERVER_PORT),
    HAICO_DB_PATH: resolveDefaultDbPath(rootInfo),
  };
  console.log('[haico-server] PATH:', env.PATH);
  console.log('[haico-server] DB:', env.HAICO_DB_PATH);

  serverProcess = spawn(nodePath, ['dist/index.js'], {
    cwd: rootInfo.root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (data) => {
    console.log('[haico-server]', data.toString().trimEnd());
  });
  serverProcess.stderr.on('data', (data) => {
    console.log('[haico-server]', data.toString().trimEnd());
  });
  serverProcess.on('error', (error) => {
    console.log('[haico-server] failed to start:', error.message);
  });
  serverProcess.on('exit', (code) => {
    console.log('[haico-server] exited with code', code);
  });

  return true;
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

function setupMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let mainWindow = null;

function toDataUrl(html) {
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1500, Math.round(screenW * 0.9)),
    height: Math.min(960, Math.round(screenH * 0.9)),
    minWidth: 960,
    minHeight: 640,
    title: 'HAICO',
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SERVER_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(SERVER_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function loadingHTML() {
  return toDataUrl(
    `<html><body style="margin:0;background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center"><div><div style="font-size:18px;font-weight:600;letter-spacing:0.08em;margin-bottom:12px">HAICO</div><div style="font-size:14px;color:#94a3b8">Starting desktop workspace...</div></div></body></html>`
  );
}

function errorHTML(message) {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\n/g, '<br>');

  return toDataUrl(
    `<html><body style="margin:0;background:#020617;color:#fca5a5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;font-size:14px;padding:40px"><div>${escaped}</div></body></html>`
  );
}

app.whenReady().then(async () => {
  setupMenu();

  const rootInfo = resolveProjectRoot();
  mainWindow = createWindow();
  mainWindow.loadURL(loadingHTML());

  const alreadyRunning = await isPortOpen(SERVER_PORT);
  if (!alreadyRunning) {
    ownsServer = true;
    if (!startServer(rootInfo)) {
      mainWindow.loadURL(errorHTML('Cannot find a usable Node.js runtime.\nMake sure Node.js is installed or bundled.'));
      return;
    }
  }

  const ready = alreadyRunning || await waitForReady();
  if (ready) {
    mainWindow.loadURL(SERVER_URL);
  } else {
    mainWindow.loadURL(errorHTML(`Failed to start the HAICO server.\nRun 'npm run build' in:\n${rootInfo.root}`));
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  if (ownsServer) stopServer();
});
