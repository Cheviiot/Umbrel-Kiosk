/**
 * Umbrel Kiosk MiniBrowser - Main Process
 * Production-ready fullscreen kiosk browser for UmbrelOS
 */

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  session,
  dialog
} = require('electron');
const path = require('path');
const os = require('os');
const { getConfig } = require('./config');

// ============================================================================
// GPU & HARDWARE FLAGS - Optimized for bare metal stability
// ============================================================================

// Auto-detect: use Wayland if available, otherwise X11
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');

// GPU rendering - use ANGLE (default for Electron)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');

// Disable hardware cursor - we use software cursor (never disappears)
app.commandLine.appendSwitch('disable-gpu-cursor');

// Disable sandbox for kiosk mode
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_URL = 'http://umbrel.local';
const LOADING_TIMEOUT = 30000; // 30 seconds
const NETWORK_CHECK_INTERVAL = 5000; // 5 seconds
const UNRESPONSIVE_TIMEOUT = 30000; // 30 seconds

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let url = DEFAULT_URL;
  let insecure = false;
  let devMode = false;

  for (const arg of args) {
    if (arg.startsWith('--url=')) {
      url = arg.replace('--url=', '');
    } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
      url = arg;
    } else if (arg === '--insecure') {
      insecure = true;
    } else if (arg === '--dev') {
      devMode = true;
    }
  }

  return { url, insecure, devMode };
}

const cliConfig = parseArgs();
const appConfig = getConfig();

// ============================================================================
// LOGGING
// ============================================================================

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function logInfo(message, data) { log('info', message, data); }
function logWarn(message, data) { log('warn', message, data); }
function logError(message, data) { log('error', message, data); }

// ============================================================================
// MAIN WINDOW
// ============================================================================

let mainWindow = null;
let targetURL = cliConfig.url;  // The URL we want to load (preserved)
let currentURL = cliConfig.url; // Current displayed URL (can change)
let isOnline = true;
let networkCheckTimer = null;
let isShowingOverlay = false;

// Emulate Chrome browser User-Agent (some apps check for specific browsers)
const CHROME_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function createWindow() {
  logInfo('Creating main window', { url: currentURL, insecure: cliConfig.insecure });

  // Configure session for persistent cookies
  const ses = session.defaultSession;
  
  // Set User-Agent to emulate Chrome (helps with app compatibility)
  ses.setUserAgent(CHROME_USER_AGENT);
  
  // Handle self-signed certificates if --insecure flag is set
  if (cliConfig.insecure) {
    logWarn('Running in insecure mode - accepting self-signed certificates');
    ses.setCertificateVerifyProc((request, callback) => {
      callback(0); // Accept all certificates
    });
  }

  // Allow access to local network resources (Umbrel Docker network)
  // This helps with accessing services on different ports/IPs
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    // Remove restrictive headers that might block local network access
    const { requestHeaders } = details;
    callback({ requestHeaders });
  });

  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    kiosk: !cliConfig.devMode,
    fullscreen: !cliConfig.devMode,
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#000000',
    show: false, // Don't show until ready
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Disable sandbox for better compatibility with web apps
      webSecurity: false, // Allow cross-origin requests (needed for Umbrel apps)
      allowRunningInsecureContent: true, // Allow mixed content
      webgl: true, // Enable WebGL
      experimentalFeatures: true, // Enable experimental web features
      backgroundThrottling: false, // Don't throttle background tabs
      spellcheck: false,
      devTools: cliConfig.devMode,
      preload: path.join(__dirname, 'preload.js')
      // Use default session (not custom partition) for full localStorage/IndexedDB support
    }
  });

  // ============================================================================
  // NAVIGATION HANDLERS - Keep everything in one window
  // ============================================================================

  // Helper: Rewrite internal Umbrel Docker IPs to umbrel.local
  // UmbrelOS uses internal 10.21.x.x network for Docker containers
  // These IPs are not accessible from external kiosk device
  function rewriteUmbrelURL(url) {
    try {
      const parsed = new URL(url);
      // Check if this is an internal Umbrel Docker IP (10.21.x.x)
      if (/^10\.21\.\d+\.\d+$/.test(parsed.hostname)) {
        const baseHost = new URL(cliConfig.url).hostname;
        const newURL = `${parsed.protocol}//${baseHost}:${parsed.port || 80}${parsed.pathname}${parsed.search}${parsed.hash}`;
        logInfo('Rewriting internal Umbrel URL', { from: url, to: newURL });
        return newURL;
      }
      // Also rewrite localhost references to target host
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        const baseHost = new URL(cliConfig.url).hostname;
        const newURL = `${parsed.protocol}//${baseHost}:${parsed.port || 80}${parsed.pathname}${parsed.search}${parsed.hash}`;
        logInfo('Rewriting localhost URL', { from: url, to: newURL });
        return newURL;
      }
    } catch (e) {
      // Not a valid URL, return as-is
    }
    return url;
  }

  // Handle window.open() and target="_blank"
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    logInfo('Intercepted window.open/target="_blank"', { url });
    const rewrittenURL = rewriteUmbrelURL(url);
    // Load in current window instead of opening new one
    setImmediate(() => {
      mainWindow.loadURL(rewrittenURL);
    });
    return { action: 'deny' };
  });

  // Handle navigation events
  mainWindow.webContents.on('will-navigate', (event, url) => {
    logInfo('Navigation requested', { url });
    const rewrittenURL = rewriteUmbrelURL(url);
    
    // If URL was rewritten, cancel original navigation and load new URL
    if (rewrittenURL !== url) {
      event.preventDefault();
      mainWindow.loadURL(rewrittenURL);
      return;
    }
    
    // Only update currentURL for http/https URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      currentURL = url;
    }
  });

  mainWindow.webContents.on('did-navigate', (event, url) => {
    logInfo('Navigated to', { url });
    // Only update currentURL for http/https URLs, not local files
    if (url.startsWith('http://') || url.startsWith('https://')) {
      currentURL = url;
      // Inject nav panel and software cursor on each navigation to http/https pages
      setTimeout(() => {
        injectNavPanel();
        injectSoftwareCursor();
      }, 500);
    }
    hideOverlay();
  });

  mainWindow.webContents.on('did-navigate-in-page', (event, url) => {
    logInfo('In-page navigation', { url });
    // Only update currentURL for http/https URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      currentURL = url;
    }
  });

  // Handle redirects
  mainWindow.webContents.on('will-redirect', (event, url) => {
    logInfo('Redirect to', { url });
    const rewrittenURL = rewriteUmbrelURL(url);
    
    // If URL was rewritten, cancel original redirect and load new URL
    if (rewrittenURL !== url) {
      event.preventDefault();
      mainWindow.loadURL(rewrittenURL);
      return;
    }
    
    // Only update currentURL for http/https URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      currentURL = url;
    }
  });

  // Remove Content-Security-Policy headers that might block app functionality
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    // Remove CSP headers that might block scripts, styles, or connections
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    delete headers['x-content-security-policy'];
    delete headers['X-Content-Security-Policy'];
    // Remove X-Frame-Options to allow iframes
    delete headers['x-frame-options'];
    delete headers['X-Frame-Options'];
    callback({ responseHeaders: headers });
  });

  // ============================================================================
  // ERROR HANDLERS
  // ============================================================================

  // Handle page load errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logError('Page load failed', { errorCode, errorDescription, url: validatedURL });
    
    // Network errors
    if (errorCode === -106 || errorCode === -105 || errorCode === -102 || errorCode === -101) {
      isOnline = false;
      showNetworkError();
      startNetworkCheck();
    } else {
      showLoadError(errorDescription);
    }
  });

  // Handle certificate errors
  mainWindow.webContents.on('certificate-error', (event, url, error, certificate, callback) => {
    if (cliConfig.insecure) {
      logWarn('Certificate error ignored (insecure mode)', { url, error });
      event.preventDefault();
      callback(true);
    } else {
      logError('Certificate error', { url, error });
      callback(false);
    }
  });

  // Handle renderer crashes
  mainWindow.webContents.on('crashed', (event, killed) => {
    logError('Renderer crashed', { killed });
    showCrashOverlay();
    setTimeout(() => {
      reloadPage();
    }, 3000);
  });

  // Handle unresponsive renderer
  mainWindow.webContents.on('unresponsive', () => {
    logWarn('Renderer became unresponsive');
    showUnresponsiveOverlay();
  });

  mainWindow.webContents.on('responsive', () => {
    logInfo('Renderer became responsive again');
    hideOverlay();
  });

  // ============================================================================
  // WINDOW EVENTS
  // ============================================================================

  // Show loading screen first
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!cliConfig.devMode) {
      mainWindow.setFullScreen(true);
    }
  });

  // Prevent window from being closed
  mainWindow.on('close', (event) => {
    if (!cliConfig.devMode) {
      event.preventDefault();
      logWarn('Close attempt blocked');
    }
  });

  // Handle window focus loss
  mainWindow.on('blur', () => {
    if (!cliConfig.devMode) {
      mainWindow.focus();
    }
  });

  // Load initial page (loading screen)
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  // Then load target URL after a short delay
  setTimeout(() => {
    logInfo('Loading target URL', { url: targetURL });
    mainWindow.loadURL(targetURL);
  }, 500);
}

// ============================================================================
// OVERLAY FUNCTIONS
// ============================================================================

function showNetworkError() {
  if (isShowingOverlay) return;
  isShowingOverlay = true;
  
  mainWindow.webContents.executeJavaScript(`
    (function() {
      if (document.getElementById('umbrel-kiosk-overlay')) return;
      
      const overlay = document.createElement('div');
      overlay.id = 'umbrel-kiosk-overlay';
      overlay.innerHTML = \`
        <style>
          #umbrel-kiosk-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.95);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: white;
          }
          #umbrel-kiosk-overlay .icon {
            font-size: 64px;
            margin-bottom: 24px;
          }
          #umbrel-kiosk-overlay h1 {
            font-size: 32px;
            margin: 0 0 16px 0;
            font-weight: 500;
          }
          #umbrel-kiosk-overlay p {
            font-size: 18px;
            color: #888;
            margin: 0 0 32px 0;
          }
          #umbrel-kiosk-overlay button {
            background: #5352ed;
            color: white;
            border: none;
            padding: 16px 48px;
            font-size: 18px;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.2s;
          }
          #umbrel-kiosk-overlay button:hover {
            background: #3d3cba;
          }
          #umbrel-kiosk-overlay .spinner {
            width: 48px;
            height: 48px;
            border: 4px solid rgba(255,255,255,0.2);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-top: 24px;
            display: none;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        </style>
        <div class="icon">📡</div>
        <h1>Нет соединения</h1>
        <p>Проверьте подключение к сети</p>
        <button onclick="window.umbrelKiosk.retry()">Повторить</button>
        <div class="spinner" id="umbrel-spinner"></div>
      \`;
      document.body.appendChild(overlay);
    })();
  `).catch(() => {
    // If JavaScript execution fails, load error page
    mainWindow.loadFile(path.join(__dirname, 'error.html'));
  });
}

function showLoadError(description) {
  if (isShowingOverlay) return;
  isShowingOverlay = true;
  
  mainWindow.webContents.executeJavaScript(`
    (function() {
      if (document.getElementById('umbrel-kiosk-overlay')) return;
      
      const overlay = document.createElement('div');
      overlay.id = 'umbrel-kiosk-overlay';
      overlay.innerHTML = \`
        <style>
          #umbrel-kiosk-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.95);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: white;
          }
          #umbrel-kiosk-overlay .icon {
            font-size: 64px;
            margin-bottom: 24px;
          }
          #umbrel-kiosk-overlay h1 {
            font-size: 32px;
            margin: 0 0 16px 0;
            font-weight: 500;
          }
          #umbrel-kiosk-overlay p {
            font-size: 18px;
            color: #888;
            margin: 0 0 32px 0;
            max-width: 500px;
            text-align: center;
          }
          #umbrel-kiosk-overlay button {
            background: #5352ed;
            color: white;
            border: none;
            padding: 16px 48px;
            font-size: 18px;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.2s;
          }
          #umbrel-kiosk-overlay button:hover {
            background: #3d3cba;
          }
        </style>
        <div class="icon">⚠️</div>
        <h1>Ошибка загрузки</h1>
        <p>${description || 'Не удалось загрузить страницу'}</p>
        <button onclick="window.umbrelKiosk.retry()">Повторить</button>
      \`;
      document.body.appendChild(overlay);
    })();
  `).catch(() => {
    mainWindow.loadFile(path.join(__dirname, 'error.html'));
  });
}

function showCrashOverlay() {
  isShowingOverlay = true;
  mainWindow.loadFile(path.join(__dirname, 'crash.html'));
}

function showUnresponsiveOverlay() {
  isShowingOverlay = true;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const existing = document.getElementById('umbrel-kiosk-overlay');
      if (existing) existing.remove();
      
      const overlay = document.createElement('div');
      overlay.id = 'umbrel-kiosk-overlay';
      overlay.innerHTML = \`
        <style>
          #umbrel-kiosk-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.9);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: white;
          }
          #umbrel-kiosk-overlay .spinner {
            width: 48px;
            height: 48px;
            border: 4px solid rgba(255,255,255,0.2);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          #umbrel-kiosk-overlay p {
            margin-top: 24px;
            font-size: 18px;
            color: #888;
          }
        </style>
        <div class="spinner"></div>
        <p>Страница не отвечает, подождите...</p>
      \`;
      document.body.appendChild(overlay);
    })();
  `).catch(() => {});
}

function hideOverlay() {
  isShowingOverlay = false;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const overlay = document.getElementById('umbrel-kiosk-overlay');
      if (overlay) overlay.remove();
    })();
  `).catch(() => {});
}

// ============================================================================
// NETWORK CHECK
// ============================================================================

function startNetworkCheck() {
  if (networkCheckTimer) return;
  
  logInfo('Starting network check');
  networkCheckTimer = setInterval(async () => {
    try {
      const response = await mainWindow.webContents.executeJavaScript(`
        fetch('${currentURL}', { method: 'HEAD', mode: 'no-cors' })
          .then(() => true)
          .catch(() => false)
      `);
      
      if (response) {
        logInfo('Network restored');
        isOnline = true;
        stopNetworkCheck();
        hideOverlay();
        reloadPage();
      }
    } catch (e) {
      // Still offline
    }
  }, NETWORK_CHECK_INTERVAL);
}

function stopNetworkCheck() {
  if (networkCheckTimer) {
    clearInterval(networkCheckTimer);
    networkCheckTimer = null;
  }
}

function reloadPage() {
  logInfo('Reloading page', { url: currentURL });
  mainWindow.loadURL(currentURL);
}

// ============================================================================
// SERVICE MENU (Secret hotkey Ctrl+Alt+U)
// ============================================================================

let serviceMenuVisible = false;

function toggleServiceMenu() {
  serviceMenuVisible = !serviceMenuVisible;
  
  if (serviceMenuVisible) {
    showServiceMenu();
  } else {
    hideServiceMenu();
  }
}

function showServiceMenu() {
  const hostname = os.hostname();
  const networkInterfaces = os.networkInterfaces();
  let ipAddresses = [];
  
  for (const [name, interfaces] of Object.entries(networkInterfaces)) {
    for (const iface of interfaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ipAddresses.push(`${name}: ${iface.address}`);
      }
    }
  }
  
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const existing = document.getElementById('umbrel-service-menu');
      if (existing) existing.remove();
      
      const menu = document.createElement('div');
      menu.id = 'umbrel-service-menu';
      menu.innerHTML = \`
        <style>
          #umbrel-service-menu {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 400px;
            background: rgba(30, 30, 30, 0.98);
            border: 1px solid #444;
            border-radius: 12px;
            padding: 20px;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
            color: white;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          }
          #umbrel-service-menu h2 {
            margin: 0 0 16px 0;
            font-size: 18px;
            color: #5352ed;
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          #umbrel-service-menu .close-btn {
            background: none;
            border: none;
            color: #888;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            line-height: 1;
          }
          #umbrel-service-menu .close-btn:hover {
            color: white;
          }
          #umbrel-service-menu .info-row {
            margin-bottom: 12px;
            font-size: 13px;
          }
          #umbrel-service-menu .info-label {
            color: #888;
            margin-bottom: 4px;
          }
          #umbrel-service-menu .info-value {
            color: #fff;
            word-break: break-all;
            background: rgba(0,0,0,0.3);
            padding: 8px;
            border-radius: 6px;
            font-family: monospace;
          }
          #umbrel-service-menu input {
            width: 100%;
            padding: 10px;
            border: 1px solid #444;
            border-radius: 6px;
            background: #222;
            color: white;
            font-size: 14px;
            margin-bottom: 12px;
            box-sizing: border-box;
          }
          #umbrel-service-menu input:focus {
            outline: none;
            border-color: #5352ed;
          }
          #umbrel-service-menu .btn-row {
            display: flex;
            gap: 8px;
          }
          #umbrel-service-menu button.action-btn {
            flex: 1;
            padding: 10px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
          }
          #umbrel-service-menu .btn-primary {
            background: #5352ed;
            color: white;
          }
          #umbrel-service-menu .btn-primary:hover {
            background: #3d3cba;
          }
          #umbrel-service-menu .btn-secondary {
            background: #444;
            color: white;
          }
          #umbrel-service-menu .btn-secondary:hover {
            background: #555;
          }
        </style>
        <h2>
          🔧 Сервисное меню
          <button class="close-btn" onclick="window.umbrelKiosk.hideServiceMenu()">×</button>
        </h2>
        <div class="info-row">
          <div class="info-label">Текущий URL:</div>
          <div class="info-value">${currentURL}</div>
        </div>
        <div class="info-row">
          <div class="info-label">Hostname:</div>
          <div class="info-value">${hostname}</div>
        </div>
        <div class="info-row">
          <div class="info-label">IP адреса:</div>
          <div class="info-value">${ipAddresses.join('<br>') || 'Не найдены'}</div>
        </div>
        <div class="info-row">
          <div class="info-label">Новый URL:</div>
          <input type="text" id="umbrel-new-url" placeholder="http://..." value="${currentURL}">
        </div>
        <div class="btn-row">
          <button class="action-btn btn-secondary" onclick="window.umbrelKiosk.reload()">🔄 Перезагрузить</button>
          <button class="action-btn btn-primary" onclick="window.umbrelKiosk.navigate(document.getElementById('umbrel-new-url').value)">➡️ Перейти</button>
        </div>
      \`;
      document.body.appendChild(menu);
    })();
  `).catch(() => {});
}

function hideServiceMenu() {
  serviceMenuVisible = false;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const menu = document.getElementById('umbrel-service-menu');
      if (menu) menu.remove();
    })();
  `).catch(() => {});
}

// ============================================================================
// FLOATING NAVIGATION PANEL
// ============================================================================

let navPanelVisible = true;

function injectNavPanel() {
  const config = appConfig.getAll();
  
  // Get position and size settings
  const pos = config.dockPosition || 'bottom-right';
  const dockSize = config.dockSize || 'medium';
  
  // Size presets
  const sizes = {
    small: { btn: 28, icon: 14, gap: 1, pad: '6px 4px', radius: 8, trigger: 60 },
    medium: { btn: 36, icon: 18, gap: 2, pad: '8px 6px', radius: 10, trigger: 80 },
    large: { btn: 48, icon: 24, gap: 4, pad: '12px 8px', radius: 12, trigger: 100 }
  };
  const size = sizes[dockSize] || sizes.medium;
  
  // Position calculations
  const isRight = pos.includes('right');
  const isTop = pos.includes('top');
  const isCenter = pos.includes('center');
  
  // Build CSS dynamically on main process side
  const positionCSS = `
    ${isRight ? 'right: 0;' : 'left: 0;'}
    ${isTop ? 'top: 24px;' : isCenter ? 'top: 50%; transform: translateY(-50%);' : 'bottom: 24px;'}
  `;
  const alignItems = isTop ? 'flex-start' : isCenter ? 'center' : 'flex-end';
  const flexDir = isRight ? 'row' : 'row-reverse';
  const triggerRadius = isRight ? '3px 0 0 3px' : '0 3px 3px 0';
  const dockRadius = isRight ? '12px 0 0 12px' : '0 12px 12px 0';
  const dockBorder = isRight ? 'border-right: none;' : 'border-left: none;';
  const dockShadow = isRight ? '-2px 0 20px' : '2px 0 20px';
  const dockTransform = isRight ? '100%' : '-100%';
  const btnHoverX = isRight ? '-3px' : '3px';
  
  const cssCode = `
    #umbrel-nav-panel {
      position: fixed;
      ${positionCSS}
      z-index: 999998;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: ${alignItems};
      flex-direction: ${flexDir};
    }
    
    /* Trigger zone */
    #umbrel-nav-panel .dock-trigger {
      width: 6px;
      height: ${size.trigger}px;
      background: linear-gradient(180deg, 
        transparent 0%, 
        rgba(255,255,255,0.15) 30%, 
        rgba(255,255,255,0.15) 70%, 
        transparent 100%
      );
      border-radius: ${triggerRadius};
      cursor: pointer;
      transition: all 0.3s ease;
    }
    
    #umbrel-nav-panel:hover .dock-trigger,
    #umbrel-nav-panel.open .dock-trigger {
      width: 2px;
      opacity: 0.3;
    }
    
    #umbrel-nav-panel .dock-trigger:hover {
      background: linear-gradient(180deg, 
        transparent 0%, 
        rgba(255,255,255,0.3) 30%, 
        rgba(255,255,255,0.3) 70%, 
        transparent 100%
      );
    }
    
    /* Dock container */
    #umbrel-nav-panel .dock {
      display: flex;
      flex-direction: column;
      gap: ${size.gap}px;
      padding: ${size.pad};
      background: rgba(25, 25, 30, 0.8);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-radius: ${dockRadius};
      border: 1px solid rgba(255, 255, 255, 0.08);
      ${dockBorder}
      box-shadow: ${dockShadow} rgba(0, 0, 0, 0.25);
      transform: translateX(${dockTransform}) scale(0.95);
      opacity: 0;
      transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
    }
    
    #umbrel-nav-panel:hover .dock,
    #umbrel-nav-panel.open .dock {
      transform: translateX(0) scale(1);
      opacity: 1;
    }
    
    /* Dock items */
    #umbrel-nav-panel .dock-item {
      position: relative;
      display: flex;
      align-items: center;
    }
    
    #umbrel-nav-panel .dock-btn {
      width: ${size.btn}px;
      height: ${size.btn}px;
      border-radius: ${size.radius}px;
      border: none;
      background: transparent;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    
    #umbrel-nav-panel .dock-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      transform: scale(1.15) translateX(${btnHoverX});
    }
    
    #umbrel-nav-panel .dock-btn:active {
      transform: scale(0.9);
      transition: transform 0.1s ease;
    }
    
    #umbrel-nav-panel .dock-btn svg {
      width: ${size.icon}px;
      height: ${size.icon}px;
      transition: transform 0.2s ease;
    }
    
    #umbrel-nav-panel .dock-btn:hover svg {
      transform: scale(1.05);
    }
    
    /* Settings gear rotation */
    #umbrel-nav-panel .dock-btn.settings-btn svg {
      transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    
    #umbrel-nav-panel .dock-btn.settings-btn:hover svg {
      transform: rotate(90deg);
    }
    
    /* Divider */
    #umbrel-nav-panel .dock-divider {
      width: ${size.btn - 8}px;
      height: 1px;
      background: rgba(255,255,255,0.1);
      margin: ${size.gap + 2}px auto;
    }
    
    /* Settings button */
    #umbrel-nav-panel .dock-btn.settings-btn:hover {
      background: rgba(83, 82, 237, 0.25);
    }
  `;
  
  const escapedCSS = cssCode.replace(/`/g, '\\`');
  
  mainWindow.webContents.executeJavaScript(`
    (function() {
      // Remove existing panel if present
      const existing = document.getElementById('umbrel-nav-panel');
      if (existing) existing.remove();
      const existingStyle = document.getElementById('umbrel-nav-panel-style');
      if (existingStyle) existingStyle.remove();
      
      // Check if umbrelKiosk API is available
      if (!window.umbrelKiosk) {
        console.error('[Umbrel Kiosk] API not available');
        return;
      }
      
      const panel = document.createElement('div');
      panel.id = 'umbrel-nav-panel';
      
      // Create style element
      const style = document.createElement('style');
      style.id = 'umbrel-nav-panel-style';
      style.textContent = \`${escapedCSS}\`;
      document.head.appendChild(style);
      
      // Create dock structure
      panel.innerHTML = \`
        <div class="dock-trigger"></div>
        <div class="dock">
          <button class="dock-btn" id="umbrel-nav-back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <button class="dock-btn" id="umbrel-nav-forward">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
          <div class="dock-divider"></div>
          <button class="dock-btn" id="umbrel-nav-home">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          </button>
          <button class="dock-btn" id="umbrel-nav-reload">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
          <button class="dock-btn" id="umbrel-nav-clearcache" title="Очистить кэш">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
          <div class="dock-divider"></div>
          <button class="dock-btn settings-btn" id="umbrel-nav-settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      \`;
      
      document.body.appendChild(panel);
      
      // Button handlers
      document.getElementById('umbrel-nav-back').addEventListener('click', () => window.umbrelKiosk.goBack());
      document.getElementById('umbrel-nav-forward').addEventListener('click', () => window.umbrelKiosk.goForward());
      document.getElementById('umbrel-nav-home').addEventListener('click', () => window.umbrelKiosk.goHome());
      document.getElementById('umbrel-nav-reload').addEventListener('click', () => window.umbrelKiosk.reload());
      document.getElementById('umbrel-nav-clearcache').addEventListener('click', () => window.umbrelKiosk.clearCache());
      document.getElementById('umbrel-nav-settings').addEventListener('click', () => window.umbrelKiosk.openSettings());
      
      // Touch support
      panel.addEventListener('touchstart', () => panel.classList.add('open'));
      document.addEventListener('touchstart', (e) => {
        if (!panel.contains(e.target)) panel.classList.remove('open');
      });
      
      console.log('[Umbrel Kiosk] Dock panel injected');
    })();
  `).catch((err) => {
    logWarn('Failed to inject nav panel', { error: err.message });
  });
}

function updateNavButtons() {
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const backBtn = document.getElementById('umbrel-nav-back');
      const fwdBtn = document.getElementById('umbrel-nav-forward');
      if (backBtn) backBtn.disabled = !history.length || history.length <= 1;
    })();
  `).catch(() => {});
}

function hideNavPanel() {
  navPanelVisible = false;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const panel = document.getElementById('umbrel-nav-panel');
      if (panel) panel.classList.add('hidden');
    })();
  `).catch(() => {});
}

function showNavPanel() {
  navPanelVisible = true;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const panel = document.getElementById('umbrel-nav-panel');
      if (panel) {
        panel.classList.remove('hidden');
      }
    })();
  `).catch(() => {});
}

// ============================================================================
// SOFTWARE CURSOR (Works even when system cursor is hidden)
// ============================================================================

function injectSoftwareCursor(theme = null, size = null) {
  // Real software cursor - a div that follows the mouse
  // Works even when system hides cursor (unclutter, Cage, etc.)
  
  if (!theme) {
    theme = appConfig.get('cursorTheme') || 'dark';
  }
  
  if (!size) {
    size = appConfig.get('cursorSize') || 'medium';
  }
  
  // Size mapping (in pixels)
  const sizeMap = {
    small: 24,
    medium: 32,
    large: 48,
    xlarge: 64
  };
  const cursorPx = sizeMap[size] || 32;
  
  // If system theme selected, remove software cursor
  if (theme === 'system') {
    logInfo('Using system cursor');
    mainWindow.webContents.executeJavaScript(`
      (function() {
        const cursor = document.getElementById('umbrel-sw-cursor');
        if (cursor) cursor.remove();
        const style = document.getElementById('umbrel-cursor-style');
        if (style) style.remove();
        document.body.style.cursor = '';
        console.log('[Umbrel Kiosk] Switched to system cursor');
      })();
    `).catch(() => {});
    return;
  }
  
  // Load SVG cursors
  const fs = require('fs');
  const cursorsPath = path.join(__dirname, '..', 'assets', 'cursors', theme);
  
  const loadSVG = (name) => {
    try {
      const svg = fs.readFileSync(path.join(cursorsPath, `${name}.svg`), 'utf8');
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    } catch (e) {
      return null;
    }
  };
  
  const defaultCursor = loadSVG('left_ptr');
  const pointerCursor = loadSVG('hand2');
  const textCursor = loadSVG('xterm');
  
  if (!defaultCursor) {
    logWarn('Failed to load cursor SVGs, using system cursor');
    return;
  }
  
  logInfo('Injecting software cursor', { theme, size, cursorPx });
  
  // Inject real software cursor - div that follows mouse
  mainWindow.webContents.executeJavaScript(`
    (function() {
      // Remove existing
      const existing = document.getElementById('umbrel-sw-cursor');
      if (existing) existing.remove();
      const existingStyle = document.getElementById('umbrel-cursor-style');
      if (existingStyle) existingStyle.remove();
      
      // Cursor images
      const cursors = {
        default: '${defaultCursor}',
        pointer: '${pointerCursor}',
        text: '${textCursor}'
      };
      
      // Create cursor element
      const cursor = document.createElement('div');
      cursor.id = 'umbrel-sw-cursor';
      
      // Cursor size
      const cursorSize = ${cursorPx};
      const hotspotDefault = Math.round(cursorSize * 0.125); // ~4px for 32
      const hotspotPointer = Math.round(cursorSize * 0.3125); // ~10px for 32
      const hotspotText = Math.round(cursorSize * 0.5); // center
      
      // Create style
      const style = document.createElement('style');
      style.id = 'umbrel-cursor-style';
      style.textContent = \`
        #umbrel-sw-cursor {
          position: fixed;
          width: \${cursorSize}px;
          height: \${cursorSize}px;
          pointer-events: none;
          z-index: 2147483647;
          background-image: url("\${cursors.default}");
          background-size: contain;
          background-repeat: no-repeat;
          transform: translate(-\${hotspotDefault}px, -\${hotspotDefault}px);
          will-change: left, top;
          display: none;
        }
        #umbrel-sw-cursor.pointer {
          background-image: url("\${cursors.pointer}");
          transform: translate(-\${hotspotPointer}px, -\${hotspotDefault}px);
        }
        #umbrel-sw-cursor.text {
          background-image: url("\${cursors.text}");
          transform: translate(-\${hotspotText}px, -\${hotspotText}px);
        }
        /* Hide system cursor everywhere */
        *, *::before, *::after {
          cursor: none !important;
        }
      \`;
      
      document.head.appendChild(style);
      document.body.appendChild(cursor);
      
      // Track mouse position
      let mouseX = -100, mouseY = -100;
      let cursorVisible = false;
      
      function updateCursor() {
        cursor.style.left = mouseX + 'px';
        cursor.style.top = mouseY + 'px';
      }
      
      // Mouse move handler
      document.addEventListener('mousemove', function(e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
        if (!cursorVisible) {
          cursor.style.display = 'block';
          cursorVisible = true;
        }
        updateCursor();
      }, { passive: true, capture: true });
      
      // Touch - hide cursor
      document.addEventListener('touchstart', function() {
        cursor.style.display = 'none';
        cursorVisible = false;
      }, { passive: true });
      
      // Detect cursor type based on element under cursor
      let currentType = 'default';
      
      document.addEventListener('mouseover', function(e) {
        const el = e.target;
        let type = 'default';
        
        // Check if clickable
        if (el.matches && (
          el.matches('a, button, [role="button"], [onclick], input[type="submit"], input[type="button"], input[type="checkbox"], input[type="radio"], select, label, summary') ||
          el.closest('a, button, [role="button"]') ||
          (el.style && el.style.cursor === 'pointer') ||
          (window.getComputedStyle && window.getComputedStyle(el).cursor === 'pointer')
        )) {
          type = 'pointer';
        }
        // Check if text input
        else if (el.matches && (
          el.matches('input[type="text"], input[type="password"], input[type="email"], input[type="search"], input[type="url"], input[type="tel"], input[type="number"], textarea, [contenteditable="true"]') ||
          (window.getComputedStyle && window.getComputedStyle(el).cursor === 'text')
        )) {
          type = 'text';
        }
        
        if (type !== currentType) {
          cursor.className = type === 'default' ? '' : type;
          currentType = type;
        }
      }, { passive: true, capture: true });
      
      // Mouse leave - hide
      document.addEventListener('mouseleave', function() {
        cursor.style.display = 'none';
        cursorVisible = false;
      });
      
      // Mouse enter - show
      document.addEventListener('mouseenter', function() {
        cursor.style.display = 'block';
        cursorVisible = true;
      });
      
      console.log('[Umbrel Kiosk] Software cursor active (${theme})');
    })();
  `).catch((err) => {
    logWarn('Failed to inject software cursor', { error: err.message });
  });
}

// ============================================================================
// SETTINGS PANEL
// ============================================================================

function injectSettingsPanel() {
  const config = appConfig.getAll();
  const configJSON = JSON.stringify(config);
  
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const config = ${configJSON};
      
      // Remove existing panel
      const existing = document.getElementById('umbrel-settings-panel');
      if (existing) existing.remove();
      
      const overlay = document.createElement('div');
      overlay.id = 'umbrel-settings-panel';
      
      const style = document.createElement('style');
      style.textContent = \`
        #umbrel-settings-panel {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.8);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        #umbrel-settings-panel .panel {
          background: #1a1a2e;
          border-radius: 16px;
          padding: 32px;
          width: 90%;
          max-width: 480px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        #umbrel-settings-panel h2 {
          margin: 0 0 24px 0;
          color: #fff;
          font-size: 24px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 12px;
        }
        #umbrel-settings-panel .setting-group {
          margin-bottom: 20px;
        }
        #umbrel-settings-panel .setting-label {
          color: #888;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 8px;
        }
        #umbrel-settings-panel .setting-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 8px;
          margin-bottom: 8px;
        }
        #umbrel-settings-panel .setting-row:last-child {
          margin-bottom: 0;
        }
        #umbrel-settings-panel .setting-name {
          color: #fff;
          font-size: 14px;
        }
        #umbrel-settings-panel .setting-desc {
          color: #666;
          font-size: 12px;
          margin-top: 4px;
        }
        #umbrel-settings-panel .cursor-options {
          display: flex;
          gap: 12px;
        }
        #umbrel-settings-panel .cursor-btn {
          width: 64px;
          height: 64px;
          border: 2px solid rgba(255, 255, 255, 0.2);
          border-radius: 12px;
          background: #2a2a3e;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
          transition: all 0.2s;
        }
        #umbrel-settings-panel .cursor-btn:hover {
          border-color: rgba(255, 255, 255, 0.4);
        }
        #umbrel-settings-panel .cursor-btn.active {
          border-color: #5352ed;
          background: rgba(83, 82, 237, 0.2);
        }
        #umbrel-settings-panel .cursor-btn .icon {
          font-size: 24px;
        }
        #umbrel-settings-panel .cursor-btn .label {
          font-size: 10px;
          color: #888;
        }
        #umbrel-settings-panel .toggle {
          width: 48px;
          height: 28px;
          background: #444;
          border-radius: 14px;
          position: relative;
          cursor: pointer;
          transition: background 0.2s;
        }
        #umbrel-settings-panel .toggle.active {
          background: #5352ed;
        }
        #umbrel-settings-panel .toggle::after {
          content: '';
          position: absolute;
          width: 22px;
          height: 22px;
          background: #fff;
          border-radius: 50%;
          top: 3px;
          left: 3px;
          transition: transform 0.2s;
        }
        #umbrel-settings-panel .toggle.active::after {
          transform: translateX(20px);
        }
        #umbrel-settings-panel .select-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        #umbrel-settings-panel .select-btn {
          padding: 8px 14px;
          border: 2px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.05);
          color: #aaa;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }
        #umbrel-settings-panel .select-btn:hover {
          border-color: rgba(255, 255, 255, 0.3);
          color: #fff;
        }
        #umbrel-settings-panel .select-btn.active {
          border-color: #5352ed;
          background: rgba(83, 82, 237, 0.2);
          color: #fff;
        }
        #umbrel-settings-panel .buttons {
          display: flex;
          gap: 12px;
          margin-top: 24px;
        }
        #umbrel-settings-panel .btn {
          flex: 1;
          padding: 14px 24px;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        #umbrel-settings-panel .btn-primary {
          background: #5352ed;
          color: #fff;
        }
        #umbrel-settings-panel .btn-primary:hover {
          background: #4342d4;
        }
        #umbrel-settings-panel .btn-secondary {
          background: rgba(255, 255, 255, 0.1);
          color: #fff;
        }
        #umbrel-settings-panel .btn-secondary:hover {
          background: rgba(255, 255, 255, 0.15);
        }
      \`;
      
      overlay.innerHTML = \`
        <div class="panel">
          <h2>⚙️ Настройки</h2>
          
          <div class="setting-group">
            <div class="setting-label">Курсор</div>
            <div class="setting-row">
              <div style="width:100%">
                <div class="setting-name">Тема</div>
                <div class="cursor-options" style="margin-top:8px">
                  <button class="cursor-btn \${config.cursorTheme === 'dark' ? 'active' : ''}" data-theme="dark">
                    <span class="icon"><svg width="24" height="24" viewBox="0 0 257 257" fill="none"><path d="M74.3188 38.6418L74.1536 179.927C74.1519 181.331 75.2644 182.481 76.6672 182.541C84.4433 182.872 108.472 184.577 123.598 193.178C134.387 199.313 135.353 206.18 146.709 201.171C158.065 196.161 153.06 191.076 155.804 178.972C159.647 162.019 174.161 143.323 179.036 137.397C179.923 136.32 179.818 134.736 178.786 133.796L74.3188 38.6418Z" fill="#1a1a1a" stroke="#fff" stroke-width="8"/></svg></span>
                    <span class="label">Тёмный</span>
                  </button>
                  <button class="cursor-btn \${config.cursorTheme === 'light' ? 'active' : ''}" data-theme="light">
                    <span class="icon"><svg width="24" height="24" viewBox="0 0 257 257" fill="none"><path d="M74.3188 38.6418L74.1536 179.927C74.1519 181.331 75.2644 182.481 76.6672 182.541C84.4433 182.872 108.472 184.577 123.598 193.178C134.387 199.313 135.353 206.18 146.709 201.171C158.065 196.161 153.06 191.076 155.804 178.972C159.647 162.019 174.161 143.323 179.036 137.397C179.923 136.32 179.818 134.736 178.786 133.796L74.3188 38.6418Z" fill="#fff" stroke="#1a1a1a" stroke-width="8"/></svg></span>
                    <span class="label">Светлый</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="setting-row">
              <div style="width:100%">
                <div class="setting-name">Размер</div>
                <div class="select-row" style="margin-top:8px" data-setting="cursorSize">
                  <button class="select-btn \${config.cursorSize === 'small' ? 'active' : ''}" data-value="small">S</button>
                  <button class="select-btn \${config.cursorSize === 'medium' ? 'active' : ''}" data-value="medium">M</button>
                  <button class="select-btn \${config.cursorSize === 'large' ? 'active' : ''}" data-value="large">L</button>
                  <button class="select-btn \${config.cursorSize === 'xlarge' ? 'active' : ''}" data-value="xlarge">XL</button>
                </div>
              </div>
            </div>
          </div>
          
          <div class="setting-group">
            <div class="setting-label">Док-панель</div>
            <div class="setting-row">
              <div style="width:100%">
                <div class="setting-name">Позиция</div>
                <div class="select-row" style="margin-top:8px" data-setting="dockPosition">
                  <button class="select-btn \${config.dockPosition === 'top-left' ? 'active' : ''}" data-value="top-left">↖ Верх-лево</button>
                  <button class="select-btn \${config.dockPosition === 'top-right' ? 'active' : ''}" data-value="top-right">↗ Верх-право</button>
                  <button class="select-btn \${config.dockPosition === 'center-left' ? 'active' : ''}" data-value="center-left">← Центр-лево</button>
                  <button class="select-btn \${config.dockPosition === 'center-right' ? 'active' : ''}" data-value="center-right">→ Центр-право</button>
                  <button class="select-btn \${config.dockPosition === 'bottom-left' ? 'active' : ''}" data-value="bottom-left">↙ Низ-лево</button>
                  <button class="select-btn \${config.dockPosition === 'bottom-right' ? 'active' : ''}" data-value="bottom-right">↘ Низ-право</button>
                </div>
              </div>
            </div>
            <div class="setting-row">
              <div style="width:100%">
                <div class="setting-name">Размер</div>
                <div class="select-row" style="margin-top:8px" data-setting="dockSize">
                  <button class="select-btn \${config.dockSize === 'small' ? 'active' : ''}" data-value="small">Маленький</button>
                  <button class="select-btn \${config.dockSize === 'medium' ? 'active' : ''}" data-value="medium">Средний</button>
                  <button class="select-btn \${config.dockSize === 'large' ? 'active' : ''}" data-value="large">Большой</button>
                </div>
              </div>
            </div>
          </div>
          
          <div class="setting-group about">
            <div style="display:flex;align-items:center;justify-content:center;gap:12px;color:#666;font-size:11px">
              <span>Umbrel Kiosk</span>
              <span>•</span>
              <a href="#" id="about-github" style="color:#5352ed;text-decoration:none">GitHub</a>
              <span>•</span>
              <span>MIT License</span>
            </div>
          </div>
          
          <div class="buttons">
            <button class="btn btn-secondary" id="settings-close">Закрыть</button>
            <button class="btn btn-primary" id="settings-save">Готово</button>
          </div>
        </div>
      \`;
      
      document.head.appendChild(style);
      document.body.appendChild(overlay);
      
      // Event handlers
      const cursorBtns = overlay.querySelectorAll('.cursor-btn');
      cursorBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          cursorBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const theme = btn.dataset.theme;
          window.umbrelKiosk.setConfig('cursorTheme', theme);
        });
      });
      
      const toggles = overlay.querySelectorAll('.toggle');
      toggles.forEach(toggle => {
        toggle.addEventListener('click', () => {
          toggle.classList.toggle('active');
          const setting = toggle.dataset.setting;
          const value = toggle.classList.contains('active');
          window.umbrelKiosk.setConfig(setting, value);
        });
      });
      
      // Select button groups
      const selectRows = overlay.querySelectorAll('.select-row[data-setting]');
      selectRows.forEach(row => {
        const btns = row.querySelectorAll('.select-btn');
        btns.forEach(btn => {
          btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const setting = row.dataset.setting;
            const value = btn.dataset.value;
            window.umbrelKiosk.setConfig(setting, value);
          });
        });
      });
      
      document.getElementById('settings-close').addEventListener('click', () => {
        window.umbrelKiosk.closeSettings();
      });
      
      document.getElementById('settings-save').addEventListener('click', () => {
        window.umbrelKiosk.closeSettings();
      });
      
      document.getElementById('about-github').addEventListener('click', (e) => {
        e.preventDefault();
        window.open('https://github.com/Cheviiot/Umbrel-Kiosk', '_blank');
      });
      
      // Close on background click
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          window.umbrelKiosk.closeSettings();
        }
      });
      
      console.log('[Umbrel Kiosk] Settings panel opened');
    })();
  `).catch((err) => {
    logWarn('Failed to inject settings panel', { error: err.message });
  });
}

function closeSettingsPanel() {
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const panel = document.getElementById('umbrel-settings-panel');
      if (panel) panel.remove();
    })();
  `).catch(() => {});
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

ipcMain.on('kiosk:retry', () => {
  logInfo('Retry requested from overlay');
  hideOverlay();
  reloadPage();
});

ipcMain.on('kiosk:reload', () => {
  logInfo('Reload requested');
  hideServiceMenu();
  reloadPage();
});

ipcMain.on('kiosk:navigate', (event, url) => {
  logInfo('Navigate requested from service menu', { url });
  hideServiceMenu();
  targetURL = url;  // Update target URL for reloads
  currentURL = url;
  mainWindow.loadURL(url);
});

ipcMain.on('kiosk:hideServiceMenu', () => {
  hideServiceMenu();
});

// Navigation controls
ipcMain.on('kiosk:goBack', () => {
  logInfo('Go back requested');
  const nav = mainWindow.webContents.navigationHistory;
  // Check if we can go back and won't go to a file:// URL
  if (nav.canGoBack()) {
    const backIndex = nav.getActiveIndex() - 1;
    if (backIndex >= 0) {
      const entry = nav.getEntryAtIndex(backIndex);
      // Don't go back to file:// URLs (loading screen, error pages)
      if (entry && entry.url && !entry.url.startsWith('file://')) {
        nav.goBack();
      } else {
        logInfo('Blocked going back to local file');
      }
    }
  }
});

ipcMain.on('kiosk:goForward', () => {
  logInfo('Go forward requested');
  const nav = mainWindow.webContents.navigationHistory;
  if (nav.canGoForward()) {
    nav.goForward();
  }
});

ipcMain.on('kiosk:goHome', () => {
  logInfo('Go home requested', { url: targetURL });
  mainWindow.loadURL(targetURL);
});

ipcMain.on('kiosk:toggleNavPanel', () => {
  if (navPanelVisible) {
    hideNavPanel();
  } else {
    showNavPanel();
  }
});

// Settings IPC handlers
ipcMain.on('kiosk:openSettings', () => {
  logInfo('Opening settings panel');
  injectSettingsPanel();
});

ipcMain.on('kiosk:closeSettings', () => {
  logInfo('Closing settings panel');
  closeSettingsPanel();
});

ipcMain.on('kiosk:getConfig', (event) => {
  event.returnValue = appConfig.getAll();
});

ipcMain.on('kiosk:setConfig', (event, key, value) => {
  logInfo('Setting config', { key, value });
  appConfig.set(key, value);
  
  // Apply changes immediately
  if (key === 'cursorTheme' || key === 'cursorSize') {
    injectSoftwareCursor();
  } else if (key === 'dockPosition' || key === 'dockSize') {
    // Re-inject panel with new settings
    injectNavPanel();
  }
  
  event.returnValue = true;
});

ipcMain.on('kiosk:resetConfig', (event) => {
  logInfo('Resetting config to defaults');
  appConfig.reset();
  injectSoftwareCursor();
  event.returnValue = true;
});

ipcMain.on('kiosk:clearCache', async () => {
  logInfo('Clearing browser cache...');
  try {
    const ses = session.defaultSession;
    
    // Clear HTTP cache only (keeps cookies/login)
    await ses.clearCache();
    
    logInfo('Cache cleared successfully');
    
    // Show notification
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.executeJavaScript(`
        (function() {
          const existing = document.getElementById('umbrel-toast');
          if (existing) existing.remove();
          const toast = document.createElement('div');
          toast.id = 'umbrel-toast';
          toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#4CAF50;color:white;padding:12px 24px;border-radius:8px;z-index:999999;font-family:sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
          toast.textContent = '✓ Кэш очищен. Перезагрузка...';
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 2000);
        })();
      `).catch(() => {});
    }
    
    // Reload after short delay
    setTimeout(() => {
      reloadPage();
    }, 1000);
    
  } catch (err) {
    logError('Failed to clear cache', { error: err.message });
  }
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================

function registerShortcuts() {
  // Block dangerous shortcuts in kiosk mode
  if (!cliConfig.devMode) {
    // Alt+F4 - prevent close
    globalShortcut.register('Alt+F4', () => {
      logWarn('Alt+F4 blocked');
    });

    // Ctrl+W - prevent close tab
    globalShortcut.register('CommandOrControl+W', () => {
      logWarn('Ctrl+W blocked');
    });

    // Ctrl+Shift+I - prevent DevTools
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      logWarn('DevTools shortcut blocked');
    });

    // F11 - prevent fullscreen toggle
    globalShortcut.register('F11', () => {
      logWarn('F11 blocked');
    });

    // Ctrl+R - prevent refresh (optional, but good to control)
    globalShortcut.register('CommandOrControl+R', () => {
      logInfo('Ctrl+R - reloading page');
      reloadPage();
    });

    // Escape - prevent exit fullscreen
    globalShortcut.register('Escape', () => {
      logWarn('Escape blocked');
    });
  }

  // Service menu shortcut (always available)
  globalShortcut.register('CommandOrControl+Alt+U', () => {
    logInfo('Service menu toggled');
    toggleServiceMenu();
  });
}

// ============================================================================
// APP LIFECYCLE
// ============================================================================

// Disable hardware acceleration for stability on some systems
// app.disableHardwareAcceleration();

// Handle GPU process crashes
app.on('gpu-process-crashed', (event, killed) => {
  logError('GPU process crashed', { killed });
});

// Handle renderer process creation
app.on('render-process-gone', (event, webContents, details) => {
  logError('Render process gone', details);
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  logWarn('Another instance is already running');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  logInfo('Application starting', {
    url: cliConfig.url,
    insecure: cliConfig.insecure,
    devMode: cliConfig.devMode,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  });

  createWindow();
  registerShortcuts();
});

app.on('window-all-closed', () => {
  logInfo('All windows closed');
  app.quit();
});

app.on('before-quit', () => {
  logInfo('Application quitting');
  globalShortcut.unregisterAll();
  stopNetworkCheck();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logError('Uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection', { reason: String(reason) });
});
