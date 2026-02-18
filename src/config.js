/**
 * Umbrel Kiosk - Configuration Manager
 * Handles persistent settings storage
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Default configuration
const DEFAULT_CONFIG = {
  // Appearance
  cursorTheme: 'dark',      // 'dark' | 'light' | 'system'
  cursorSize: 'medium',     // 'small' | 'medium' | 'large' | 'xlarge'
  
  // Dock Panel
  dockPosition: 'bottom-right', // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center-right' | 'center-left'
  dockSize: 'medium',       // 'small' | 'medium' | 'large'
  
  // Behavior
  homeUrl: 'http://umbrel.local'
};

class ConfigManager {
  constructor() {
    this.configPath = this._getConfigPath();
    this.config = { ...DEFAULT_CONFIG };
    this.load();
  }
  
  _getConfigPath() {
    // Try /opt/umbrel-kiosk first (system install), then user data
    const systemPath = '/opt/umbrel-kiosk/config.json';
    const userPath = path.join(app.getPath('userData'), 'config.json');
    
    // Prefer system path if writable
    try {
      const dir = path.dirname(systemPath);
      if (fs.existsSync(dir)) {
        fs.accessSync(dir, fs.constants.W_OK);
        return systemPath;
      }
    } catch (e) {
      // System path not writable, use user path
    }
    
    return userPath;
  }
  
  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const loaded = JSON.parse(data);
        this.config = { ...DEFAULT_CONFIG, ...loaded };
        console.log('[Config] Loaded from', this.configPath);
      } else {
        console.log('[Config] Using defaults');
      }
    } catch (err) {
      console.error('[Config] Failed to load:', err.message);
      this.config = { ...DEFAULT_CONFIG };
    }
    return this.config;
  }
  
  save() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      console.log('[Config] Saved to', this.configPath);
      return true;
    } catch (err) {
      console.error('[Config] Failed to save:', err.message);
      return false;
    }
  }
  
  get(key) {
    return key ? this.config[key] : this.config;
  }
  
  set(key, value) {
    if (typeof key === 'object') {
      // Bulk update
      this.config = { ...this.config, ...key };
    } else {
      this.config[key] = value;
    }
    return this.save();
  }
  
  reset() {
    this.config = { ...DEFAULT_CONFIG };
    return this.save();
  }
  
  getAll() {
    return { ...this.config };
  }
}

// Singleton instance
let instance = null;

function getConfig() {
  if (!instance) {
    instance = new ConfigManager();
  }
  return instance;
}

module.exports = { getConfig, DEFAULT_CONFIG };
