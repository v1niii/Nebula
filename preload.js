const { contextBridge, ipcRenderer } = require('electron');

const listeners = { 'update-launch-status': null, 'apply-theme': null, 'confirm-close': null };

contextBridge.exposeInMainWorld('electronAPI', {
    getAccounts: () => ipcRenderer.invoke('get-accounts'),
    loginWithRiot: () => ipcRenderer.invoke('login-with-riot'),
    importCurrentAccount: () => ipcRenderer.invoke('import-current-account'),
    removeAccount: (id) => ipcRenderer.invoke('remove-account', id),
    launchValorant: (id) => ipcRenderer.invoke('launch-valorant', id),
    copySettings: (fromId, toId) => ipcRenderer.invoke('copy-settings', fromId, toId),
    copyCloudSettings: (fromId, toId) => ipcRenderer.invoke('copy-cloud-settings', fromId, toId),
    setNickname: (id, name) => ipcRenderer.invoke('set-nickname', id, name),
    reorderAccounts: (ids) => ipcRenderer.invoke('reorder-accounts', ids),
    checkSession: (id) => ipcRenderer.invoke('check-session', id),

    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
    minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
    quitApp: () => ipcRenderer.invoke('quit-app'),
    onConfirmClose: (cb) => {
        if (listeners['confirm-close']) ipcRenderer.removeListener('confirm-close', listeners['confirm-close']);
        const wrapped = () => cb();
        listeners['confirm-close'] = wrapped;
        ipcRenderer.on('confirm-close', wrapped);
    },
    openExternalLink: (url) => ipcRenderer.invoke('open-external-link', url),

    onUpdateLaunchStatus: (cb) => {
        if (listeners['update-launch-status']) ipcRenderer.removeListener('update-launch-status', listeners['update-launch-status']);
        const wrapped = (_e, ...args) => cb(...args);
        listeners['update-launch-status'] = wrapped;
        ipcRenderer.on('update-launch-status', wrapped);
    },
    onApplyTheme: (cb) => {
        if (listeners['apply-theme']) ipcRenderer.removeListener('apply-theme', listeners['apply-theme']);
        const wrapped = (_e, theme) => cb(theme);
        listeners['apply-theme'] = wrapped;
        ipcRenderer.on('apply-theme', wrapped);
    },
    removeUpdateLaunchStatusListener: () => {
        if (listeners['update-launch-status']) { ipcRenderer.removeListener('update-launch-status', listeners['update-launch-status']); listeners['update-launch-status'] = null; }
    },
    removeApplyThemeListener: () => {
        if (listeners['apply-theme']) { ipcRenderer.removeListener('apply-theme', listeners['apply-theme']); listeners['apply-theme'] = null; }
    },
});
