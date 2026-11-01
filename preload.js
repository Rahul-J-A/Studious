const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

    // ── Gallery ──────────────────────────────────────────────────
    getVideos: () => ipcRenderer.invoke('get-videos'),
    getVideoPath: (file) => ipcRenderer.invoke('get-video-path', file),
    getThumbnailPath: (file) => ipcRenderer.invoke('get-thumbnail-path', file),
    getPreviewPath: (id) => ipcRenderer.invoke('get-preview-path', id),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    downloadVideo: (url, playlistId) => ipcRenderer.invoke('download-video', url, playlistId),
    getMusicList: () => ipcRenderer.invoke('get-music-list'),
    getMusicUrl: (id) => ipcRenderer.invoke('get-music-url', id),
    renameMusic: (id, newTitle) => ipcRenderer.invoke('rename-music', id, newTitle),
    deleteMusic: (id) => ipcRenderer.invoke('delete-music', id),

    // ── Playlist Management ─────────────────────────────────────
    playlistList: () => ipcRenderer.invoke('playlist-list'),
    playlistGet: (id) => ipcRenderer.invoke('playlist-get', id),
    playlistCreate: (name) => ipcRenderer.invoke('playlist-create', name),
    playlistRename: (id, newName) => ipcRenderer.invoke('playlist-rename', id, newName),
    playlistDelete: (id, deleteVideos) => ipcRenderer.invoke('playlist-delete', id, deleteVideos),
    playlistAddVideo: (plId, vaultId, position) => ipcRenderer.invoke('playlist-add-video', plId, vaultId, position),
    playlistRemoveVideo: (plId, vaultId) => ipcRenderer.invoke('playlist-remove-video', plId, vaultId),
    playlistReorder: (plId, vaultIds) => ipcRenderer.invoke('playlist-reorder', plId, vaultIds),
    playlistMigrate: (oldData) => ipcRenderer.invoke('playlist-migrate', oldData),
    playlistSetThumbnail: (plId, vaultId) => ipcRenderer.invoke('playlist-set-thumbnail', plId, vaultId),
    playlistExport: () => ipcRenderer.invoke('playlist-export'),
    playlistImport: () => ipcRenderer.invoke('playlist-import'),
    // ── Playlist Downloads ──────────────────────────────────────
    downloadToPlaylist: (url, playlistId) => ipcRenderer.invoke('download-to-playlist', url, playlistId),
    downloadPlaylist: (url) => ipcRenderer.invoke('download-playlist', url),
    checkDownloadType: (url) => ipcRenderer.invoke('check-download-type', url),
    onPlaylistDlProgress: (cb) => ipcRenderer.on('playlist-dl-progress', (e, d) => cb(d)),
    onPlaylistVideoComplete: (cb) => ipcRenderer.on('playlist-video-complete', (e, d) => cb(d)),

    // ── Vault ────────────────────────────────────────────────────
    vaultScan: () => ipcRenderer.invoke('vault-scan'),
    vaultGetUrl: (vaultId, type) => ipcRenderer.invoke('vault-get-url', vaultId, type),
    vaultDelete: (vaultId) => ipcRenderer.invoke('vault-delete', vaultId),
    vaultRename: (vaultId, newTitle) => ipcRenderer.invoke('vault-rename', vaultId, newTitle),
    vaultStatus: () => ipcRenderer.invoke('vault-status'),
    vaultBatchDelete: (ids) => ipcRenderer.invoke('vault-batch-delete', ids),
    vaultRegenAssets: (vaultId) => ipcRenderer.invoke('vault-regen-assets', vaultId),
    vaultFindDuplicates: () => ipcRenderer.invoke('vault-find-duplicates'),

    // ── Encode / Compression ─────────────────────────────────────
    encodeSkip: (vaultId) => ipcRenderer.invoke('encode-skip', vaultId),
    encodeQueueStatus: () => ipcRenderer.invoke('encode-queue-status'),
    encodeLogGet: () => ipcRenderer.invoke('encode-log-get'),
    encodeLogClear: () => ipcRenderer.invoke('encode-log-clear'),
    onEncodeProgress: (cb) => ipcRenderer.on('encode-progress', (e, data) => cb(data)),

    // ── Watch History ─────────────────────────────────────────────
    watchHistoryGet: () => ipcRenderer.invoke('watch-history-get'),
    watchHistorySet: (vaultId, timestamp, dur) => ipcRenderer.invoke('watch-history-set', vaultId, timestamp, dur),
    watchHistoryClear: (vaultId) => ipcRenderer.invoke('watch-history-clear', vaultId),

    // ── Video Notes ───────────────────────────────────────────────
    notesGet: (vaultId) => ipcRenderer.invoke('notes-get', vaultId),
    notesSet: (vaultId, text) => ipcRenderer.invoke('notes-set', vaultId, text),
    notesGetAll: () => ipcRenderer.invoke('notes-get-all'),

    // ── Storage Analytics ─────────────────────────────────────────
    storageAnalytics: () => ipcRenderer.invoke('storage-analytics'),

    // ── Backup ───────────────────────────────────────────────────
    backupList: () => ipcRenderer.invoke('backup-list'),
    backupRestore: (name) => ipcRenderer.invoke('backup-restore', name),

    // ── Password ─────────────────────────────────────────────────
    changePassword: (user, oldP, newP) => ipcRenderer.invoke('change-password', user, oldP, newP),

    // ── Playback signals (pauses encode/assets during watching) ──
    playbackStarted: () => ipcRenderer.send('playback-started'),
    playbackStopped: () => ipcRenderer.send('playback-stopped'),

    // ── IP Check ─────────────────────────────────────────────────
    checkIp: () => ipcRenderer.invoke('check-ip'),

    // ── Navigation ───────────────────────────────────────────────
    goHome: () => ipcRenderer.send('go-home'),
    openBrowser: () => ipcRenderer.send('open-browser'),
    logout: () => ipcRenderer.send('logout'),

    // ── App Logging ──────────────────────────────────────────────
    getAppLogs: () => ipcRenderer.invoke('get-app-logs'),
    onAppLog: (cb) => ipcRenderer.on('app-log', (e, data) => cb(data)),

    // ── Window controls ──────────────────────────────────────────
    winMinimize: () => ipcRenderer.send('win-minimize'),
    winMaximize: () => ipcRenderer.send('win-maximize'),
    winClose: () => ipcRenderer.send('win-close'),

    // ── Proxy / VPN ──────────────────────────────────────────────
    setProxy: (proxyUrl) => ipcRenderer.invoke('set-proxy', proxyUrl),

    // ── Cookie Manager ───────────────────────────────────────────
    getCookieFilename: (domain) => ipcRenderer.invoke('get-cookie-filename', domain),
    getCookies: (url) => ipcRenderer.invoke('get-cookies', url),
    saveCookieFile: (domain, data, custom) => ipcRenderer.invoke('save-cookie-file', domain, data, custom),
    listCookieFiles: () => ipcRenderer.invoke('list-cookie-files'),
    deleteCookieFile: (name) => ipcRenderer.invoke('delete-cookie-file', name),

    // ── Tor ──────────────────────────────────────────────────────
    torStatus: () => ipcRenderer.invoke('tor-status'),
    torSetExit: (cc) => ipcRenderer.invoke('tor-set-exit', cc),
    torNewCircuit: () => ipcRenderer.invoke('tor-new-circuit'),

    // ── Lecture & Media Stream Sniffing (HLS / M3U8 / Segments) ───
    captureStreamM3u8: (pageUrl, m3u8Urls) => ipcRenderer.invoke('stream-capture-m3u8', pageUrl, m3u8Urls),
    captureStreamSegment: (pageUrl, segUrls) => ipcRenderer.invoke('stream-capture-seg', pageUrl, segUrls),
    captureMediaStream: (pageUrl, urls) => ipcRenderer.invoke('stream-capture-media', pageUrl, urls),

    // ── Events ───────────────────────────────────────────────────
    onTorReady: (cb) => ipcRenderer.on('tor-ready', (_e, d) => cb(d || {})),
    onTorBootstrap: (cb) => ipcRenderer.on('tor-bootstrap', (_e, d) => cb(d || {})),
    onTorStatusChange: (cb) => ipcRenderer.on('tor-status-change', (_e, d) => cb(d || {})),
    onOpenNewTab: (cb) => ipcRenderer.on('open-new-tab', (event, url, disposition) => cb(url, disposition)),
    isTestRunner: () => ipcRenderer.sendSync('is-test-runner'),
    
    // ── Music Download Events ────────────────────────────────────
    onMusicDownloadStarted: (cb) => ipcRenderer.on('music-download-started', (e, filename) => cb(filename)),
    onMusicDownloadCompleted: (cb) => ipcRenderer.on('music-download-completed', (e, filename) => cb(filename)),
    onMusicDownloadFailed: (cb) => ipcRenderer.on('music-download-failed', (e, filename) => cb(filename)),

    // ── Video Editor ─────────────────────────────────────────────
    editorGetDuration: (vaultId) => ipcRenderer.invoke('editor-get-duration', vaultId),
    editorTrim: (opts) => ipcRenderer.invoke('editor-trim', opts),
    editorCrop: (opts) => ipcRenderer.invoke('editor-crop', opts),
    editorMerge: (opts) => ipcRenderer.invoke('editor-merge', opts),
    editorExtractAudio: (opts) => ipcRenderer.invoke('editor-extract-audio', opts),
    onEditorProgress: (cb) => ipcRenderer.on('editor-progress', (e, data) => cb(data)),
});

// Shorthand nav (login.html / index.html)
contextBridge.exposeInMainWorld('appNav', {
    openBrowser: () => ipcRenderer.send('open-browser'),
    goHome: () => ipcRenderer.send('go-home'),
    logout: () => ipcRenderer.send('logout')
});

// Download control (browser.html download panel)
contextBridge.exposeInMainWorld('downloads', {
    getDownloads: () => ipcRenderer.invoke('get-downloads'),
    pause: (id) => ipcRenderer.send('pause-download', id),
    resume: (id) => ipcRenderer.send('resume-download', id),
    cancel: (id) => ipcRenderer.send('cancel-download', id)
});
