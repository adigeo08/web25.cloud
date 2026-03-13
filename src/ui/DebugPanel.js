// @ts-check

import { CURRENT_LOG_LEVEL, LOG_LEVELS } from '../config/peerweb.config.js';

export function toggleDebug() {
    this.debug = !this.debug;
    this.updateDebugToggle();

    if (this.debug) {
        this.showDebugPanel();
    } else {
        this.hideDebugPanel();
    }
}

export function updateDebugToggle() {
    const button = document.getElementById('debug-toggle');
    if (button) {
        button.textContent = this.debug ? '🐛 Disable Debug Mode' : '🐛 Enable Debug Mode';
    }
}

export function showDebugPanel() {
    const panel = document.getElementById('debug-panel');
    if (panel) {
        panel.classList.remove('hidden');
    }
}

export function hideDebugPanel() {
    const panel = document.getElementById('debug-panel');
    if (panel) {
        panel.classList.add('hidden');
    }
}

export function log(message, level = LOG_LEVELS.DEBUG) {
    if (level < CURRENT_LOG_LEVEL) {
        return; // Skip logs below current level
    }

    const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    const levelName = levelNames[level] || 'DEBUG';
    const prefix = `[PeerWeb:${levelName}]`;

    // Console output based on level
    switch (level) {
        case LOG_LEVELS.ERROR:
            console.error(prefix, message);
            break;
        case LOG_LEVELS.WARN:
            console.warn(prefix, message);
            break;
        case LOG_LEVELS.INFO:
            console.info(prefix, message);
            break;
        default:
            console.log(prefix, message);
    }

    // Debug panel output
    if (this.debug) {
        const debugContent = document.getElementById('debug-content');
        if (debugContent) {
            const timestamp = new Date().toLocaleTimeString();
            const colorClass = level >= LOG_LEVELS.ERROR ? 'error' : level >= LOG_LEVELS.WARN ? 'warn' : '';
            debugContent.innerHTML += `<div class="${colorClass}">[${timestamp}] [${levelName}] ${message}</div>`;
            debugContent.scrollTop = debugContent.scrollHeight;
        }
    }
}

export function showError(message) {
    console.error('[PeerWeb Error]', message);
    alert('PeerWeb Error: ' + message);
}