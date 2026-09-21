const { contextBridge, ipcRenderer, shell } = require('electron');

// Whitelist of allowed IPC channels
const INVOKE_CHANNELS = [
    'load-app-state', 'set-general-config', 'get-general-config',
    'get-app-version', 'get-machine-id',
    'dialog:openDirectory',
    'run-script', 'run-archived-script', 'stop-script',
    'pje:start-session', 'pje:cancel-session', 'pje:navigate-to-extraction',
    'pje:import-session', 'pje:has-session', 'pje:get-session', 'pje:save-session',
    'pje:extract', 'pje:generate-word',
    'pje:run-extraction', 'pje:stop-extraction',
    'sharepoint:start-session', 'sharepoint:cancel-session', 'sharepoint:create-session',
    'history:get-records', 'history:get-record', 'history:delete-record',
    'history:clear', 'history:get-stats', 'history:start', 'history:finish', 'history:add-log',
    'queue:add-job', 'queue:remove-job', 'queue:get-jobs',
    'queue:clear-completed', 'queue:get-stats',
    'protocolos:get-status', 'protocolos:open',
    'proto:config', 'proto:save-config', 'proto:pick-folder',
    'proto:pick-files', 'proto:save-file',
    'proto:process-files', 'proto:consultar-npus', 'proto:export-file', 'proto:cancel'
];

const SEND_CHANNELS = [
    'save-app-state', 'run-script', 'stop-script', 'run-archived-script',
    'sharepoint:login-action', 'automation-status', 'user-confirm-input',
    'pje-input-response'
];

const ON_CHANNELS = [
    'log-message', 'script-finished', 'automation-status',
    'updater:status', 'request-pje-input',
    'sharepoint:waiting-for-login', 'sharepoint:login-completed', 'sharepoint:prompt-create',
    'proto:log', 'proto:progress', 'proto:done'
];

contextBridge.exposeInMainWorld('api', {
    invoke: (channel, ...args) => {
        if (INVOKE_CHANNELS.includes(channel)) {
            return ipcRenderer.invoke(channel, ...args);
        }
        console.warn(`[preload] invoke blocked: ${channel}`);
        return Promise.reject(new Error(`Channel not allowed: ${channel}`));
    },

    send: (channel, ...args) => {
        if (SEND_CHANNELS.includes(channel)) {
            ipcRenderer.send(channel, ...args);
        } else {
            console.warn(`[preload] send blocked: ${channel}`);
        }
    },

    on: (channel, callback) => {
        if (ON_CHANNELS.includes(channel)) {
            ipcRenderer.on(channel, (_event, ...args) => callback(...args));
        }
    },

    removeListener: (channel, callback) => {
        if (ON_CHANNELS.includes(channel)) {
            ipcRenderer.removeListener(channel, callback);
        }
    },

    openExternal: (url) => {
        if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:'))) {
            shell.openExternal(url);
        }
    }
});

console.log('Preload bridge carregado. API segura exposta em window.api');
