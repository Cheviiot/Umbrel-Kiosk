/**
 * Umbrel Kiosk MiniBrowser - Preload Script
 * Minimal preload for IPC communication with main process
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API to the renderer
contextBridge.exposeInMainWorld('umbrelKiosk', {
  // Retry loading after network error
  retry: () => {
    ipcRenderer.send('kiosk:retry');
  },
  
  // Reload current page
  reload: () => {
    ipcRenderer.send('kiosk:reload');
  },
  
  // Navigate to new URL
  navigate: (url) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      ipcRenderer.send('kiosk:navigate', url);
    }
  },
  
  // Hide service menu
  hideServiceMenu: () => {
    ipcRenderer.send('kiosk:hideServiceMenu');
  },
  
  // Navigation controls
  goBack: () => {
    ipcRenderer.send('kiosk:goBack');
  },
  
  goForward: () => {
    ipcRenderer.send('kiosk:goForward');
  },
  
  goHome: () => {
    ipcRenderer.send('kiosk:goHome');
  },
  
  // Toggle nav panel visibility
  toggleNavPanel: () => {
    ipcRenderer.send('kiosk:toggleNavPanel');
  },
  
  // Settings
  openSettings: () => {
    ipcRenderer.send('kiosk:openSettings');
  },
  
  closeSettings: () => {
    ipcRenderer.send('kiosk:closeSettings');
  },
  
  getConfig: () => {
    return ipcRenderer.sendSync('kiosk:getConfig');
  },
  
  setConfig: (key, value) => {
    return ipcRenderer.sendSync('kiosk:setConfig', key, value);
  },
  
  resetConfig: () => {
    return ipcRenderer.sendSync('kiosk:resetConfig');
  },

  // Clear browser cache and reload
  clearCache: () => {
    ipcRenderer.send('kiosk:clearCache');
  }
});

// Log that preload script has loaded
console.log('[Umbrel Kiosk] Preload script loaded');
