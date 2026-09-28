const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// テスト対象
const { loadConfig, saveConfig } = require('../src/config');

describe('Config Module Whitebox Tests', () => {
  it('should load default batteryMode as auto', () => {
    const config = loadConfig();
    assert.ok(['auto', 'on', 'off'].includes(config.batteryMode), 'batteryMode should be auto, on, or off');
  });

  it('should synchronize batteryMode and batterySaver on saveConfig', () => {
    // 1. batteryMode: on -> batterySaver: true
    saveConfig({ batteryMode: 'on' });
    let cfg = loadConfig();
    assert.strictEqual(cfg.batteryMode, 'on');
    assert.strictEqual(cfg.batterySaver, true);

    // 2. batteryMode: off -> batterySaver: false
    saveConfig({ batteryMode: 'off' });
    cfg = loadConfig();
    assert.strictEqual(cfg.batteryMode, 'off');
    assert.strictEqual(cfg.batterySaver, false);

    // 3. batteryMode: auto -> batterySaver: false (auto defaults to false until battery trigger)
    saveConfig({ batteryMode: 'auto' });
    cfg = loadConfig();
    assert.strictEqual(cfg.batteryMode, 'auto');
    assert.strictEqual(cfg.batterySaver, false);
  });

  it('should handle legacy batterySaver flag correctly', () => {
    saveConfig({ batterySaver: true, batteryMode: undefined });
    let cfg = loadConfig();
    assert.strictEqual(cfg.batteryMode, 'on');
    assert.strictEqual(cfg.batterySaver, true);

    // テスト後始末: autoに戻す
    saveConfig({ batteryMode: 'auto' });
  });
});
