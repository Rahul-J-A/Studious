const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path   = require('path');
const fs     = require('fs');
const net    = require('net');
const http   = require('http');
const os     = require('os');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const { URL } = require('url');

// ============================================================
//  CONSOLE OUTPUT CAPTURE
// ============================================================

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
const logHistory = [];

function sendAppLog(level, ...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const logEntry = { level, msg, timestamp: Date.now() };
    logHistory.push(logEntry);
    if (logHistory.length > 500) logHistory.shift();
    BrowserWindow.getAllWindows().forEach(w => {
        try { w.webContents.send('app-log', logEntry); } catch (e) {}
    });
}

console.log = (...args) => { originalConsoleLog(...args); sendAppLog('info', ...args); };
console.warn = (...args) => { originalConsoleWarn(...args); sendAppLog('warn', ...args); };
console.error = (...args) => { originalConsoleError(...args); sendAppLog('error', ...args); };

ipcMain.handle('get-app-logs', () => logHistory);

// ============================================================
//  APPLICATION DATA DIRECTORIES & CONFIGURATION
// ============================================================
const isPackaged = app.isPackaged || __dirname.includes('app.asar');
const defaultBaseDir = fs.existsSync('D:\\Studious') 
    ? 'D:\\Studious' 
    : (fs.existsSync('D:\\') ? 'D:\\Studious' : path.join(app.getPath('userData'), 'StudiousData'));
const baseDataDir = isPackaged ? defaultBaseDir : __dirname;

const videosFolder     = path.join(baseDataDir, 'videos');
const thumbnailsFolder = path.join(baseDataDir, 'thumbnails');
const previewsFolder   = path.join(baseDataDir, 'previews');
const STAGE_FOLDER     = path.join(baseDataDir, 'stage');
const cookiesFolder    = path.join(baseDataDir, 'cookies');
const musicsFolder     = path.join(baseDataDir, 'musics');
const BACKUP_DIR       = path.join(baseDataDir, 'backups');
const TEMP_DIR         = path.join(baseDataDir, 'temp');
const appDataDir       = path.join(baseDataDir, 'appdata');

try {
    app.setPath('userData', appDataDir);
    app.setPath('cache',    path.join(appDataDir, 'cache'));
    app.setPath('logs',     path.join(appDataDir, 'logs'));
    app.setPath('temp',     TEMP_DIR);
} catch (e) {
    console.warn('[Init] Setting custom paths warning:', e.message);
}

for (const d of [
    videosFolder, thumbnailsFolder, previewsFolder, STAGE_FOLDER, cookiesFolder, musicsFolder, BACKUP_DIR, TEMP_DIR,
    appDataDir,
    path.join(appDataDir, 'cache'),
    path.join(appDataDir, 'logs')
]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

let mainWindow;
let downloadCounter = 0;
let downloadQueue   = [];
let activeDownloads = 0;
const MAX_PARALLEL  = 40;
let activeProxyUrl = null;

const usersFile = path.join(baseDataDir, 'users.json');
if (!fs.existsSync(usersFile)) {
    const originalUsersFile = path.join(__dirname, 'users.json');
    if (fs.existsSync(originalUsersFile)) {
        try { fs.copyFileSync(originalUsersFile, usersFile); } catch(e) { console.error('Failed to copy users.json:', e); }
    } else {
        try { fs.writeFileSync(usersFile, '[]'); } catch(e) { console.error('Failed to write users.json:', e); }
    }
}


// ============================================================
//  PLAYLIST SYSTEM (server-side persistence)
// ============================================================

const PLAYLISTS_FILE = path.join(baseDataDir, 'playlists.json');
let playlistsData = {};

function writeJsonAtomic(filePath, data) {
    const tempPath = filePath + '.tmp';
    try {
        const str = JSON.stringify(data, null, 2);
        fs.writeFileSync(tempPath, str, 'utf8');
        const written = fs.readFileSync(tempPath, 'utf8');
        JSON.parse(written);
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        console.error(`[Storage] Atomic write error to ${filePath}:`, e.message);
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        throw e;
    }
}

function loadPlaylists() {
    try {
        if (fs.existsSync(PLAYLISTS_FILE)) {
            const content = fs.readFileSync(PLAYLISTS_FILE, 'utf-8');
            playlistsData = JSON.parse(content);
            console.log('[Playlists] Loaded', Object.keys(playlistsData).length, 'playlists');
            return;
        }
    } catch (e) {
        console.warn('[Playlists] Load error from main file:', e.message);
    }

    // Attempt to recover from backups
    try {
        if (fs.existsSync(BACKUP_DIR)) {
            const files = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.startsWith('playlists_') && f.endsWith('.json'))
                .sort()
                .reverse();
            for (const file of files) {
                const backupPath = path.join(BACKUP_DIR, file);
                try {
                    const content = fs.readFileSync(backupPath, 'utf8');
                    playlistsData = JSON.parse(content);
                    writeJsonAtomic(PLAYLISTS_FILE, playlistsData);
                    console.log(`[Playlists] Successfully recovered playlists from backup: ${file}`);
                    return;
                } catch (backupErr) {
                    console.warn(`[Playlists] Failed to load backup ${file}:`, backupErr.message);
                }
            }
        }
    } catch (recoveryErr) {
        console.error('[Playlists] Recovery from backups failed:', recoveryErr.message);
    }

    playlistsData = {};
    console.log('[Playlists] Initialized empty playlists object');
}

let _plSaveTimer = null;
function savePlaylists() {
    if (_plSaveTimer) return;
    _plSaveTimer = setTimeout(() => {
        _plSaveTimer = null;
        try { writeJsonAtomic(PLAYLISTS_FILE, playlistsData); }
        catch (e) { console.error('[Playlists] Save error:', e.message); }
    }, 1000);
}

function savePlaylistsNow() {
    if (_plSaveTimer) { clearTimeout(_plSaveTimer); _plSaveTimer = null; }
    try { writeJsonAtomic(PLAYLISTS_FILE, playlistsData); }
    catch (e) { console.error('[Playlists] Save error:', e.message); }
}

function newPlaylistId() { return 'pl_' + crypto.randomBytes(8).toString('hex'); }

ipcMain.handle('playlist-list', () => {
    const result = [];
    for (const [id, pl] of Object.entries(playlistsData)) {
        let thumbVaultId = pl.thumbnail || (pl.videos.length ? pl.videos[0] : null);
        const downloadingCount = (pl.downloadQueue || []).filter(d => d.status !== 'done' && d.status !== 'error').length;
        result.push({
            id, name: pl.name, created: pl.created, modified: pl.modified,
            videoCount: pl.videos.length, videos: pl.videos, thumbVaultId,
            source: pl.source || 'manual', sourceUrl: pl.sourceUrl || null,
            downloadingCount, totalQueueCount: (pl.downloadQueue || []).length
        });
    }
    return result.sort((a, b) => (b.modified || 0) - (a.modified || 0));
});

ipcMain.handle('playlist-get', (e, plId) => {
    const pl = playlistsData[plId];
    if (!pl) return null;
    const videoDetails = pl.videos.map((vaultId, idx) => {
        const entry = vaultIndex[vaultId];
        if (!entry) return { vaultId, order: idx, missing: true };
        return { vaultId, order: idx, title: entry.title, ext: entry.ext, duration: entry.duration, size: entry.size, file: vaultId + VAULT_EXT, thumbnail: vaultId + VAULT_THUMB, added: entry.added };
    }).filter(v => !v.missing);
    return { ...pl, id: plId, videoDetails, downloadQueue: pl.downloadQueue || [] };
});

ipcMain.handle('playlist-create', (e, name) => {
    const id = newPlaylistId();
    playlistsData[id] = { name: name.trim(), created: Date.now(), modified: Date.now(), thumbnail: null, videos: [], source: 'manual', sourceUrl: null, downloadQueue: [] };
    savePlaylists();
    console.log('[Playlists] Created:', name, '->', id);
    return { ok: true, id };
});

ipcMain.handle('playlist-rename', (e, plId, newName) => {
    if (!playlistsData[plId]) return { ok: false };
    playlistsData[plId].name = newName.trim();
    playlistsData[plId].modified = Date.now();
    savePlaylists();
    return { ok: true };
});

ipcMain.handle('playlist-delete', (e, plId, deleteVideos) => {
    if (!playlistsData[plId]) return { ok: false };
    const pl = playlistsData[plId];
    const deletedVideos = [];

    if (deleteVideos && pl.videos && pl.videos.length > 0) {
        // Collect video IDs that are ONLY in this playlist (not shared with others)
        const otherPlaylists = Object.entries(playlistsData).filter(([id]) => id !== plId);
        const sharedIds = new Set();
        for (const [, otherPl] of otherPlaylists) {
            if (otherPl.videos) otherPl.videos.forEach(vid => sharedIds.add(vid));
        }

        for (const vaultId of pl.videos) {
            if (sharedIds.has(vaultId)) continue; // skip videos in other playlists
            try {
                safeUnlink(path.join(videosFolder, vaultId + VAULT_EXT));
                safeUnlink(path.join(thumbnailsFolder, vaultId + VAULT_THUMB));
                safeUnlink(path.join(previewsFolder, vaultId + VAULT_PREV));
                delete vaultIndex[vaultId];
                deletedVideos.push(vaultId);
            } catch (err) {
                console.error('[Playlists] Failed to delete video', vaultId, err.message);
            }
        }
        if (deletedVideos.length > 0) {
            saveVaultIndex();
            console.log(`[Playlists] Deleted ${deletedVideos.length} videos along with playlist "${pl.name}"`);
        }
    }

    delete playlistsData[plId];
    savePlaylists();
    return { ok: true, deletedVideos: deletedVideos.length };
});

ipcMain.handle('playlist-add-video', (e, plId, vaultId, position) => {
    const pl = playlistsData[plId]; if (!pl) return { ok: false };
    pl.videos = pl.videos.filter(v => v !== vaultId);
    if (position !== undefined && position !== null && position >= 0) pl.videos.splice(position, 0, vaultId);
    else pl.videos.push(vaultId);
    pl.modified = Date.now(); savePlaylists();
    return { ok: true };
});

ipcMain.handle('playlist-remove-video', (e, plId, vaultId) => {
    const pl = playlistsData[plId]; if (!pl) return { ok: false };
    pl.videos = pl.videos.filter(v => v !== vaultId);
    pl.modified = Date.now(); savePlaylists();
    return { ok: true };
});

ipcMain.handle('playlist-reorder', (e, plId, vaultIds) => {
    const pl = playlistsData[plId]; if (!pl) return { ok: false };
    pl.videos = vaultIds; pl.modified = Date.now(); savePlaylists();
    return { ok: true };
});

ipcMain.handle('playlist-set-thumbnail', (e, plId, vaultId) => {
    const pl = playlistsData[plId]; if (!pl) return { ok: false };
    pl.thumbnail = vaultId; pl.modified = Date.now(); savePlaylists();
    return { ok: true };
});

ipcMain.handle('playlist-migrate', (e, oldData) => {
    if (!oldData || typeof oldData !== 'object') return { ok: false };
    let migrated = 0;
    for (const [name, files] of Object.entries(oldData)) {
        const existing = Object.values(playlistsData).find(p => p.name === name);
        if (existing) continue;
        const id = newPlaylistId();
        const vaultIds = (files || []).map(f => path.parse(f).name).filter(vid => vaultIndex[vid]);
        playlistsData[id] = { name, created: Date.now(), modified: Date.now(), thumbnail: null, videos: vaultIds, source: 'migrated', sourceUrl: null, downloadQueue: [] };
        migrated++;
    }
    if (migrated) { savePlaylists(); console.log(`[Playlists] Migrated ${migrated} playlists from localStorage`); }
    return { ok: true, migrated };
});

ipcMain.handle('playlist-export', async () => {
    try {
        const win = BrowserWindow.getFocusedWindow();
        if (!win) return { ok: false, error: 'No active window' };
        
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'Export Playlists',
            defaultPath: 'playlists.json',
            filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });
        
        if (canceled || !filePath) return { ok: false, canceled: true };
        
        fs.writeFileSync(filePath, JSON.stringify(playlistsData, null, 2));
        return { ok: true, filePath };
    } catch (e) {
        console.error('[Playlists] Export error:', e.message);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('playlist-import', async () => {
    try {
        const win = BrowserWindow.getFocusedWindow();
        if (!win) return { ok: false, error: 'No active window' };
        
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            title: 'Import Playlists',
            properties: ['openFile'],
            filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });
        
        if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
        
        const fileContent = fs.readFileSync(filePaths[0], 'utf-8');
        const importedData = JSON.parse(fileContent);
        
        let imported = 0;
        for (const [id, pl] of Object.entries(importedData)) {
            if (!playlistsData[id]) {
                playlistsData[id] = pl;
                imported++;
            }
        }
        
        if (imported > 0) {
            savePlaylists();
            console.log(`[Playlists] Imported ${imported} new playlists`);
        }
        
        return { ok: true, imported };
    } catch (e) {
        console.error('[Playlists] Import error:', e.message);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('check-download-type', async (e, url) => {
    if (!url) return { isPlaylist: false };
    try {
        const domain = getHostname(url);
        const cookiePath = findCookieFile(domain || '');
        return await new Promise((resolve) => {
            const args = ['--flat-playlist', '--dump-json', '--no-download', '--no-warnings', '--js-runtimes', 'node'];
            if (cookiePath) {
                args.push('--cookies', cookiePath);
            } else if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
                args.push('--cookies-from-browser', 'edge');
            }
            if (activeProxyUrl) { args.push('--proxy', activeProxyUrl); }
            args.push(url);
            const ytdlp = spawn('yt-dlp', args, { windowsHide: true });
            let stdout = '';
            let timer = setTimeout(() => { ytdlp.kill(); resolve({ isPlaylist: false }); }, 45000);
            ytdlp.stdout.on('data', d => { stdout += d.toString(); });
            ytdlp.stderr.on('data', () => {});
            ytdlp.on('close', () => {
                clearTimeout(timer);
                try {
                    const lines = stdout.trim().split('\n').filter(l => l.trim());
                    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                    if (entries.length > 1) {
                        const plTitle = entries[0]?.playlist_title || entries[0]?.playlist || 'Downloaded Playlist';
                        resolve({ isPlaylist: true, playlistTitle: plTitle, videoCount: entries.length,
                            videos: entries.map((e, i) => ({ url: e.url || e.webpage_url || e.original_url, title: e.title || `Video ${i + 1}`, duration: e.duration || 0, order: i }))
                        });
                    } else { resolve({ isPlaylist: false, title: entries[0]?.title || '' }); }
                } catch { resolve({ isPlaylist: false }); }
            });
            ytdlp.on('error', () => { clearTimeout(timer); resolve({ isPlaylist: false }); });
        });
    } catch { return { isPlaylist: false }; }
});

ipcMain.handle('download-to-playlist', async (e, url, playlistId) => {
    console.log('[Download To Playlist IPC] Received request for URL:', url, 'playlistId:', playlistId);
    if (!url) return { started: false };
    const pl = playlistsData[playlistId];
    if (!pl) return { started: false, error: 'Playlist not found' };
    const queueEntry = { url, title: 'Detecting...', order: pl.videos.length, status: 'queued', addedAt: Date.now() };
    if (!pl.downloadQueue) pl.downloadQueue = [];
    pl.downloadQueue.push(queueEntry);
    savePlaylists();
    downloadQueue.push({ videoUrl: url, filePath: path.join(STAGE_FOLDER, '%(title)s.%(ext)s'), _playlistId: playlistId, _queueIdx: pl.downloadQueue.length - 1 });
    processQueue();
    return { started: true };
});

ipcMain.handle('download-playlist', async (e, url) => {
    if (!url) return { started: false };
    console.log('[Download Playlist IPC] Probing playlist URL:', url);
    try {
        const domain = getHostname(url);
        const cookiePath = findCookieFile(domain || '');
        const probe = await new Promise((resolve) => {
            const args = ['--flat-playlist', '--dump-json', '--no-download', '--no-warnings', '--js-runtimes', 'node'];
            if (cookiePath) { args.push('--cookies', cookiePath); }
            args.push(url);
            console.log('[Download Playlist IPC] Running yt-dlp', args.join(' '));
            const ytdlp = spawn('yt-dlp', args, { windowsHide: true });
            let stdout = '';
            let stderr = '';
            let timer = setTimeout(() => {
                console.error('[Download Playlist IPC] Probe timed out after 120s');
                ytdlp.kill();
                resolve(null);
            }, 120000);
            ytdlp.stdout.on('data', d => { stdout += d.toString(); });
            ytdlp.stderr.on('data', d => { stderr += d.toString(); });
            ytdlp.on('close', (code) => {
                clearTimeout(timer);
                console.log(`[Download Playlist IPC] yt-dlp closed with code ${code}`);
                if (code !== 0) {
                    console.error('[Download Playlist IPC] yt-dlp stderr:', stderr);
                }
                try {
                    const lines = stdout.trim().split('\n').filter(l => l.trim());
                    resolve(lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
                } catch (err) {
                    console.error('[Download Playlist IPC] Failed to parse JSON lines:', err.message);
                    resolve(null);
                }
            });
            ytdlp.on('error', (err) => {
                clearTimeout(timer);
                console.error('[Download Playlist IPC] Spawn error:', err.message);
                resolve(null);
            });
        });
        if (!probe || probe.length === 0) return { started: false, error: 'Could not detect playlist' };
        const plTitle = probe[0]?.playlist_title || probe[0]?.playlist || 'Downloaded Playlist ' + Date.now();
        const plId = newPlaylistId();
        playlistsData[plId] = {
            name: plTitle, created: Date.now(), modified: Date.now(), thumbnail: null, videos: [],
            source: 'download', sourceUrl: url,
            downloadQueue: probe.map((entry, i) => ({ url: entry.url || entry.webpage_url || entry.original_url, title: entry.title || `Video ${i + 1}`, duration: entry.duration || 0, order: i, status: 'queued', addedAt: Date.now() }))
        };
        savePlaylists();
        console.log(`[Playlists] Created download playlist "${plTitle}" with ${probe.length} videos`);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('playlist-dl-progress', { playlistId: plId, playlistName: plTitle, total: probe.length, completed: 0, status: 'started' }));
        for (let i = 0; i < probe.length; i++) {
            const videoUrl = probe[i].url || probe[i].webpage_url || probe[i].original_url;
            if (!videoUrl) continue;
            downloadQueue.push({ videoUrl, filePath: path.join(STAGE_FOLDER, '%(title)s.%(ext)s'), _playlistId: plId, _queueIdx: i, _playlistOrder: i });
        }
        processQueue();
        return { started: true, playlistId: plId, playlistName: plTitle, videoCount: probe.length };
    } catch (err) {
        console.error('[Playlists] Download playlist error:', err.message);
        return { started: false, error: err.message };
    }
});


// ============================================================
//  VAULT SYSTEM
// ============================================================

const VAULT_KEY      = 0xB3;
const VAULT_EXT      = '.lhr';
const VAULT_THUMB    = '.lhrt';
const VAULT_PREV     = '.lhrp';
const vaultIndexPath = path.join(baseDataDir, 'vault.json');
let   vaultIndex     = {};

function loadVaultIndex() {
    try {
        if (fs.existsSync(vaultIndexPath)) {
            const content = fs.readFileSync(vaultIndexPath, 'utf-8');
            vaultIndex = JSON.parse(content);
            console.log('[Vault] Loaded', Object.keys(vaultIndex).length, 'videos');
            return;
        }
    } catch(e) {
        console.warn('[Vault] Load error from main file:', e.message);
    }

    // Attempt to recover from backups
    try {
        if (fs.existsSync(BACKUP_DIR)) {
            const files = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.startsWith('vault_') && f.endsWith('.json'))
                .sort()
                .reverse();
            for (const file of files) {
                const backupPath = path.join(BACKUP_DIR, file);
                try {
                    const content = fs.readFileSync(backupPath, 'utf8');
                    vaultIndex = JSON.parse(content);
                    writeJsonAtomic(vaultIndexPath, vaultIndex);
                    console.log(`[Vault] Successfully recovered vault index from backup: ${file}`);
                    return;
                } catch (backupErr) {
                    console.warn(`[Vault] Failed to load backup ${file}:`, backupErr.message);
                }
            }
        }
    } catch (recoveryErr) {
        console.error('[Vault] Recovery from backups failed:', recoveryErr.message);
    }

    vaultIndex = {};
    console.log('[Vault] Initialized empty vault index');
}

function saveVaultIndex() {
    try { writeJsonAtomic(vaultIndexPath, vaultIndex); }
    catch(e) { console.error('[Vault] Save error:', e.message); }
}

function saveVaultIndexNow() {
    try { writeJsonAtomic(vaultIndexPath, vaultIndex); }
    catch (e) { console.error('[Vault] Save error:', e.message); }
}

function newVaultId() { return crypto.randomBytes(16).toString('hex'); }

// ── FIXED: Chunked XOR using streams — never blocks the event loop ──
const CHUNK_SIZE = 64 * 1024; // 64KB chunks

function xorTransform(buf, key) {
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key;
    return out;
}

// Async stream-based XOR transform — non-blocking
function xorFileStream(srcPath, dstPath) {
    return new Promise((resolve, reject) => {
        const readStream  = fs.createReadStream(srcPath, { highWaterMark: CHUNK_SIZE });
        const writeStream = fs.createWriteStream(dstPath);
        readStream.on('data', chunk => {
            const out = Buffer.allocUnsafe(chunk.length);
            for (let i = 0; i < chunk.length; i++) out[i] = chunk[i] ^ VAULT_KEY;
            writeStream.write(out);
        });
        readStream.on('end',   () => { writeStream.end(); });
        writeStream.on('finish', resolve);
        readStream.on('error',  reject);
        writeStream.on('error', reject);
    });
}

// ── FIXED: Streaming decode to temp file (async, non-blocking) ──
function deobfuscateToTempFile(vaultPath, tmpPath) {
    return xorFileStream(vaultPath, tmpPath);
}

// ── Small files only (thumbnails/previews <5MB) — synchronous is fine ──
function deobfuscateSmallBuffer(vaultPath) {
    const buf = fs.readFileSync(vaultPath);
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ VAULT_KEY;
    return out;
}

function writeObfBuf(buf, dstPath) {
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ VAULT_KEY;
    fs.writeFileSync(dstPath, out);
}

// Sync obfuscate — only called for small completed files in bg
function obfuscateFileToDisk(srcPath, dstPath) {
    return xorFileStream(srcPath, dstPath);
}


// ── Migrate plain files ──
async function migrateToVault() {
    const plain = fs.readdirSync(videosFolder)
        .filter(f => ['.mp4','.webm','.mkv','.ogg'].includes(path.extname(f).toLowerCase()));
    if (!plain.length) return;
    console.log('[Vault] Migrating', plain.length, 'plain file(s)...');

    for (const file of plain) {
        const srcPath  = path.join(videosFolder, file);
        const baseName = path.parse(file).name;
        const ext      = path.extname(file).toLowerCase();
        const id       = newVaultId();
        const dstPath  = path.join(videosFolder, id + VAULT_EXT);
        try {
            // Get duration and size BEFORE moving the file
            const srcStat  = fs.statSync(srcPath);
            const duration = await getVideoDuration(srcPath).catch(() => 0);

            // Stream XOR the file — handles files >2GB fine
            await xorFileStream(srcPath, dstPath);

            // Migrate existing thumbnail if present
            const oldThumb = path.join(thumbnailsFolder, baseName + '.jpg');
            if (fs.existsSync(oldThumb)) {
                writeObfBuf(fs.readFileSync(oldThumb), path.join(thumbnailsFolder, id + VAULT_THUMB));
                fs.unlinkSync(oldThumb);
            }

            const dstStat = fs.statSync(dstPath);
            vaultIndex[id] = {
                title:         baseName,
                ext,
                duration,
                size:          dstStat.size,
                originalSize:  srcStat.size,
                added:         Date.now(),
                optimized:     false,
                optimizeStatus:'queued'
            };

            // Delete source only after vault entry is confirmed written
            fs.unlinkSync(srcPath);
            console.log('[Vault] Migrated:', baseName, '->', id + VAULT_EXT, `(${(dstStat.size/1024/1024/1024).toFixed(2)} GB)`);
        } catch(e) {
            console.error('[Vault] Migration failed:', file, e.message);
            // Clean up partial vault file if it was created
            try { if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath); } catch {}
        }
    }
    saveVaultIndex();
    console.log('[Vault] Migration complete');
}


// ── Generate obfuscated thumbnail — uses temp file, no giant RAM alloc ──
async function generateVaultThumbnail(id) {
    const entry     = vaultIndex[id];
    const vaultPath = path.join(videosFolder, id + VAULT_EXT);
    const dstThumb  = path.join(thumbnailsFolder, id + VAULT_THUMB);
    if (!entry || !fs.existsSync(vaultPath) || fs.existsSync(dstThumb)) return;

    const tmpVid   = path.join(TEMP_DIR, `lhr_${id}${entry.ext || '.mp4'}`);
    const tmpThumb = path.join(TEMP_DIR, `lhr_${id}_t.jpg`);
    try {
        await deobfuscateToTempFile(vaultPath, tmpVid);
        
        let duration = entry.duration;
        if (!duration || duration <= 0) {
            duration = await getVideoDuration(tmpVid).catch(() => 0);
            if (duration > 0) {
                entry.duration = duration;
                saveVaultIndex();
            }
        }

        await generateThumbnail(tmpVid, tmpThumb, duration || 10);
        if (fs.existsSync(tmpThumb)) {
            writeObfBuf(fs.readFileSync(tmpThumb), dstThumb);
            fs.unlinkSync(tmpThumb);
        }
    } catch(e) { console.warn('[Vault] Thumb failed', id, e.message); }
    finally { try { fs.unlinkSync(tmpVid); } catch {} }
}


// ── Generate preview mosaic ──
async function generateVaultPreview(id) {
    const entry    = vaultIndex[id];
    const vaultPath= path.join(videosFolder, id + VAULT_EXT);
    const dstPrev  = path.join(previewsFolder, id + VAULT_PREV);
    if (!entry || !fs.existsSync(vaultPath) || fs.existsSync(dstPrev)) return;

    const tmpVid    = path.join(TEMP_DIR, `lhr_${id}${entry.ext || '.mp4'}`);
    const tmpMosaic = path.join(TEMP_DIR, `lhr_${id}_mosaic.jpg`);
    const frames    = [];
    try {
        await deobfuscateToTempFile(vaultPath, tmpVid);
        
        let dur = entry.duration;
        if (!dur || dur <= 0) {
            dur = await getVideoDuration(tmpVid).catch(() => 0);
            if (dur > 0) {
                entry.duration = dur;
                saveVaultIndex();
            }
        }
        dur = dur || 60;

        for (let i = 0; i < 4; i++) {
            const t  = Math.max(1, Math.floor(dur * [0.25, 0.50, 0.75, 0.90][i]));
            const ff = path.join(TEMP_DIR, `lhr_${id}_f${i}.jpg`);
            await new Promise(res =>
                exec(`ffmpeg -ss ${t} -i "${tmpVid}" -frames:v 1 -q:v 3 -vf "scale=320:-1" "${ff}" -y`, () => res())
            );
            if (fs.existsSync(ff)) frames.push(ff);
        }
        if (frames.length >= 2) {
            const inputs = frames.map(f => `-i "${f}"`).join(' ');
            const filter = frames.length === 4
                ? '[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0'
                : '[0][1]hstack';
            await new Promise(res =>
                exec(`ffmpeg ${inputs} -filter_complex "${filter}" "${tmpMosaic}" -y`, () => res())
            );
            if (fs.existsSync(tmpMosaic)) {
                writeObfBuf(fs.readFileSync(tmpMosaic), dstPrev);
                fs.unlinkSync(tmpMosaic);
            }
        }
    } catch(e) { console.warn('[Vault] Preview failed', id, e.message); }
    finally {
        try { fs.unlinkSync(tmpVid); } catch {}
        for (const f of frames) { try { fs.unlinkSync(f); } catch {} }
    }
}


async function getVaultDuration(id) {
    const vaultPath = path.join(videosFolder, id + VAULT_EXT);
    const ext  = vaultIndex[id]?.ext || '.mp4';
    const tmp  = path.join(TEMP_DIR, `lhr_dur_${id}${ext}`);
    try {
        await deobfuscateToTempFile(vaultPath, tmp);
        return await getVideoDuration(tmp);
    } catch { return 0; }
    finally { try { fs.unlinkSync(tmp); } catch {} }
}


async function scanVault() {
    const files = fs.readdirSync(videosFolder).filter(f => f.endsWith(VAULT_EXT));
    const liveIds = new Set(files.map(f => path.parse(f).name));

    // ── Purge orphan vaultIndex entries (file deleted outside app) ──
    let purged = 0;
    for (const id of Object.keys(vaultIndex)) {
        if (!liveIds.has(id)) { delete vaultIndex[id]; purged++; }
    }
    if (purged) console.log(`[Vault] Purged ${purged} orphan index entries`);

    const result = [];

    for (const file of files) {
        const id = path.parse(file).name;
        if (!vaultIndex[id]) {
            const stat = fs.statSync(path.join(videosFolder, file));
            vaultIndex[id] = { title: 'Video_' + id.slice(0,8), ext: '.mp4', duration: 0, size: stat.size, added: stat.mtimeMs, optimized: true, optimizeStatus: 'skipped' };
        }
        const entry = vaultIndex[id];

        if (!fs.existsSync(path.join(thumbnailsFolder, id + VAULT_THUMB)))
            queueAsset(id, 'thumb');
        if (!fs.existsSync(path.join(previewsFolder, id + VAULT_PREV)))
            queueAsset(id, 'preview');

        if (!entry.duration) {
            getVaultDuration(id)
                .then(d => { if (d > 0) { entry.duration = d; saveVaultIndex(); } })
                .catch(() => {});
        }

        result.push({
            file:          id + VAULT_EXT,
            vaultId:       id,
            title:         entry.title,
            ext:           entry.ext,
            thumbnail:     id + VAULT_THUMB,
            preview:       id + VAULT_PREV,
            duration:      entry.duration,
            size:          entry.size,
            originalSize:  entry.originalSize || entry.size,
            savedPercent:  entry.savedPercent || 0,
            optimized:     entry.optimized || false,
            optimizeStatus:entry.optimizeStatus || 'queued',
            codec:         entry.codec || '',
            modified:      entry.added
        });
    }

    saveVaultIndex();

    // ── Purge watch history and notes for deleted videos ──
    try {
        const wh = loadWatchHistory();
        let whChanged = false;
        for (const id of Object.keys(wh)) { if (!liveIds.has(id)) { delete wh[id]; whChanged = true; } }
        if (whChanged) saveWatchHistory(wh);

        const notes = loadNotes();
        let notesChanged = false;
        for (const id of Object.keys(notes)) { if (!liveIds.has(id)) { delete notes[id]; notesChanged = true; } }
        if (notesChanged) saveNotes(notes);
    } catch {}

    return result.sort((a, b) => b.modified - a.modified);
}

// Safe delete — chmod first to avoid EPERM, silently ignore if missing
function safeUnlink(filePath) {
    if (!filePath) return;
    try { fs.chmodSync(filePath, 0o666); } catch {}
    try { fs.unlinkSync(filePath); } catch {}
}


function vaultDownloadedFile(filePath, title, playlistId = null, queueIdx = null) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const ext = path.extname(filePath).toLowerCase();
        const id  = newVaultId();
        const dst = path.join(videosFolder, id + VAULT_EXT);

        // Async XOR — doesn't block
        xorFileStream(filePath, dst).then(() => {
            const tryDelete = (attempts = 0) => {
                try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
                catch (e) {
                    if (attempts < 10) setTimeout(() => tryDelete(attempts + 1), 1000);
                    else console.warn('Failed to clean up stage file:', filePath);
                }
            };
            tryDelete();
            const stat = fs.statSync(dst);
            const actualTitle = title || path.parse(filePath).name;
            vaultIndex[id] = {
                title: actualTitle,
                ext, duration: 0,
                size: stat.size,
                originalSize: stat.size,
                added: Date.now(),
                optimized: false,
                optimizeStatus: 'queued'
            };
            saveVaultIndex();
            queueAsset(id, 'thumb');
            queueAsset(id, 'preview');
            addToEncodeQueue(id);
            console.log('[Vault] Vaulted:', actualTitle, '->', id + VAULT_EXT);

            // ── Playlist handling ──
            if (playlistId && playlistsData[playlistId]) {
                const pl = playlistsData[playlistId];
                if (pl.downloadQueue && pl.downloadQueue[queueIdx]) {
                    pl.downloadQueue[queueIdx].status = 'done';
                    pl.downloadQueue[queueIdx].vaultId = id;
                    pl.downloadQueue[queueIdx].title = actualTitle;
                }
                if (pl.source === 'download') {
                    const finished = (pl.downloadQueue || [])
                        .filter(item => item.status === 'done' && item.vaultId)
                        .sort((a, b) => a.order - b.order)
                        .map(item => item.vaultId);
                    pl.videos = finished;
                } else {
                    if (!pl.videos.includes(id)) pl.videos.push(id);
                }
                pl.modified = Date.now();
                savePlaylists();
                const completedCount = (pl.downloadQueue || []).filter(item => item.status === 'done').length;
                const totalCount = (pl.downloadQueue || []).length;
                BrowserWindow.getAllWindows().forEach(w => {
                    w.webContents.send('playlist-dl-progress', { playlistId, playlistName: pl.name, completed: completedCount, total: totalCount, status: completedCount === totalCount ? 'completed' : 'progressing', vaultId: id, title: actualTitle });
                    w.webContents.send('playlist-video-complete', { playlistId, vaultId: id, title: actualTitle, order: queueIdx });
                });
            }
        }).catch(e => console.error('[Vault] Error:', e.message));

        return id;
    } catch(e) { console.error('[Vault] Error:', e.message); return null; }
}

function vaultMusicFile(filePath, filename) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const ext = path.extname(filePath).toLowerCase();
        const id  = newVaultId();
        const dst = path.join(musicsFolder, id + '.lhrm');
        
        xorFileStream(filePath, dst).then(() => {
            try { fs.unlinkSync(filePath); } catch (e) {}
            console.log('[Music Vault] Vaulted:', filename, '->', id + '.lhrm');
            const musicIndexPath = path.join(baseDataDir, 'music.json');
            let musicIndex = {};
            if (fs.existsSync(musicIndexPath)) {
                try { musicIndex = JSON.parse(fs.readFileSync(musicIndexPath, 'utf-8')); } catch {}
            }
            musicIndex[id] = { title: filename, ext: ext, added: Date.now() };
            fs.writeFileSync(musicIndexPath, JSON.stringify(musicIndex, null, 2));
        }).catch(e => console.error('[Music Vault] Error:', e.message));
        return id;
    } catch(e) { console.error('[Music Vault] Error:', e.message); return null; }
}


// ============================================================
//  LOCAL HTTP STREAMING SERVER
//  KEY FIX: Stream the XOR decode on-the-fly using pipe+transform
//  Never loads full file into RAM. Supports range requests properly.
// ============================================================

const { Transform } = require('stream');

function createXorTransformStream(key) {
    return new Transform({
        transform(chunk, encoding, callback) {
            const out = Buffer.allocUnsafe(chunk.length);
            for (let i = 0; i < chunk.length; i++) out[i] = chunk[i] ^ key;
            callback(null, out);
        }
    });
}

let streamServer = null;
let streamPort   = 0;

function ensureStreamServer() {
    if (streamServer) return Promise.resolve(streamPort);
    return new Promise(resolve => {
        streamServer = http.createServer((req, res) => {
            const play    = req.url.match(/^\/play\/([a-f0-9]+)$/);
            const thumb   = req.url.match(/^\/thumb\/([a-f0-9]+)$/);
            const preview = req.url.match(/^\/preview\/([a-f0-9]+)$/);
            const music   = req.url.match(/^\/music\/([a-f0-9]+)$/);

            // Images are small — sync decode is fine
            const serveImage = (folder, ext, id) => {
                const fp = path.join(folder, id + ext);
                if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
                try {
                    const buf = deobfuscateSmallBuffer(fp);
                    res.writeHead(200, { 'Content-Type':'image/jpeg', 'Content-Length': buf.length, 'Cache-Control':'no-store' });
                    res.end(buf);
                } catch { res.writeHead(500); res.end(); }
            };

            if (thumb)   { serveImage(thumbnailsFolder, VAULT_THUMB, thumb[1]);   return; }
            if (preview) { serveImage(previewsFolder,   VAULT_PREV,  preview[1]); return; }
            
            if (music) {
                const id = music[1];
                const vp = path.join(musicsFolder, id + '.lhrm');
                if (!fs.existsSync(vp)) { res.writeHead(404); res.end(); return; }
                try {
                    const total = fs.statSync(vp).size;
                    const mime = 'audio/mpeg';
                    const range = req.headers['range'];

                    if (range) {
                        const [s, e] = range.replace(/bytes=/, '').split('-');
                        const start  = parseInt(s, 10);
                        const end    = e ? parseInt(e, 10) : Math.min(start + 1024*1024, total - 1);
                        const chunkLen = end - start + 1;
                        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunkLen, 'Content-Type': mime });
                        const readStream = fs.createReadStream(vp, { start, end });
                        const xor = createXorTransformStream(VAULT_KEY);
                        readStream.pipe(xor).pipe(res);
                        readStream.on('error', () => res.destroy());
                    } else {
                        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
                        const readStream = fs.createReadStream(vp);
                        const xor = createXorTransformStream(VAULT_KEY);
                        readStream.pipe(xor).pipe(res);
                        readStream.on('error', () => res.destroy());
                    }
                } catch(e) { console.error('[Music] Stream error:', e.message); res.writeHead(500); res.end(); }
                return;
            }
            
            if (!play)   { res.writeHead(404); res.end('Not found'); return; }

            // ── Video streaming — fully piped, no full-file RAM alloc ──
            const id    = play[1];
            const entry = vaultIndex[id];
            const vp    = path.join(videosFolder, id + VAULT_EXT);
            if (!entry || !fs.existsSync(vp)) { res.writeHead(404); res.end(); return; }

            try {
                const total = fs.statSync(vp).size;  // obfuscated == same size as decoded
                const mimes = { '.mp4':'video/mp4', '.webm':'video/webm', '.mkv':'video/x-matroska', '.ogg':'video/ogg' };
                const mime  = mimes[entry.ext] || 'video/mp4';
                const range = req.headers['range'];

                if (range) {
                    const [s, e] = range.replace(/bytes=/, '').split('-');
                    const start  = parseInt(s, 10);
                    const end    = e ? parseInt(e, 10) : Math.min(start + 1024*1024, total - 1);
                    const chunkLen = end - start + 1;

                    res.writeHead(206, {
                        'Content-Range':  `bytes ${start}-${end}/${total}`,
                        'Accept-Ranges':  'bytes',
                        'Content-Length': chunkLen,
                        'Content-Type':   mime
                    });

                    // Stream only the requested range through XOR transform
                    const readStream = fs.createReadStream(vp, { start, end });
                    const xor = createXorTransformStream(VAULT_KEY);
                    readStream.pipe(xor).pipe(res);
                    readStream.on('error', () => res.destroy());
                } else {
                    res.writeHead(200, {
                        'Content-Type':   mime,
                        'Content-Length': total,
                        'Accept-Ranges':  'bytes'
                    });
                    // Full stream with XOR transform — zero RAM overhead
                    const readStream = fs.createReadStream(vp);
                    const xor = createXorTransformStream(VAULT_KEY);
                    readStream.pipe(xor).pipe(res);
                    readStream.on('error', () => res.destroy());
                }
            } catch(e) { console.error('[Vault] Stream error:', e.message); res.writeHead(500); res.end(); }
        });

        streamServer.listen(0, '127.0.0.1', () => {
            streamPort = streamServer.address().port;
            console.log('[Vault] Stream server -> http://127.0.0.1:' + streamPort);
            resolve(streamPort);
        });
    });
}


// ── Vault IPC ──
ipcMain.handle('vault-scan',   async () => await scanVault());
ipcMain.handle('vault-status', async () => ({
    count:     Object.keys(vaultIndex).length,
    vaultKey:  VAULT_KEY,
    encodeQueue: encodeQueue.length,
    encoding:  !!currentEncodeJob
}));
ipcMain.handle('vault-get-url', async (event, vaultId, type) => {
    const port = await ensureStreamServer();
    return `http://127.0.0.1:${port}/${type || 'play'}/${vaultId}`;
});
ipcMain.handle('vault-delete', async (event, vaultId) => {
    try {
        for (const [dir, ext] of [
            [videosFolder,     VAULT_EXT],
            [thumbnailsFolder, VAULT_THUMB],
            [previewsFolder,   VAULT_PREV]
        ]) {
            const fp = path.join(dir, vaultId + ext);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }
        delete vaultIndex[vaultId];
        saveVaultIndex();
        return { deleted: true };
    } catch(e) { return { deleted: false, error: e.message }; }
});
ipcMain.handle('vault-rename', async (event, vaultId, newTitle) => {
    if (!vaultIndex[vaultId]) return { ok: false };
    vaultIndex[vaultId].title = newTitle.trim();
    saveVaultIndex();
    return { ok: true };
});

ipcMain.handle('get-videos', async () => await scanVault());
ipcMain.handle('get-video-path', async (event, file) => {
    const port = await ensureStreamServer();
    return `http://127.0.0.1:${port}/play/${path.parse(file).name}`;
});
ipcMain.handle('get-thumbnail-path', async (event, file) => {
    const port = await ensureStreamServer();
    return `http://127.0.0.1:${port}/thumb/${path.parse(file).name}`;
});
ipcMain.handle('get-preview-path', async (event, vaultId) => {
    const port = await ensureStreamServer();
    return `http://127.0.0.1:${port}/preview/${vaultId}`;
});

ipcMain.handle('get-music-list', async () => {
    try {
        if (!fs.existsSync(musicsFolder)) fs.mkdirSync(musicsFolder, { recursive: true });
        
        // Auto-import any raw audio files dropped into the folder
        const files = fs.readdirSync(musicsFolder);
        for (const f of files) {
            const ext = path.extname(f).toLowerCase();
            if (['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac'].includes(ext)) {
                const fp = path.join(musicsFolder, f);
                vaultMusicFile(fp, path.basename(f, ext));
            }
        }
        
        const musicIndexPath = path.join(baseDataDir, 'music.json');
        if (!fs.existsSync(musicIndexPath)) return [];
        const index = JSON.parse(fs.readFileSync(musicIndexPath, 'utf-8'));
        let changed = false;
        const validList = [];
        for (const id of Object.keys(index)) {
            const fp = path.join(musicsFolder, id + '.lhrm');
            if (fs.existsSync(fp)) {
                validList.push({ id, ...index[id] });
            } else {
                delete index[id];
                changed = true;
            }
        }
        if (changed) fs.writeFileSync(musicIndexPath, JSON.stringify(index, null, 2));
        return validList.sort((a, b) => b.added - a.added);
    } catch { return []; }
});
ipcMain.handle('get-music-url', async (event, musicId) => {
    const port = await ensureStreamServer();
    return `http://127.0.0.1:${port}/music/${musicId}`;
});

ipcMain.handle('rename-music', async (event, musicId, newTitle) => {
    try {
        const musicIndexPath = path.join(baseDataDir, 'music.json');
        if (!fs.existsSync(musicIndexPath)) return { ok: false };
        const index = JSON.parse(fs.readFileSync(musicIndexPath, 'utf-8'));
        if (!index[musicId]) return { ok: false };
        index[musicId].title = newTitle;
        fs.writeFileSync(musicIndexPath, JSON.stringify(index, null, 2));
        return { ok: true };
    } catch { return { ok: false }; }
});

ipcMain.handle('delete-music', async (event, musicId) => {
    try {
        const musicIndexPath = path.join(baseDataDir, 'music.json');
        const fp = path.join(musicsFolder, musicId + '.lhrm');
        safeUnlink(fp);
        if (fs.existsSync(musicIndexPath)) {
            const index = JSON.parse(fs.readFileSync(musicIndexPath, 'utf-8'));
            if (index[musicId]) {
                delete index[musicId];
                fs.writeFileSync(musicIndexPath, JSON.stringify(index, null, 2));
            }
        }
        return { ok: true };
    } catch { return { ok: false }; }
});

ipcMain.handle('vault-regen-assets', async (e, vaultId) => {
    try {
        const tp = path.join(thumbnailsFolder, vaultId + VAULT_THUMB);
        const pp = path.join(previewsFolder, vaultId + VAULT_PREV);
        safeUnlink(tp); safeUnlink(pp);
        queueAsset(vaultId, 'all', true);
        return { ok: true };
    } catch (e) { return { ok: false, msg: e.message }; }
});

ipcMain.handle('vault-batch-delete', async (e, vaultIds) => {
    const results = [];
    for (const id of vaultIds) {
        try {
            if (!vaultIndex[id]) { results.push({ id, ok: false }); continue; }
            safeUnlink(path.join(videosFolder, id + VAULT_EXT));
            safeUnlink(path.join(thumbnailsFolder, id + VAULT_THUMB));
            safeUnlink(path.join(previewsFolder, id + VAULT_PREV));
            delete vaultIndex[id];
            results.push({ id, ok: true });
        } catch { results.push({ id, ok: false }); }
    }
    saveVaultIndex();
    return results;
});

ipcMain.handle('vault-find-duplicates', async () => {
    const SAMPLE_BYTES = 64 * 1024;
    const fingerprints = {};
    for (const [id, entry] of Object.entries(vaultIndex)) {
        const fp = path.join(videosFolder, id + VAULT_EXT);
        if (!fs.existsSync(fp)) continue;
        try {
            const stat = fs.statSync(fp);
            const fd = fs.openSync(fp, 'r');
            const buf = Buffer.alloc(Math.min(SAMPLE_BYTES, stat.size));
            fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            const hash = crypto.createHash('sha256').update(buf).digest('hex');
            const key = `${hash}_${Math.round(entry.duration || 0)}`;
            if (!fingerprints[key]) fingerprints[key] = [];
            fingerprints[key].push({ id, ...entry });
        } catch {}
    }
    return Object.values(fingerprints).filter(g => g.length > 1);
});

ipcMain.handle('storage-analytics', async () => {
    let totalOriginal = 0, totalCurrent = 0, totalSaved = 0;
    let byCodec = {}, optimizedCount = 0, skippedCount = 0, pendingCount = 0;
    Object.values(vaultIndex).forEach(e => {
        const cur = e.size || 0; const orig = e.originalSize || cur;
        totalCurrent += cur; totalOriginal += orig; totalSaved += Math.max(0, orig - cur);
        const codec = e.codec || 'unknown'; byCodec[codec] = (byCodec[codec] || 0) + cur;
        if (e.optimized) optimizedCount++;
        else if (e.optimizeStatus === 'skipped') skippedCount++;
        else pendingCount++;
    });
    let diskFree = null;
    try {
        const { execSync } = require('child_process');
        const drive = __dirname.split(path.sep)[0];
        const out = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`, { encoding: 'utf8' });
        const m = out.match(/FreeSpace=(\d+)/);
        if (m) diskFree = parseInt(m[1]);
    } catch {}
    return { totalOriginal, totalCurrent, totalSaved, byCodec, optimizedCount, skippedCount, pendingCount, diskFree, count: Object.keys(vaultIndex).length };
});


// ============================================================
//  ASSET GENERATION QUEUE (thumbnail + preview)
// ============================================================

const ASSET_CONCURRENCY = 1;
let assetActive = 0;
const assetQueue = [];

function queueAsset(id, type, priority = false) {
    const existingIdx = assetQueue.findIndex(a => a.id === id);
    if (existingIdx !== -1) {
        if (priority) { assetQueue.splice(existingIdx, 1); assetQueue.unshift({ id }); }
        return;
    }
    if (priority) assetQueue.unshift({ id });
    else assetQueue.push({ id });
    drainAssetQueue();
}

function drainAssetQueue() {
    if (isUserPlaying) return;
    if (assetActive >= ASSET_CONCURRENCY || !assetQueue.length) return;
    const { id } = assetQueue.shift();
    assetActive++;
    generateVaultThumbnail(id).then(() => generateVaultPreview(id)).catch(() => {})
        .finally(() => { assetActive--; drainAssetQueue(); });
}

function queueMissingAssets() {
    const ids = Object.keys(vaultIndex);
    let missingThumb = 0, missingPreview = 0;
    for (const id of ids) {
        if (!fs.existsSync(path.join(videosFolder, id + VAULT_EXT))) continue;
        if (!fs.existsSync(path.join(thumbnailsFolder, id + VAULT_THUMB))) { queueAsset(id, 'thumb'); missingThumb++; }
        if (!fs.existsSync(path.join(previewsFolder, id + VAULT_PREV))) { queueAsset(id, 'preview'); missingPreview++; }
    }
    if (missingThumb || missingPreview)
        console.log(`[Assets] Queued ${missingThumb} missing thumbs, ${missingPreview} missing previews`);
    else console.log('[Assets] All thumbnails and previews present');
}


// ============================================================
//  PLAYBACK STATE — pause encode while user is watching
// ============================================================

let isUserPlaying = false;

ipcMain.on('playback-started', () => {
    isUserPlaying = true;
    console.log('[Perf] Playback started — encode/asset generation paused');
});
ipcMain.on('playback-stopped', () => {
    isUserPlaying = false;
    console.log('[Perf] Playback stopped — resuming encode queue');
    scheduleNextEncode();
    drainAssetQueue();
});


// ============================================================
//  COMPRESSION / ENCODE SYSTEM
//  KEY FIX: Decode/encode via temp files using async streams.
//  ffmpeg process is external — never blocks Electron event loop.
//  Added IDLE scheduling: only encode when system is not busy.
// ============================================================

let encodeQueue      = [];
let currentEncodeJob = null;
let gpuAvailable     = null;

// ── How many CPU threads ffmpeg may use — leave headroom for Electron ──
// Use half CPU cores for encoding — leaves headroom for Electron UI
const ENCODE_THREADS = Math.max(1, Math.floor((os.cpus().length / 2)));

// ── GPU detection: ask ffmpeg to list encoders, check if hevc_nvenc is present ──
// Using `-encoders` is the most reliable method — no file I/O, no codec init,
// no false failures from CUDA context errors or missing output paths.
function detectGPU() {
    return new Promise(resolve => {
        // First check: is hevc_nvenc listed as an available encoder at all?
        exec('ffmpeg -hide_banner -encoders 2>&1', (err, stdout) => {
            const list = stdout || '';
            if (!list.includes('hevc_nvenc')) {
                console.log('[Encode] hevc_nvenc not in ffmpeg encoder list -> CPU encode (libx265)');
                return resolve(false);
            }

            // Second check: actually try to init hevc_nvenc with a null muxer
            // -f null means no output file at all — works on Windows and Linux
            const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
            exec(
                `ffmpeg -hide_banner -f lavfi -i nullsrc=s=64x64:r=1 -t 0.1 -c:v hevc_nvenc -f null "${nullOut}" 2>&1`,
                { timeout: 15000 },
                (err2, stdout2) => {
                    const out = stdout2 || '';
                    // These are the ONLY strings that mean nvenc genuinely failed
                    const hardFail = [
                        'Encoder hevc_nvenc not found',
                        'Unknown encoder',
                        'no such encoder',
                        'Cannot load',
                        'Failed to load',
                        'CUDA_ERROR',
                        'No CUDA capable device',
                        'Cannot open shared library',
                        'nvcuda',
                    ];
                    const failed = hardFail.some(s => out.toLowerCase().includes(s.toLowerCase()));
                    if (failed) {
                        console.log('[Encode] hevc_nvenc init failed -> CPU encode (libx265)');
                        console.log('[Encode] Reason:', out.split('\n').find(l => hardFail.some(s => l.toLowerCase().includes(s.toLowerCase()))) || 'unknown');
                        resolve(false);
                    } else {
                        console.log('[Encode] hevc_nvenc available -> GPU encode enabled');
                        resolve(true);
                    }
                }
            );
        });
    });
}

function addToEncodeQueue(vaultId) {
    const entry = vaultIndex[vaultId];
    if (!entry) return;

    // Video optimization disabled: mark as skipped/optimized immediately
    entry.optimized      = true;
    entry.optimizeStatus = 'skipped';
    saveVaultIndex();
    broadcastEncodeProgress(vaultId, 'skipped', 0);
}

function queueUnoptimizedVideos() {
    const ids = Object.keys(vaultIndex)
        .filter(id => !vaultIndex[id].optimized)
        .sort((a, b) => (vaultIndex[a].added || 0) - (vaultIndex[b].added || 0));
    console.log(`[Encode] ${ids.length} video(s) queued for optimization`);
    for (const id of ids) addToEncodeQueue(id);
}

// ── Delay encode start — give app time to load first ──
let encodeScheduled = false;
function scheduleNextEncode() {
    if (encodeScheduled || currentEncodeJob) return;
    encodeScheduled = true;
    // Wait 5 seconds between jobs so UI stays responsive
    setTimeout(() => {
        encodeScheduled = false;
        processEncodeQueue();
    }, 5000);
}

async function processEncodeQueue() {
    if (currentEncodeJob) return;
    if (!encodeQueue.length) return;

    const vaultId = encodeQueue.shift();
    if (!vaultIndex[vaultId]) { processEncodeQueue(); return; }

    currentEncodeJob = vaultId;
    await encodeVaultEntry(vaultId);
    currentEncodeJob = null;

    // Small pause between jobs — keeps app responsive
    setTimeout(() => processEncodeQueue(), 2000);
}

async function encodeVaultEntry(vaultId) {
    const entry     = vaultIndex[vaultId];
    const vaultPath = path.join(videosFolder, vaultId + VAULT_EXT);
    if (!entry || !fs.existsSync(vaultPath)) return;

    console.log(`[Encode] Starting: "${entry.title}" (${(entry.size/1024/1024).toFixed(1)} MB)`);

    entry.optimizeStatus = 'encoding';
    broadcastEncodeProgress(vaultId, 'encoding', 0);

    const ext      = entry.ext || '.mp4';
    const tmpIn    = path.join(TEMP_DIR, `lhr_enc_in_${vaultId}${ext}`);
    const tmpOut   = path.join(TEMP_DIR, `lhr_enc_out_${vaultId}.mp4`);

    try {
        // 1. Fast pre-check: probe codec + bitrate via pipe (reads only 512KB, ~150ms)
        //    Skip immediately if already HEVC, or if H.264 at low bitrate (already efficient)
        console.log(`[Encode] Probing "${entry.title}"...`);
        const probe = await getVaultProbe(vaultId, vaultPath, entry.ext || '.mp4');
        const { codec: srcCodec, bitrate: srcKbps } = probe;

        // Already HEVC — nothing to do
        if (srcCodec === 'hevc' || srcCodec === 'h265') {
            console.log(`[Encode] "${entry.title}" already H.265 — skip`);
            entry.optimized = true; entry.optimizeStatus = 'skipped'; entry.codec = 'hevc_source';
            saveVaultIndex(); broadcastEncodeProgress(vaultId, 'skipped', 0); return;
        }

        // H.264 at ≤ 1500 kbps — already well compressed, re-encoding won't help
        if ((srcCodec === 'h264' || srcCodec === 'avc') && srcKbps > 0 && srcKbps <= 2000) {
            console.log(`[Encode] "${entry.title}" H.264 @ ${srcKbps}kbps — already efficient, skip`);
            entry.optimized = true; entry.optimizeStatus = 'skipped'; entry.codec = 'h264_efficient';
            saveVaultIndex(); broadcastEncodeProgress(vaultId, 'skipped', 0); return;
        }

        // Skip if MB/min ratio too low — already heavily compressed, encode will expand
        if (entry.duration > 0) {
            const mbPerMin = (entry.size / 1024 / 1024) / (entry.duration / 60);
            if (mbPerMin < 15) {
                console.log(`[Encode] "${entry.title}" — ${mbPerMin.toFixed(1)} MB/min — too compressed to benefit, skip`);
                entry.optimized = true; entry.optimizeStatus = 'skipped'; entry.codec = 'h264_efficient';
                saveVaultIndex(); broadcastEncodeProgress(vaultId, 'skipped', 0); return;
            }
        }

        // H.264 at high bitrate, or unknown/old codec — worth compressing
        console.log(`[Encode] "${entry.title}" ${srcCodec||'unknown'} @ ${srcKbps||'?'}kbps — encoding...`);

        // 2. Decode to temp file for ffmpeg
        console.log(`[Encode] Decoding ${vaultId} via stream...`);
        await deobfuscateToTempFile(vaultPath, tmpIn);

        if (gpuAvailable === null) gpuAvailable = await detectGPU();

        // 3. Build ffmpeg args
        let ffmpegArgs;
        if (gpuAvailable) {
            // RTX NVENC — hardware encode, barely uses CPU, very fast
            ffmpegArgs = [
                '-i', tmpIn,
                '-c:v', 'hevc_nvenc',
                '-preset', 'p5',          // p5 = good quality/speed balance on RTX
                '-cq', '24',
                '-rc', 'vbr',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                tmpOut, '-y'
            ];
        } else {
            // CPU fallback — ultrafast uses ~30% of the CPU that medium uses,
            // still achieves 20-40% file size reduction vs H.264 at same CRF.
            // x265-params limits thread pool so Electron stays responsive.
            ffmpegArgs = [
                '-i', tmpIn,
                '-c:v', 'libx265',
                '-preset', 'superfast',
                '-crf', '23',
                '-threads', String(ENCODE_THREADS),
                '-x265-params', `pools=${ENCODE_THREADS}:frame-threads=1:wpp=0`,
                '-tag:v', 'hvc1',         // compatibility with more players
                '-c:a', 'copy',
                '-movflags', '+faststart',
                tmpOut, '-y'
            ];
        }

        const codec = gpuAvailable ? 'hevc_nvenc' : 'libx265';
        console.log(`[Encode] Encoding "${entry.title}" with ${codec} (threads: ${ENCODE_THREADS})...`);

        // 4. Run ffmpeg — external process, never blocks Electron
        await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', ffmpegArgs, {
                // Lower process priority on Windows
                ...(process.platform === 'win32' ? { windowsHide: true } : {})
            });

            // Lower OS priority so UI stays snappy
            if (process.platform === 'win32') {
                // IDLE_PRIORITY_CLASS = 0x40
                exec(`wmic process where ProcessId=${ff.pid} CALL setpriority "idle"`, () => {});
            } else {
                exec(`renice 19 -p ${ff.pid}`, () => {});
            }

            ff.stderr.on('data', d => {
                const line = d.toString().trim();
                const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
                if (timeMatch && entry.duration) {
                    const elapsed = parseInt(timeMatch[1])*3600 + parseInt(timeMatch[2])*60 + parseInt(timeMatch[3]);
                    const pct = Math.min(99, Math.floor((elapsed / entry.duration) * 100));
                    broadcastEncodeProgress(vaultId, 'encoding', pct);
                }
            });
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
            ff.on('error', reject);
        });

        if (!fs.existsSync(tmpOut)) throw new Error('Output file missing');
        const newStat  = fs.statSync(tmpOut);
        const oldSize  = entry.size;
        const newSize  = newStat.size;
        const savedPct = Math.round(((oldSize - newSize) / oldSize) * 100);

        console.log(`[Encode] "${entry.title}" — original: ${(oldSize/1024/1024).toFixed(1)}MB — encoded: ${(newSize/1024/1024).toFixed(1)}MB — saved: ${savedPct}%`);

        if (newSize >= oldSize * 0.95) {
            console.log(`[Encode] "${entry.title}" — no significant saving — keeping original`);
            entry.optimized      = true;
            entry.optimizeStatus = 'skipped';
            entry.codec          = codec + '_nosaving';
            saveVaultIndex();
            broadcastEncodeProgress(vaultId, 'skipped', 0);
            try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {}
            return;
        }

        // 5. Async re-obfuscate — stream-based, non-blocking
        console.log(`[Encode] "${entry.title}" — ${savedPct}% smaller`);
        await xorFileStream(tmpOut, vaultPath);

        // 6. Regenerate assets
        const dstThumb = path.join(thumbnailsFolder, vaultId + VAULT_THUMB);
        const dstPrev  = path.join(previewsFolder,   vaultId + VAULT_PREV);
        if (fs.existsSync(dstThumb)) fs.unlinkSync(dstThumb);
        if (fs.existsSync(dstPrev))  fs.unlinkSync(dstPrev);

        entry.size           = newSize;
        entry.originalSize   = oldSize;
        entry.savedPercent   = savedPct;
        entry.optimized      = true;
        entry.optimizeStatus = 'done';
        entry.codec          = codec;
        saveVaultIndex();

        broadcastEncodeProgress(vaultId, 'done', savedPct);
        console.log(`[Encode] Done: "${entry.title}" — saved ${savedPct}%`);

        generateVaultThumbnail(vaultId).catch(() => {});
        generateVaultPreview(vaultId).catch(() => {});

    } catch(e) {
        console.error(`[Encode] Failed "${entry.title}":`, e.message);
        entry.optimizeStatus = 'error';
        entry.optimized      = false;
        saveVaultIndex();
        broadcastEncodeProgress(vaultId, 'error', 0);
    } finally {
        try { fs.unlinkSync(tmpIn); }  catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
    }
}

function getVideoCodec(filePath) {
    return new Promise(resolve => {
        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
            (err, stdout) => resolve(err ? '' : stdout.trim().toLowerCase()));
    });
}

// ── Fast vault probe — codec + bitrate via pipe, reads only first 512KB ──
// Returns { codec, bitrate } in ~100-200ms with zero disk I/O.
// bitrate is in kbps (0 if unknown).
function getVaultProbe(vaultId, vaultPath, ext) {
    return new Promise(resolve => {
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        let resolved = false;
        try {
            const ffprobe = spawn('ffprobe', [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=codec_name,bit_rate',
                '-show_entries', 'format=bit_rate',
                '-of', 'json',
                '-f', extToFormat(ext),
                'pipe:0'
            ]);

            let raw = '';
            ffprobe.stdout.on('data', d => { raw += d.toString(); });
            ffprobe.on('close', () => {
                try {
                    const j = JSON.parse(raw);
                    const codec   = (j.streams?.[0]?.codec_name || '').toLowerCase();
                    // prefer stream bitrate, fall back to format bitrate
                    const bpsBuf  = j.streams?.[0]?.bit_rate || j.format?.bit_rate || '0';
                    const bitrate = Math.round(parseInt(bpsBuf, 10) / 1000); // → kbps
                    done({ codec, bitrate });
                } catch { done({ codec: '', bitrate: 0 }); }
            });
            ffprobe.on('error', () => done({ codec: '', bitrate: 0 }));
            ffprobe.stdin.on('error', () => {});

            const readStream = fs.createReadStream(vaultPath, { end: 512 * 1024 });
            const xor = createXorTransformStream(VAULT_KEY);
            xor.on('data', chunk => {
                try { if (!ffprobe.stdin.destroyed) ffprobe.stdin.write(chunk); } catch {}
            });
            xor.on('end',  () => { try { ffprobe.stdin.end();     } catch {} });
            xor.on('error',() => { try { ffprobe.stdin.end();     } catch {} done({ codec:'', bitrate:0 }); });
            readStream.pipe(xor);
            readStream.on('error', () => { try { ffprobe.stdin.destroy(); } catch {} done({ codec:'', bitrate:0 }); });
        } catch(e) { resolve({ codec: '', bitrate: 0 }); }
    });
}

// Legacy alias — still used in a few places
function getVaultCodec(vaultId, vaultPath, ext) {
    return getVaultProbe(vaultId, vaultPath, ext).then(p => p.codec);
}

function extToFormat(ext) {
    const map = { '.mp4':'mp4', '.webm':'webm', '.mkv':'matroska', '.ogg':'ogg', '.mov':'mov' };
    return map[ext.toLowerCase()] || 'mp4';
}

function broadcastEncodeProgress(vaultId, status, savedPercent) {
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('encode-progress', { vaultId, status, savedPercent });
    });
}

ipcMain.handle('encode-skip', async (event, vaultId) => {
    const idx = encodeQueue.indexOf(vaultId);
    if (idx !== -1) encodeQueue.splice(idx, 1);
    if (vaultIndex[vaultId]) {
        vaultIndex[vaultId].optimizeStatus = 'skipped';
        vaultIndex[vaultId].optimized      = true;
        saveVaultIndex();
    }
    broadcastEncodeProgress(vaultId, 'skipped', 0);
    return { ok: true };
});

ipcMain.handle('encode-queue-status', async () => ({
    queue:   encodeQueue.length,
    current: currentEncodeJob,
    gpu:     gpuAvailable
}));


// ============================================================
//  DOWNLOAD TRACKER
// ============================================================

let runningDownloads = {};
let downloadHistory  = [];

ipcMain.handle('get-downloads', () => {
    const safe = {};
    for (const [id, job] of Object.entries(runningDownloads)) {
        const { process: _p, ...rest } = job;
        safe[id] = rest;
    }
    return { running: safe, history: downloadHistory };
});


// ============================================================
//  VIDEO EDITOR — Trim, Merge, Cut
// ============================================================

ipcMain.handle('editor-get-duration', async (e, vaultId) => {
    const entry = vaultIndex[vaultId];
    if (!entry) return { ok: false, error: 'Video not found' };
    if (entry.duration && entry.duration > 0) return { ok: true, duration: entry.duration };
    try {
        const dur = await getVaultDuration(vaultId);
        if (dur > 0) { entry.duration = dur; saveVaultIndex(); }
        return { ok: true, duration: dur };
    } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('editor-trim', async (e, { vaultId, startTime, endTime, title }) => {
    const entry = vaultIndex[vaultId];
    if (!entry) return { ok: false, error: 'Video not found' };
    const vaultPath = path.join(videosFolder, vaultId + VAULT_EXT);
    if (!fs.existsSync(vaultPath)) return { ok: false, error: 'Vault file missing' };

    const ext = entry.ext || '.mp4';
    const tmpIn  = path.join(TEMP_DIR, `lhr_edit_in_${vaultId}${ext}`);
    const tmpOut = path.join(TEMP_DIR, `lhr_edit_out_${Date.now()}.mp4`);

    try {
        console.log(`[Editor] Trimming "${entry.title}" from ${startTime}s to ${endTime}s`);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'decoding', percent: 10 }));

        await deobfuscateToTempFile(vaultPath, tmpIn);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'trimming', percent: 30 }));

        // Use -ss before -i for fast seek, -to for end time
        const duration = endTime - startTime;
        await new Promise((resolve, reject) => {
            const args = [
                '-ss', String(startTime),
                '-i', tmpIn,
                '-t', String(duration),
                '-c:v', 'copy',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                '-avoid_negative_ts', 'make_zero',
                tmpOut, '-y'
            ];
            const ff = spawn('ffmpeg', args, { windowsHide: true });
            ff.stderr.on('data', () => {});
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
            ff.on('error', reject);
        });

        if (!fs.existsSync(tmpOut)) throw new Error('Output file missing');
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'saving', percent: 70 }));

        // Vault the new file
        const newId = newVaultId();
        const newVaultPath = path.join(videosFolder, newId + VAULT_EXT);
        await xorFileStream(tmpOut, newVaultPath);

        const stat = fs.statSync(newVaultPath);
        const newTitle = title || `${entry.title} (trimmed)`;
        vaultIndex[newId] = {
            title: newTitle, ext: '.mp4', duration,
            size: stat.size, originalSize: stat.size,
            added: Date.now(), optimized: true, optimizeStatus: 'skipped'
        };
        saveVaultIndex();
        queueAsset(newId, 'thumb');
        queueAsset(newId, 'preview');

        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'done', percent: 100 }));
        console.log(`[Editor] Trim complete: "${newTitle}" -> ${newId}`);
        return { ok: true, vaultId: newId, title: newTitle };
    } catch (err) {
        console.error('[Editor] Trim failed:', err.message);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'error', percent: 0 }));
        return { ok: false, error: err.message };
    } finally {
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
    }
});

ipcMain.handle('editor-crop', async (e, { vaultId, x, y, width, height, title }) => {
    const entry = vaultIndex[vaultId];
    if (!entry) return { ok: false, error: 'Video not found' };
    const vaultPath = path.join(videosFolder, vaultId + VAULT_EXT);
    if (!fs.existsSync(vaultPath)) return { ok: false, error: 'Vault file missing' };

    const ext = entry.ext || '.mp4';
    const tmpIn  = path.join(TEMP_DIR, `lhr_edit_in_${vaultId}${ext}`);
    const tmpOut = path.join(TEMP_DIR, `lhr_edit_out_${Date.now()}.mp4`);

    try {
        console.log(`[Editor] Cropping "${entry.title}" at X:${x} Y:${y} W:${width} H:${height}`);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'decoding', percent: 10 }));

        await deobfuscateToTempFile(vaultPath, tmpIn);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'trimming', percent: 30 })); // use trimming status label for cropping too

        if (gpuAvailable === null) gpuAvailable = await detectGPU();

        await new Promise((resolve, reject) => {
            const args = [
                '-i', tmpIn,
                '-vf', `crop=${width}:${height}:${x}:${y}`,
                '-c:v', gpuAvailable ? 'hevc_nvenc' : 'libx265',
                ...(gpuAvailable ? ['-preset', 'p5', '-cq', '24', '-rc', 'vbr'] : ['-preset', 'superfast', '-crf', '23', '-threads', String(ENCODE_THREADS), '-tag:v', 'hvc1']),
                '-c:a', 'copy',
                '-movflags', '+faststart',
                tmpOut, '-y'
            ];
            const ff = spawn('ffmpeg', args, { windowsHide: true });
            ff.stderr.on('data', () => {});
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
            ff.on('error', reject);
        });

        if (!fs.existsSync(tmpOut)) throw new Error('Output file missing');
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'saving', percent: 70 }));

        // Vault the new file
        const newId = newVaultId();
        const newVaultPath = path.join(videosFolder, newId + VAULT_EXT);
        await xorFileStream(tmpOut, newVaultPath);

        const stat = fs.statSync(newVaultPath);
        const newTitle = title || `${entry.title} (cropped)`;
        vaultIndex[newId] = {
            title: newTitle, ext: '.mp4', duration: entry.duration,
            size: stat.size, originalSize: stat.size,
            added: Date.now(), optimized: true, optimizeStatus: 'skipped'
        };
        saveVaultIndex();
        queueAsset(newId, 'thumb');
        queueAsset(newId, 'preview');

        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'done', percent: 100 }));
        console.log(`[Editor] Crop complete: "${newTitle}" -> ${newId}`);
        return { ok: true, vaultId: newId, title: newTitle };
    } catch (err) {
        console.error('[Editor] Crop failed:', err.message);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'error', percent: 0 }));
        return { ok: false, error: err.message };
    } finally {
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
    }
});

ipcMain.handle('editor-merge', async (e, { vaultIds, title }) => {
    if (!vaultIds || vaultIds.length < 2) return { ok: false, error: 'Need at least 2 videos to merge' };

    const tmpFiles = [];
    const concatListPath = path.join(TEMP_DIR, `lhr_concat_${Date.now()}.txt`);
    const tmpOut = path.join(TEMP_DIR, `lhr_merge_out_${Date.now()}.mp4`);

    try {
        console.log(`[Editor] Merging ${vaultIds.length} videos...`);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'decoding', percent: 10 }));

        // Step 1: Deobfuscate all input files
        const concatLines = [];
        for (let i = 0; i < vaultIds.length; i++) {
            const id = vaultIds[i];
            const entry = vaultIndex[id];
            if (!entry) throw new Error(`Video ${id} not found`);
            const vaultPath = path.join(videosFolder, id + VAULT_EXT);
            if (!fs.existsSync(vaultPath)) throw new Error(`Vault file ${id} missing`);

            const ext = entry.ext || '.mp4';
            const tmpIn = path.join(TEMP_DIR, `lhr_merge_in_${i}_${id}${ext}`);
            await deobfuscateToTempFile(vaultPath, tmpIn);
            tmpFiles.push(tmpIn);

            // Re-encode each to consistent format for concat
            const tmpNorm = path.join(TEMP_DIR, `lhr_merge_norm_${i}_${id}.ts`);
            await new Promise((resolve, reject) => {
                const args = [
                    '-i', tmpIn,
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                    '-c:a', 'aac', '-b:a', '192k',
                    '-bsf:v', 'h264_mp4toannexb',
                    '-f', 'mpegts',
                    tmpNorm, '-y'
                ];
                const ff = spawn('ffmpeg', args, { windowsHide: true });
                ff.stderr.on('data', () => {});
                ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg normalize exit ${code}`)));
                ff.on('error', reject);
            });
            tmpFiles.push(tmpNorm);
            concatLines.push(tmpNorm);

            const pct = 10 + Math.floor((i + 1) / vaultIds.length * 40);
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'preparing', percent: pct }));
        }

        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'merging', percent: 60 }));

        // Step 2: Concat using concat protocol
        const concatInput = concatLines.map(f => f.replace(/\\/g, '/')).join('|');
        await new Promise((resolve, reject) => {
            const args = [
                '-i', `concat:${concatInput}`,
                '-c:v', 'copy',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                tmpOut, '-y'
            ];
            const ff = spawn('ffmpeg', args, { windowsHide: true });
            ff.stderr.on('data', () => {});
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg concat exit ${code}`)));
            ff.on('error', reject);
        });

        if (!fs.existsSync(tmpOut)) throw new Error('Merged output file missing');
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'saving', percent: 80 }));

        // Step 3: Vault the merged file
        const newId = newVaultId();
        const newVaultPath = path.join(videosFolder, newId + VAULT_EXT);
        await xorFileStream(tmpOut, newVaultPath);

        const stat = fs.statSync(newVaultPath);
        let totalDuration = 0;
        vaultIds.forEach(id => { totalDuration += (vaultIndex[id]?.duration || 0); });

        const mergeTitle = title || 'Merged Video';
        vaultIndex[newId] = {
            title: mergeTitle, ext: '.mp4', duration: totalDuration,
            size: stat.size, originalSize: stat.size,
            added: Date.now(), optimized: true, optimizeStatus: 'skipped'
        };
        saveVaultIndex();
        queueAsset(newId, 'thumb');
        queueAsset(newId, 'preview');

        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'done', percent: 100 }));
        console.log(`[Editor] Merge complete: "${mergeTitle}" -> ${newId}`);
        return { ok: true, vaultId: newId, title: mergeTitle };
    } catch (err) {
        console.error('[Editor] Merge failed:', err.message);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'error', percent: 0 }));
        return { ok: false, error: err.message };
    } finally {
        for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
        try { fs.unlinkSync(concatListPath); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
    }
});

ipcMain.handle('editor-extract-audio', async (e, { vaultId, startTime, endTime, title, format, saveToVault }) => {
    const entry = vaultIndex[vaultId];
    if (!entry) return { ok: false, error: 'Video not found' };
    const vaultPath = path.join(videosFolder, vaultId + VAULT_EXT);
    if (!fs.existsSync(vaultPath)) return { ok: false, error: 'Vault file missing' };

    const ext = entry.ext || '.mp4';
    const audioFormat = format || 'mp3';
    const audioExt = '.' + audioFormat;
    const tmpIn  = path.join(TEMP_DIR, `lhr_audio_in_${vaultId}${ext}`);
    const tmpOut = path.join(TEMP_DIR, `lhr_audio_out_${Date.now()}${audioExt}`);

    try {
        const audioTitle = title || `${entry.title} (audio)`;
        console.log(`[Editor] Extracting audio from "${entry.title}" [${audioFormat}]`);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'decoding', percent: 10 }));

        await deobfuscateToTempFile(vaultPath, tmpIn);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'extracting', percent: 30 }));

        // Build ffmpeg args for audio extraction
        const args = [];
        const hasTrim = typeof startTime === 'number' && typeof endTime === 'number' && (startTime > 0 || endTime < (entry.duration || Infinity));

        if (hasTrim) {
            args.push('-ss', String(startTime));
        }
        args.push('-i', tmpIn);
        if (hasTrim) {
            args.push('-t', String(endTime - startTime));
        }
        args.push('-vn'); // no video

        // Codec settings per format
        if (audioFormat === 'mp3') {
            args.push('-codec:a', 'libmp3lame', '-q:a', '2');
        } else if (audioFormat === 'aac') {
            args.push('-codec:a', 'aac', '-b:a', '192k');
        } else if (audioFormat === 'flac') {
            args.push('-codec:a', 'flac');
        } else if (audioFormat === 'wav') {
            args.push('-codec:a', 'pcm_s16le');
        } else {
            args.push('-codec:a', 'libmp3lame', '-q:a', '2');
        }

        args.push(tmpOut, '-y');

        await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', args, { windowsHide: true });
            ff.stderr.on('data', () => {});
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
            ff.on('error', reject);
        });

        if (!fs.existsSync(tmpOut)) throw new Error('Output audio file missing');
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'saving', percent: 70 }));

        let resultPath = null;

        if (saveToVault !== false) {
            // Save to music vault
            const musicId = newVaultId();
            const musicDst = path.join(musicsFolder, musicId + '.lhrm');
            await xorFileStream(tmpOut, musicDst);

            const musicIndexPath = path.join(baseDataDir, 'music.json');
            let musicIndex = {};
            if (fs.existsSync(musicIndexPath)) {
                try { musicIndex = JSON.parse(fs.readFileSync(musicIndexPath, 'utf-8')); } catch {}
            }
            musicIndex[musicId] = { title: audioTitle, ext: audioExt, added: Date.now() };
            fs.writeFileSync(musicIndexPath, JSON.stringify(musicIndex, null, 2));
            console.log(`[Editor] Audio saved to music vault: "${audioTitle}" -> ${musicId}`);
            resultPath = 'vault';
        } else {
            // Export to file — show save dialog
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
                const { canceled, filePath: savePath } = await dialog.showSaveDialog(win, {
                    title: 'Save Extracted Audio',
                    defaultPath: `${audioTitle}${audioExt}`,
                    filters: [{ name: 'Audio Files', extensions: [audioFormat] }]
                });
                if (!canceled && savePath) {
                    fs.copyFileSync(tmpOut, savePath);
                    resultPath = savePath;
                    console.log(`[Editor] Audio exported to: ${savePath}`);
                }
            }
        }

        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'done', percent: 100 }));
        return { ok: true, title: audioTitle, path: resultPath };
    } catch (err) {
        console.error('[Editor] Audio extraction failed:', err.message);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('editor-progress', { status: 'error', percent: 0 }));
        return { ok: false, error: err.message };
    } finally {
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
    }
});


// ============================================================
//  NAVIGATION
// ============================================================

ipcMain.on('open-browser', () => mainWindow?.loadFile('browser.html'));
ipcMain.on('go-home',      () => mainWindow?.loadFile('index.html'));
ipcMain.on('logout',       () => mainWindow?.loadFile('login.html'));
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => { mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize(); });
ipcMain.on('win-close',    () => mainWindow?.close());
ipcMain.on('is-test-runner', (event) => {
    event.returnValue = process.argv.includes('--run-test');
});


// ============================================================
//  WINDOW
// ============================================================

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480, height: 900,
        autoHideMenuBar: true,
        frame: false, titleBarStyle: 'hidden',
        backgroundColor: '#f0e6ff',
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
            webviewTag:       true,
            sandbox:          false,
            spellcheck:       false
        }
    });

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[Renderer Console] ${message} (at ${path.basename(sourceId)}:${line})`);
    });

    const { session } = require('electron');
    session.defaultSession.setProxy({ mode: 'direct' }).catch(() => {});

    loadVaultIndex();
    loadPlaylists();
    ensureStreamServer();

    // ── Wipe any lhr_* temp files left over from a previous crash ──
    try {
        const stale = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith('lhr_'));
        for (const f of stale) { try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {} }
        if (stale.length) console.log(`[Startup] Cleaned ${stale.length} stale temp files`);
    } catch {}

    // Stagger startup tasks — let UI load first
    setTimeout(async () => {
        await migrateToVault();
    }, 2000);

    // Queue compression only after app is fully up
    setTimeout(() => {
        queueUnoptimizedVideos();
    }, 10000);

    // Scan for missing thumbnails/previews after encode queue
    setTimeout(() => {
        queueMissingAssets();
    }, 15000);

    mainWindow.loadFile('login.html').then(() => {
        mainWindow.webContents.executeJavaScript("localStorage.removeItem('run_test');");
    }).catch(e => console.error('Failed to load login.html:', e));

    // Block Ctrl+R / F5 from reloading the app pages
    mainWindow.webContents.on('before-input-event', (event, input) => {
        const isReload = (input.control && input.key.toLowerCase() === 'r') ||
                         (input.key === 'F5') ||
                         (input.control && input.key.toLowerCase() === 'shift+r');
        if (isReload) {
            event.preventDefault();
        }
    });
}

app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(({ url, disposition }) => {
        mainWindow?.webContents.send('open-new-tab', url, disposition);
        return { action: 'deny' };
    });
});

app.whenReady().then(() => {
    setupStreamSniffer();
    Menu.setApplicationMenu(null);
    createWindow();
    launchTor();

    const { session } = require('electron');
    session.defaultSession.on('will-download', (event, item, webContents) => {
        const filename = item.getFilename();
        const ext = path.extname(filename).toLowerCase();
        
        if (['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)) {
            const tempPath = path.join(TEMP_DIR, 'mus_dl_' + Date.now() + '_' + filename);
            item.setSavePath(tempPath);
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('music-download-started', filename));
            item.once('done', (event, state) => {
                if (state === 'completed') {
                    vaultMusicFile(tempPath, filename);
                    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('music-download-completed', filename));
                } else {
                    try { fs.unlinkSync(tempPath); } catch (e) {}
                    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('music-download-failed', filename));
                }
            });
        }
    });

    // Auto-sweep manually dropped videos in the videos & stage folder
    setTimeout(async () => {
        try {
            const mediaExts = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.ogg'];
            const toVault = [];
            for (const folder of [videosFolder, STAGE_FOLDER]) {
                if (!fs.existsSync(folder)) continue;
                for (const f of fs.readdirSync(folder)) {
                    const ext = path.extname(f).toLowerCase();
                    if (mediaExts.includes(ext)) toVault.push({ folder, f, ext });
                }
            }
            if (!toVault.length) { console.log('[Sweep] No plain videos found'); return; }
            console.log(`[Sweep] Found ${toVault.length} plain video(s) — importing sequentially...`);
            for (const { folder, f, ext } of toVault) {
                const srcPath = path.join(folder, f);
                const title = path.parse(f).name;
                const id = newVaultId();
                const dst = path.join(videosFolder, id + VAULT_EXT);
                try {
                    const srcStat = fs.statSync(srcPath);
                    console.log(`[Sweep] Vaulting "${title}" (${(srcStat.size / 1024 / 1024).toFixed(1)} MB)...`);
                    await xorFileStream(srcPath, dst);
                    const dstStat = fs.statSync(dst);
                    const duration = await getVideoDuration(srcPath).catch(() => 0);
                    vaultIndex[id] = { title, ext, duration, size: dstStat.size, originalSize: srcStat.size, added: Date.now(), optimized: false, optimizeStatus: 'queued' };
                    saveVaultIndex();
                    const tryDelete = (attempts = 0) => { try { if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath); } catch (e) { if (attempts < 10) setTimeout(() => tryDelete(attempts + 1), 1000); } };
                    tryDelete();
                    queueAsset(id, 'thumb');
                    queueAsset(id, 'preview');
                    addToEncodeQueue(id);
                    console.log(`[Sweep] Vaulted "${title}" -> ${id + VAULT_EXT}`);
                } catch (e) {
                    console.error(`[Sweep] Failed "${title}":`, e.message);
                    try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch {}
                }
            }
            console.log('[Sweep] All plain videos imported');
        } catch (e) { console.warn('[Sweep] Error:', e.message); }
    }, 3000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });


// ============================================================
//  VIDEO HELPERS
// ============================================================

function getVideoDuration(videoPath) {
    return new Promise(resolve => {
        // -v quiet suppresses the ">2 GiB" warning ffprobe emits on large files.
        // Parse stdout regardless of exit code — ffprobe exits non-zero when it
        // emits warnings but still writes a valid duration.
        exec(`ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
            (err, stdout, stderr) => {
                const parsed = Math.floor(parseFloat(stdout));
                if (parsed > 0) { resolve(parsed); return; }
                // Fallback: parse Duration from stderr (handles some ffprobe builds)
                const m = (stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+)/);
                resolve(m ? parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]) : 0);
            });
    });
}

function generateThumbnail(videoPath, thumbnailPath, duration) {
    return new Promise(resolve => {
        // Choose a timestamp that is not 0.49 (to avoid black frames).
        // For video files, we want to capture a frame from the actual video.
        // Let's use 10% of the duration, capped at 30 seconds, to skip intro logos or black screens.
        // If duration is very short (under 10s), we seek to 20% of duration.
        let ts = 5;
        if (duration && duration > 0) {
            if (duration < 10) {
                ts = duration * 0.2;
            } else {
                ts = Math.min(30, duration * 0.1);
            }
        }
        ts = parseFloat(ts.toFixed(2));

        console.log(`[Thumbnail] Generating thumbnail for ${videoPath} at seek time ${ts}s (duration: ${duration}s)`);

        // Attempt 1: Fast seeking (fast seek using -ss before -i is faster but might fail or be slightly inaccurate)
        exec(`ffmpeg -ss ${ts} -i "${videoPath}" -frames:v 1 -q:v 2 "${thumbnailPath}" -y`, (err) => {
            if (!err && fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
                resolve(true);
                return;
            }

            console.warn(`[Thumbnail] Fast seeking failed at ts ${ts}s, retrying with slow seeking...`);

            // Attempt 2: Slow seeking (accurate seek, -ss after -i)
            exec(`ffmpeg -i "${videoPath}" -ss ${ts} -frames:v 1 -q:v 2 "${thumbnailPath}" -y`, (err2) => {
                if (!err2 && fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
                    resolve(true);
                    return;
                }

                console.warn(`[Thumbnail] Slow seeking failed at ts ${ts}s, retrying at start (ts=0)...`);

                // Attempt 3: Seek to start (ts = 0)
                exec(`ffmpeg -i "${videoPath}" -frames:v 1 -q:v 2 "${thumbnailPath}" -y`, (err3) => {
                    if (!err3 && fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
                        resolve(true);
                    } else {
                        console.error(`[Thumbnail] All attempts to generate thumbnail for ${videoPath} failed.`);
                        resolve(false);
                    }
                });
            });
        });
    });
}

ipcMain.handle('select-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
});


// ============================================================
//  DOWNLOAD CONTROL
// ============================================================

ipcMain.on('pause-download', (e, id) => {
    const job = runningDownloads[id]; if (!job?.process) return;
    if (process.platform === 'win32') job.status = 'paused';
    else { job.process.kill('SIGSTOP'); job.status = 'paused'; }
});
ipcMain.on('resume-download', (e, id) => {
    const job = runningDownloads[id]; if (!job?.process) return;
    if (process.platform === 'win32') job.status = 'downloading';
    else { job.process.kill('SIGCONT'); job.status = 'downloading'; }
});
ipcMain.on('cancel-download', (e, id) => {
    const job = runningDownloads[id]; if (!job) return;
    job.process?.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    downloadHistory.push({ id: job.id, url: job.url, finished: Date.now(), progress: job.progress||'0%', status: 'cancelled' });
    delete runningDownloads[id];
    activeDownloads = Math.max(0, activeDownloads - 1);
    processQueue();
});

// ============================================================
//  DOWNLOAD SYSTEM
// ============================================================



ipcMain.handle('download-video', async (event, videoUrl, playlistId = null) => {
    console.log('[Download Video IPC] Received request for URL:', videoUrl, 'playlist:', playlistId);
    if (!videoUrl) return { started: false };
    let queueIdx = null;
    if (playlistId && playlistsData[playlistId]) {
        const pl = playlistsData[playlistId];
        if (!pl.downloadQueue) pl.downloadQueue = [];
        queueIdx = pl.downloadQueue.length;
        pl.downloadQueue.push({ url: videoUrl, title: 'Detecting...', order: pl.videos.length, status: 'queued', addedAt: Date.now() });
        savePlaylists();
    }
    downloadQueue.push({ videoUrl, filePath: path.join(STAGE_FOLDER, '%(title)s.%(ext)s'), _playlistId: playlistId, _queueIdx: queueIdx });
    processQueue();
    return { started: true };
});

function processQueue() {
    console.log('[Process Queue] Checking queue... Active downloads:', activeDownloads, 'Queue length:', downloadQueue.length);
    const playlistCounts = {};
    for (const dl of Object.values(runningDownloads)) {
        if (dl.playlistId) {
            playlistCounts[dl.playlistId] = (playlistCounts[dl.playlistId] || 0) + 1;
        }
    }
    const deferred = [];
    while (activeDownloads < MAX_PARALLEL && downloadQueue.length > 0) {
        const item = downloadQueue.shift();
        if (item._playlistId) {
            if (playlistCounts[item._playlistId] >= 10) { deferred.push(item); continue; }
            playlistCounts[item._playlistId] = (playlistCounts[item._playlistId] || 0) + 1;
        }
        console.log('[Process Queue] Dispatching download for:', item.videoUrl);
        startDownload(item.videoUrl, item.filePath, 0, item._playlistId, item._queueIdx);
    }
    if (deferred.length > 0) downloadQueue.unshift(...deferred);
}

function getHostname(url) { try { return new URL(url).hostname; } catch { return null; } }

function findCookieFile(domain) {
    if (!domain) return null;
    const mapped = getCookieFilename(domain);
    for (const name of [mapped + '.txt', domain.replace(/^www\./, '') + '.txt']) {
        const p = path.join(baseDataDir, 'cookies', name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// ── Export Electron session cookies to a temp Netscape cookie file for yt-dlp ──
// This avoids the DPAPI decryption issue with --cookies-from-browser entirely,
// and uses the actual cookies from the user's in-app browsing session.
async function exportSessionCookies(domain) {
    try {
        const { session } = require('electron');
        const allCookies = await session.defaultSession.cookies.get({});
        // Filter cookies relevant to this domain (including parent domains)
        const bareDomain = (domain || '').replace(/^www\./, '');
        const relevant = allCookies.filter(c => {
            const cd = (c.domain || '').replace(/^\./, '');
            return cd === bareDomain || cd === 'www.' + bareDomain || bareDomain.endsWith('.' + cd);
        });
        if (!relevant.length) return null;

        // Build Netscape cookie file format
        const lines = ['# Netscape HTTP Cookie File', '# Exported from Electron session', ''];
        for (const c of relevant) {
            const domain_str = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
            const flag       = 'TRUE';
            const path_str   = c.path || '/';
            const secure     = c.secure ? 'TRUE' : 'FALSE';
            const expiry     = c.expirationDate ? Math.floor(c.expirationDate) : '0';
            const name       = c.name;
            const value      = c.value;
            lines.push(`${domain_str}\t${flag}\t${path_str}\t${secure}\t${expiry}\t${name}\t${value}`);
        }
        const tmpFile = path.join(TEMP_DIR, `cookies_${bareDomain.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, lines.join('\n'), 'utf-8');
        console.log(`[Cookies] Exported ${relevant.length} session cookies for ${bareDomain} -> ${tmpFile}`);
        return tmpFile;
    } catch (e) {
        console.warn('[Cookies] Failed to export session cookies:', e.message);
        return null;
    }
}

// ============================================================
//  LECTURE & MEDIA STREAM CAPTURE SYSTEM (HLS / M3U8 / Segments)
// ============================================================

const hlsCapturedM3u8 = {};
const segCapturedUrls = {};
const genericMediaCapturedUrls = {};

ipcMain.handle('stream-capture-m3u8', (e, pageUrl, m3u8Urls) => {
    if (pageUrl && Array.isArray(m3u8Urls) && m3u8Urls.length) {
        if (!hlsCapturedM3u8[pageUrl]) hlsCapturedM3u8[pageUrl] = [];
        m3u8Urls.forEach(u => {
            if (!hlsCapturedM3u8[pageUrl].includes(u)) {
                hlsCapturedM3u8[pageUrl].push(u);
                console.log(`[Stream Capture] Captured HLS M3U8: ${u}`);
            }
        });
        if (!hlsCapturedM3u8['global']) hlsCapturedM3u8['global'] = [];
        m3u8Urls.forEach(u => {
            if (!hlsCapturedM3u8['global'].includes(u)) hlsCapturedM3u8['global'].push(u);
        });
    }
    return { ok: true };
});

ipcMain.handle('stream-capture-seg', (e, pageUrl, segUrls) => {
    if (pageUrl && Array.isArray(segUrls) && segUrls.length) {
        if (!segCapturedUrls[pageUrl]) segCapturedUrls[pageUrl] = [];
        segUrls.forEach(u => {
            if (!segCapturedUrls[pageUrl].includes(u)) {
                segCapturedUrls[pageUrl].push(u);
                console.log(`[Stream Capture] Captured stream segment: ${u}`);
            }
        });
        if (!segCapturedUrls['global']) segCapturedUrls['global'] = [];
        segUrls.forEach(u => {
            if (!segCapturedUrls['global'].includes(u)) segCapturedUrls['global'].push(u);
        });
    }
    return { ok: true };
});

ipcMain.handle('stream-capture-media', (e, pageUrl, urls) => {
    if (pageUrl && Array.isArray(urls) && urls.length) {
        if (!genericMediaCapturedUrls[pageUrl]) genericMediaCapturedUrls[pageUrl] = [];
        urls.forEach(u => {
            if (!genericMediaCapturedUrls[pageUrl].includes(u)) {
                genericMediaCapturedUrls[pageUrl].push(u);
                console.log(`[Stream Capture] Captured media URL: ${u}`);
            }
        });
        if (!genericMediaCapturedUrls['global']) genericMediaCapturedUrls['global'] = [];
        urls.forEach(u => {
            if (!genericMediaCapturedUrls['global'].includes(u)) genericMediaCapturedUrls['global'].push(u);
        });
    }
    return { ok: true };
});

function setupStreamSniffer() {
    const { session } = require('electron');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*.m3u8*', '*://*/*.mp4*', '*://*/*.webm*'] }, (details, callback) => {
        const url = details.url;
        const refers = details.referrer || '';
        let pageUrl = refers.split('?')[0].split('#')[0];
        if (pageUrl.endsWith('/')) pageUrl = pageUrl.slice(0, -1);
        
        if (url.includes('.m3u8')) {
            if (!hlsCapturedM3u8[pageUrl]) hlsCapturedM3u8[pageUrl] = [];
            if (!hlsCapturedM3u8[pageUrl].includes(url)) {
                hlsCapturedM3u8[pageUrl].push(url);
                console.log(`[HLS Sniffer] Captured: ${url}`);
            }
            if (!hlsCapturedM3u8['global']) hlsCapturedM3u8['global'] = [];
            if (!hlsCapturedM3u8['global'].includes(url)) hlsCapturedM3u8['global'].push(url);
        } else if (url.includes('/seg-') || url.includes('.mp4/seg-')) {
            if (!segCapturedUrls[pageUrl]) segCapturedUrls[pageUrl] = [];
            if (!segCapturedUrls[pageUrl].includes(url)) {
                segCapturedUrls[pageUrl].push(url);
                console.log(`[Segment Sniffer] Captured: ${url}`);
            }
            if (!segCapturedUrls['global']) segCapturedUrls['global'] = [];
            if (!segCapturedUrls['global'].includes(url)) segCapturedUrls['global'].push(url);
        } else if (url.match(/\.(mp4|webm|m4v)($|\?)/i)) {
            if (!genericMediaCapturedUrls[pageUrl]) genericMediaCapturedUrls[pageUrl] = [];
            if (!genericMediaCapturedUrls[pageUrl].includes(url)) {
                genericMediaCapturedUrls[pageUrl].push(url);
                console.log(`[Media Sniffer] Captured: ${url}`);
            }
            if (!genericMediaCapturedUrls['global']) genericMediaCapturedUrls['global'] = [];
            if (!genericMediaCapturedUrls['global'].includes(url)) genericMediaCapturedUrls['global'].push(url);
        }
        callback({});
    });
}

const STREAM_RES_RANK = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];
function streamResRank(url) { for (let i = STREAM_RES_RANK.length - 1; i >= 0; i--) { if (url.includes(STREAM_RES_RANK[i])) return i; } return -1; }
function pickBestM3u8(urls) { return urls.slice().sort((a, b) => streamResRank(b) - streamResRank(a))[0]; }

async function startHlsStreamDownload(pageUrl, downloadId) {
    if (!runningDownloads[downloadId]) return;
    console.log(`[HLS Stream DL ${downloadId}] Starting download via yt-dlp with sniffed manifest.`);
    runningDownloads[downloadId].status = 'Finding lecture manifest…';
    try {
        let m3u8Urls = hlsCapturedM3u8[pageUrl] || [];
        if (!m3u8Urls.length && hlsCapturedM3u8['global']) m3u8Urls = hlsCapturedM3u8['global'];
        if (!m3u8Urls.length) throw new Error('No stream manifests sniffed. Please play the video lecture first.');
        const bestUrl = pickBestM3u8(m3u8Urls);
        console.log(`[HLS Stream DL ${downloadId}] Targeted manifest:`, bestUrl);
        const filePath = path.join(STAGE_FOLDER, `lecture_stream_${downloadId}.mp4`);
        const args = ['--newline', '--merge-output-format', 'mp4', '--no-check-certificates', '--geo-bypass', '--referer', pageUrl, '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', '-o', filePath, bestUrl];
        if (activeProxyUrl) { args.push('--proxy', activeProxyUrl); }
        const ytDlp = spawn('yt-dlp', args);
        runningDownloads[downloadId].process = ytDlp;
        runningDownloads[downloadId].status = 'downloading';
        ytDlp.stdout.on('data', d => console.log(`[Stream DL ${downloadId}]`, d.toString().trim()));
        ytDlp.stderr.on('data', data => {
            const text = data.toString().trim(); if (!text) return;
            const dl = text.match(/\[download\]\s+([\d.]+)%/i);
            if (dl && runningDownloads[downloadId]) runningDownloads[downloadId].progress = dl[1] + '%';
        });
        ytDlp.on('close', code => {
            const job = runningDownloads[downloadId];
            if (code === 0 && fs.existsSync(filePath)) {
                vaultDownloadedFile(filePath, 'lecture_' + Date.now(), job?.playlistId, job?.queueIdx);
                downloadHistory.push({ id: downloadId, url: pageUrl, finished: Date.now(), progress: '100%', status: 'done' });
                delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue();
            } else {
                if (job && !job.forced && (job.retry || 0) < 2) { startDownload(pageUrl, job.filePath, (job.retry || 0) + 1, job.playlistId, job.queueIdx); }
                else { downloadHistory.push({ id: downloadId, url: pageUrl, finished: Date.now(), progress: '0%', status: 'error' }); delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue(); }
            }
        });
    } catch (err) {
        console.error(`[Stream DL ${downloadId}] Failed:`, err.message);
        if (runningDownloads[downloadId]) runningDownloads[downloadId].status = 'error: ' + err.message;
        delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue();
    }
}

async function startGenericSniffedDownload(pageUrl, downloadId) {
    if (!runningDownloads[downloadId]) return;
    console.log(`[Sniffed DL ${downloadId}] Starting download via yt-dlp with sniffed URL.`);
    runningDownloads[downloadId].status = 'Finding media URL…';
    try {
        let urls = [];
        if (genericMediaCapturedUrls[pageUrl] && genericMediaCapturedUrls[pageUrl].length) urls = urls.concat(genericMediaCapturedUrls[pageUrl]);
        if (hlsCapturedM3u8[pageUrl] && hlsCapturedM3u8[pageUrl].length) urls = urls.concat(hlsCapturedM3u8[pageUrl]);
        if (!urls.length && genericMediaCapturedUrls['global']) urls = urls.concat(genericMediaCapturedUrls['global']);
        if (!urls.length && hlsCapturedM3u8['global']) urls = urls.concat(hlsCapturedM3u8['global']);
        
        if (!urls.length) throw new Error('No media URL sniffed. Please play the video lecture first.');
        const bestUrl = urls[urls.length - 1];
        
        console.log(`[Sniffed DL ${downloadId}] Targeted URL:`, bestUrl);
        const filePath = path.join(STAGE_FOLDER, `video_${downloadId}.mp4`);
        const args = ['--newline', '--merge-output-format', 'mp4', '--no-check-certificates', '--geo-bypass', '--referer', pageUrl, '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', '-o', filePath, bestUrl];
        if (activeProxyUrl) { args.push('--proxy', activeProxyUrl); }
        const ytDlp = spawn('yt-dlp', args);
        runningDownloads[downloadId].process = ytDlp;
        runningDownloads[downloadId].status = 'downloading';
        ytDlp.stdout.on('data', d => console.log(`[Sniffed DL ${downloadId}]`, d.toString().trim()));
        ytDlp.stderr.on('data', data => {
            const text = data.toString().trim(); if (!text || !runningDownloads[downloadId]) return;
            const dl = text.match(/\[download\]\s+([\d.]+)%/i);
            if (dl) runningDownloads[downloadId].progress = dl[1] + '%';
        });
        ytDlp.on('close', code => {
            const job = runningDownloads[downloadId];
            if (code === 0 && fs.existsSync(filePath)) {
                vaultDownloadedFile(filePath, 'lecture_' + Date.now(), job?.playlistId, job?.queueIdx);
                downloadHistory.push({ id: downloadId, url: pageUrl, finished: Date.now(), progress: '100%', status: 'done' });
                delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue();
            } else {
                if (job && !job.forced && (job.retry || 0) < 2) { startDownload(pageUrl, job.filePath, (job.retry || 0) + 1, job.playlistId, job.queueIdx); }
                else { downloadHistory.push({ id: downloadId, url: pageUrl, finished: Date.now(), progress: '0%', status: 'error' }); delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue(); }
            }
        });
    } catch (err) {
        console.error(`[Sniffed DL ${downloadId}] Failed:`, err.message);
        if (runningDownloads[downloadId]) runningDownloads[downloadId].status = 'error: ' + err.message;
        delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue();
    }
}

async function startDownload(videoUrl, filePath, retryLevel = 0, playlistId = null, queueIdx = null) {
    if (retryLevel === 0) { activeDownloads++; downloadCounter++; }
    const downloadId = downloadCounter;
    console.log(`[DL ${downloadId}]`, videoUrl, `(level ${retryLevel})`);

    // If stream manifests were specifically captured for this URL and direct failed:
    if (retryLevel > 0 && hlsCapturedM3u8[videoUrl]?.length) {
        runningDownloads[downloadId] = { id: downloadId, url: videoUrl, status: 'retrying (HLS Stream)', progress: '0%', speed: '--', eta: '--', started: Date.now(), process: null, retry: retryLevel, playlistId, queueIdx };
        startHlsStreamDownload(videoUrl, downloadId); return;
    }
    if (retryLevel > 0 && genericMediaCapturedUrls[videoUrl]?.length) {
        runningDownloads[downloadId] = { id: downloadId, url: videoUrl, status: 'retrying (Direct Stream)', progress: '0%', speed: '--', eta: '--', started: Date.now(), process: null, retry: retryLevel, playlistId, queueIdx };
        startGenericSniffedDownload(videoUrl, downloadId); return;
    }

    const domain = getHostname(videoUrl);
    const cookiePath = findCookieFile(domain || '');
    const args = [
        '--newline', '--no-playlist', '--merge-output-format', 'mp4',
        '--referer', videoUrl,
        '--add-header', `Origin:${new URL(videoUrl).origin}`,
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        '--hls-prefer-native',
        '--no-check-certificates', '--geo-bypass',
        '--js-runtimes', 'node',
        '-f', 'bestvideo+bestaudio/best', '-o', filePath, videoUrl
    ];

    // Cookie strategy: manual file > Electron session export > no cookies
    // Never use --cookies-from-browser (DPAPI decryption fails on modern Chrome/Edge)
    let tmpCookieFile = null;
    if (cookiePath) {
        args.unshift('--cookies', cookiePath);
    } else {
        // Export cookies from Electron's own browsing session
        tmpCookieFile = await exportSessionCookies(domain || '');
        if (tmpCookieFile) {
            args.unshift('--cookies', tmpCookieFile);
        }
    }
    if (activeProxyUrl) {
        args.push('--proxy', activeProxyUrl);
    }

    const ytDlp = spawn('yt-dlp', args);
    runningDownloads[downloadId] = {
        id: downloadId, url: videoUrl,
        status: 'starting', progress: '0%', speed: '--', eta: '--',
        started: Date.now(), process: ytDlp,
        filePath, playlistId, queueIdx, retry: retryLevel
    };

    let dlFile = null, dlTitle = null;

    const handleOutput = (data) => {
        const text = data.toString().trim();
        if (!runningDownloads[downloadId]) return;

        const dest  = text.match(/\[download\] Destination: (.+)/);
        const merge = text.match(/\[Merger\] Merging formats into "(.+?)"/);
        const move  = text.match(/\[MoveFiles\] Moving file .(.+?)./);
        if (dest)  { dlFile = dest[1].trim();  dlTitle = path.parse(dlFile).name; }
        if (merge) { dlFile = merge[1].trim(); dlTitle = path.parse(dlFile).name; }
        if (move)  { dlFile = move[1].trim();  dlTitle = path.parse(dlFile).name; }

        const dl = text.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+[a-zA-Z]+)\s+at\s+([^ ]+)\s+ETA\s+([^ ]+)/i);
        if (dl) {
            Object.assign(runningDownloads[downloadId], { progress: dl[1]+'%', speed: dl[3], eta: dl[4], status: 'downloading' });
        } else {
            const pct = text.match(/\[download\]\s+(\d+\.?\d*)%/);
            if (pct && runningDownloads[downloadId].status !== 'paused') {
                runningDownloads[downloadId].progress = pct[1]+'%';
                if (pct[1]==='100') { runningDownloads[downloadId].speed='--'; runningDownloads[downloadId].eta='done'; }
            } else if (runningDownloads[downloadId].status !== 'paused') {
                const clean = text.replace(/^\[.*?\]\s*/, '').trim();
                if (clean) runningDownloads[downloadId].status = clean.substring(0,60);
            }
        }
    };

    ytDlp.stdout.on('data', d => {
        console.log(`[DL ${downloadId}] stdout:`, d.toString().trim());
        handleOutput(d);
    });
    ytDlp.stderr.on('data', data => {
        console.log(`[DL ${downloadId}] stderr:`, data.toString().trim());
        handleOutput(data);
    });

    ytDlp.on('close', code => {
        console.log(`[DL ${downloadId}] Exit`, code);
        // Clean up temp cookie file
        if (tmpCookieFile) { try { fs.unlinkSync(tmpCookieFile); } catch {} }
        if (!runningDownloads[downloadId]) return;
        const job = runningDownloads[downloadId];

        if (code === 0) {
            if (!dlFile || !fs.existsSync(dlFile)) {
                try {
                    const newest = fs.readdirSync(STAGE_FOLDER)
                        .filter(f => ['.mp4','.webm','.mkv','.ogg'].includes(path.extname(f).toLowerCase()))
                        .map(f => ({ f, t: fs.statSync(path.join(STAGE_FOLDER, f)).mtimeMs }))
                        .sort((a, b) => b.t - a.t)[0];
                    if (newest && Date.now() - newest.t < 60000) { dlFile = path.join(STAGE_FOLDER, newest.f); dlTitle = path.parse(newest.f).name; }
                } catch {}
            }
            if (dlFile && fs.existsSync(dlFile)) vaultDownloadedFile(dlFile, dlTitle, job?.playlistId, job?.queueIdx);
            downloadHistory.push({ id: downloadId, url: videoUrl, finished: Date.now(), progress: '100%', status: 'done' });
            delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue();
        } else {
            if (job && !job.forced && (job.retry || 0) < 2) {
                const nextLevel = (job.retry || 0) + 1;
                console.log(`[DL ${downloadId}] Failed code ${code}, retrying level ${nextLevel}...`);
                startDownload(videoUrl, job.filePath, nextLevel, job.playlistId, job.queueIdx);
            } else if (job && !job.forced && ((genericMp4CapturedUrls[videoUrl] && genericMp4CapturedUrls[videoUrl].length) || (phCapturedM3u8[videoUrl] && phCapturedM3u8[videoUrl].length))) {
                console.log(`[DL ${downloadId}] All standard retries failed. Falling back to sniffed URL...`);
                startGenericSniffedDownload(videoUrl, downloadId);
            } else {
                if (job?.playlistId && playlistsData[job.playlistId]?.downloadQueue?.[job.queueIdx]) { playlistsData[job.playlistId].downloadQueue[job.queueIdx].status = 'error'; savePlaylists(); }
                downloadHistory.push({ id: downloadId, url: videoUrl, finished: Date.now(), progress: job?.progress || '0%', status: 'error' });
                delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue();
            }
        }
    });

    ytDlp.on('error', err => {
        console.error(`[DL ${downloadId}] Error:`, err);
        // Clean up temp cookie file
        if (tmpCookieFile) { try { fs.unlinkSync(tmpCookieFile); } catch {} }
        if (!runningDownloads[downloadId]) return;
        const job = runningDownloads[downloadId];
        if (job && !job.forced && (job.retry || 0) < 2) {
            const nextLevel = (job.retry || 0) + 1;
            console.log(`[DL ${downloadId}] Failed, retrying level ${nextLevel}...`);
            startDownload(videoUrl, job.filePath, nextLevel, job.playlistId, job.queueIdx);
        } else if (job && !job.forced && ((genericMp4CapturedUrls[videoUrl] && genericMp4CapturedUrls[videoUrl].length) || (phCapturedM3u8[videoUrl] && phCapturedM3u8[videoUrl].length))) {
            console.log(`[DL ${downloadId}] All standard retries failed. Falling back to sniffed URL...`);
            startGenericSniffedDownload(videoUrl, downloadId);
        } else {
            if (job?.playlistId && playlistsData[job.playlistId]?.downloadQueue?.[job.queueIdx]) { playlistsData[job.playlistId].downloadQueue[job.queueIdx].status = 'error'; savePlaylists(); }
            downloadHistory.push({ id: downloadId, url: videoUrl, finished: Date.now(), progress: job?.progress || '0%', status: 'error' });
            delete runningDownloads[downloadId]; activeDownloads = Math.max(0, activeDownloads - 1); processQueue();
        }
    });
}


// ============================================================
//  PROXY / VPN
// ============================================================

function testProxyReachable(host, port, timeoutMs = 3000) {
    return new Promise(resolve => {
        const s = new net.Socket(); let done = false;
        const fin = ok => { if (done) return; done = true; s.destroy(); resolve(ok); };
        s.setTimeout(timeoutMs);
        s.connect(port, host, () => fin(true));
        s.on('error',   () => fin(false));
        s.on('timeout', () => fin(false));
    });
}

function parseProxyUrl(proxyUrl) {
    try { const m = proxyUrl.match(/^(?:\w+:\/\/)?([^:]+):(\d+)$/); if (m) return { host: m[1], port: parseInt(m[2]) }; } catch {}
    return null;
}

ipcMain.handle('set-proxy', async (event, proxyUrl) => {
    try {
        const { session } = require('electron');
        if (proxyUrl === 'direct://') {
            await session.defaultSession.setProxy({ mode: 'direct' });
            activeProxyUrl = null;
            return { ok: true };
        }
        const parsed = parseProxyUrl(proxyUrl);
        if (parsed && !await testProxyReachable(parsed.host, parsed.port))
            return { ok: false, reason: 'unreachable' };
        await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: proxyUrl });
        activeProxyUrl = proxyUrl;
        return { ok: true };
    } catch(e) { return { ok: false, reason: 'error' }; }
});


// ============================================================
//  TOR AUTO-LAUNCH
// ============================================================

let torProcess        = null;
let portForwardServer = null;

function isPortBound(port) {
    return new Promise(resolve => {
        const s = net.createServer();
        s.once('error',     () => resolve(true));
        s.once('listening', () => { s.close(); resolve(false); });
        s.listen(port, '127.0.0.1');
    });
}

function startPortForward(fromPort, toPort) {
    const srv = net.createServer(client => {
        const remote = net.connect(toPort, '127.0.0.1', () => { client.pipe(remote); remote.pipe(client); });
        remote.on('error', () => client.destroy());
        client.on('error', () => remote.destroy());
    });
    srv.listen(fromPort, '127.0.0.1', () =>
        console.log(`[Tor] Forward :${fromPort} -> :${toPort}`));
    srv.on('error', e => console.warn(`[Tor] Forward error :${fromPort}`, e.message));
    return srv;
}

async function setupPortForward() {
    let waited = 0;
    const poll = setInterval(async () => {
        waited += 1000;
        if (await testProxyReachable('127.0.0.1', 9050, 800)) {
            clearInterval(poll);
            console.log('[Tor] :9050 reachable');
            if (await isPortBound(1080)) {
                if (await testProxyReachable('127.0.0.1', 1080, 800))
                    console.log('[Tor] :1080 already active');
            } else {
                portForwardServer = startPortForward(1080, 9050);
            }
        } else if (waited >= 60000) {
            clearInterval(poll);
            console.warn('[Tor] Timeout waiting for :9050');
        }
    }, 1000);
}

async function launchTor() {
    const localAppData = process.env.LOCALAPPDATA || '';
    const appData      = process.env.APPDATA      || '';

    const torPaths = [
        path.join(__dirname, 'bin', 'tor', 'tor.exe'),
        path.join(baseDataDir, 'bin', 'tor', 'tor.exe'),
        path.join(__dirname, 'tor', 'tor.exe'),
        path.join(baseDataDir, 'tor', 'tor.exe'),
        'D:\\Studious\\bin\\tor\\tor.exe',
        'D:\\Studious\\tor\\tor.exe',
        'tor',
        path.join(localAppData, 'Programs', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(localAppData, 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        'C:\\Tor Browser\\Browser\\TorBrowser\\Tor\\tor.exe',
        'C:\\Program Files\\Tor Browser\\Browser\\TorBrowser\\Tor\\tor.exe',
        path.join(appData, 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        '/usr/bin/tor', '/usr/local/bin/tor', '/opt/homebrew/bin/tor', '/usr/local/opt/tor/bin/tor'
    ];

    if (await testProxyReachable('127.0.0.1', 9050, 1000)) {
        console.log('[Tor] Already on :9050');
        return setupPortForward();
    }

    let launched = false;
    for (const torExe of torPaths) {
        if (process.platform !== 'win32' && torExe.endsWith('.exe')) continue;
        if (torExe !== 'tor' && !fs.existsSync(torExe)) continue;
        try {
            const torDir      = path.dirname(torExe);
            const dataDirPath = path.join(baseDataDir, 'tor-data');
            if (!fs.existsSync(dataDirPath)) fs.mkdirSync(dataDirPath, { recursive: true });
            const torArgs = ['--SocksPort','9050','--ControlPort','9051','--DataDirectory',dataDirPath,'--CookieAuthentication','1','--Log','notice stdout'];
            const geoip   = path.join(torDir, 'geoip');
            const geoip6  = path.join(torDir, 'geoip6');
            if (fs.existsSync(geoip))  torArgs.push('--GeoIPFile',  geoip);
            if (fs.existsSync(geoip6)) torArgs.push('--GeoIPv6File',geoip6);

            torProcess = spawn(torExe, torArgs, { detached: false, stdio: ['ignore','pipe','pipe'] });
            const onLine = line => {
                line = line.trim(); if (!line) return;
                console.log('[Tor]', line);
                if (line.includes('Bootstrapped 100%') || line.includes('Done')) {
                    console.log('[Tor] Bootstrapped');
                    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tor-ready'));
                }
            };
            torProcess.stdout.on('data', d => d.toString().split('\n').forEach(onLine));
            torProcess.stderr.on('data', d => d.toString().split('\n').forEach(onLine));
            torProcess.on('error', e => { console.warn('[Tor] Error:', e.message); torProcess = null; });
            torProcess.on('close', c => { console.log('[Tor] Exit', c); torProcess = null; });
            launched = true;
            console.log('[Tor] Spawned:', torExe);
            break;
        } catch(e) { console.warn('[Tor] Failed:', torExe, e.message); torProcess = null; }
    }

    if (!launched) { console.warn('[Tor] tor.exe not found'); return; }
    setupPortForward();
}

ipcMain.handle('tor-status', async () => ({
    torRunning:    await testProxyReachable('127.0.0.1', 9050, 800),
    forwardActive: await testProxyReachable('127.0.0.1', 1080, 800),
    torProcess:    !!torProcess
}));

function torControlCommand(cmd) {
    return new Promise((resolve, reject) => {
        const sock = new net.Socket(); let resp = ''; let done = false;
        sock.setTimeout(5000);
        sock.connect(9051, '127.0.0.1', () => {
            const cp = path.join(baseDataDir, 'tor-data', 'control_auth_cookie');
            let auth;
            try { auth = 'AUTHENTICATE ' + fs.readFileSync(cp).toString('hex') + '\r\n'; }
            catch { auth = 'AUTHENTICATE\r\n'; }
            sock.write(auth);
        });
        sock.on('data', d => {
            resp += d.toString();
            if (!done && resp.includes('250 OK')) {
                if (resp.indexOf('250 OK') === resp.lastIndexOf('250 OK')) { done=true; resp=''; sock.write(cmd+'\r\n'); }
                else { sock.destroy(); resolve(resp.trim()); }
            }
        });
        sock.on('error',   e => { sock.destroy(); reject(e); });
        sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
        sock.on('close',   () => { if (!done) resolve(resp.trim()); });
    });
}

ipcMain.handle('tor-set-exit', async (event, cc) => {
    try {
        if (cc === 'any') { await torControlCommand('SETCONF ExitNodes='); await torControlCommand('SETCONF StrictNodes=0'); }
        else { await torControlCommand(`SETCONF ExitNodes={${cc}}`); await torControlCommand('SETCONF StrictNodes=1'); }
        await torControlCommand('SIGNAL NEWNYM');
        return { ok: true };
    } catch(e) { return { ok: false, reason: e.message }; }
});

ipcMain.handle('tor-new-circuit', async () => {
    try { await torControlCommand('SIGNAL NEWNYM'); return { ok: true }; }
    catch(e) { return { ok: false, reason: e.message }; }
});


// ============================================================
//  COOKIE MANAGER
// ============================================================



ipcMain.handle('get-cookies', async (event, url) => {
    try { const { session } = require('electron'); return await session.defaultSession.cookies.get({ url }); }
    catch { return []; }
});

const COOKIE_FILENAME_MAP = {
    'youtube.com': 'youtube', 'www.youtube.com': 'youtube',
    'coursera.org': 'coursera', 'www.coursera.org': 'coursera',
    'khanacademy.org': 'khanacademy', 'www.khanacademy.org': 'khanacademy',
    'edx.org': 'edx', 'www.edx.org': 'edx',
    'ocw.mit.edu': 'mitocw',
    'ted.com': 'ted', 'www.ted.com': 'ted',
    'udemy.com': 'udemy', 'www.udemy.com': 'udemy',
    'vimeo.com': 'vimeo', 'www.vimeo.com': 'vimeo',
    'archive.org': 'archive', 'www.archive.org': 'archive',
    'github.com': 'github', 'www.github.com': 'github'
};

function getCookieFilename(domain) {
    if (COOKIE_FILENAME_MAP[domain]) return COOKIE_FILENAME_MAP[domain];
    const bare = domain.replace(/^www\./, '');
    if (COOKIE_FILENAME_MAP[bare]) return COOKIE_FILENAME_MAP[bare];
    return domain.replace(/[^a-z0-9.-]/gi, '_');
}

ipcMain.handle('save-cookie-file', async (event, domain, content, customName) => {
    try {
        const base = customName
            ? customName.replace(/[^a-z0-9._-]/gi, '_').replace(/\.txt$/, '')
            : getCookieFilename(domain);
        const fp = path.join(cookiesFolder, base + '.txt');
        fs.writeFileSync(fp, content, 'utf-8');
        return { saved: true, path: fp, filename: base + '.txt' };
    } catch(e) { return { saved: false }; }
});

ipcMain.handle('get-cookie-filename', async (event, domain) => getCookieFilename(domain) + '.txt');
ipcMain.handle('list-cookie-files', async () => {
    try {
        return fs.readdirSync(cookiesFolder).filter(f => f.endsWith('.txt'))
            .map(f => { const s = fs.statSync(path.join(cookiesFolder, f)); return { name: f, size: s.size, modified: s.mtimeMs }; })
            .sort((a, b) => b.modified - a.modified);
    } catch { return []; }
});
ipcMain.handle('delete-cookie-file', async (event, name) => {
    try {
        const fp = path.join(cookiesFolder, name.replace(/[^a-z0-9._-]/gi, '_'));
        if (fs.existsSync(fp)) { fs.unlinkSync(fp); return { deleted: true }; }
        return { deleted: false };
    } catch { return { deleted: false }; }
});


// ============================================================
//  WATCH HISTORY
// ============================================================

const WATCH_HISTORY_FILE = path.join(baseDataDir, 'watch_history.json');
let _watchHistoryCache = null;
let _watchHistorySaveTimer = null;

function loadWatchHistory() {
    if (_watchHistoryCache) return _watchHistoryCache;
    try { _watchHistoryCache = JSON.parse(fs.readFileSync(WATCH_HISTORY_FILE, 'utf8')); }
    catch { _watchHistoryCache = {}; }
    return _watchHistoryCache;
}
function saveWatchHistory(data) {
    _watchHistoryCache = data;
    if (_watchHistorySaveTimer) return;
    _watchHistorySaveTimer = setTimeout(() => {
        _watchHistorySaveTimer = null;
        fs.writeFile(WATCH_HISTORY_FILE, JSON.stringify(_watchHistoryCache), () => {});
    }, 1000);
}

ipcMain.handle('watch-history-get', () => loadWatchHistory());
ipcMain.handle('watch-history-set', (e, vaultId, timestamp, duration) => {
    const h = loadWatchHistory();
    h[vaultId] = { timestamp, duration, watchedAt: Date.now() };
    saveWatchHistory(h);
    return true;
});
ipcMain.handle('watch-history-clear', (e, vaultId) => {
    const h = loadWatchHistory();
    if (vaultId) delete h[vaultId];
    else Object.keys(h).forEach(k => delete h[k]);
    saveWatchHistory(h);
    return true;
});


// ============================================================
//  VIDEO NOTES
// ============================================================

const NOTES_FILE = path.join(baseDataDir, 'video_notes.json');
let _notesCache = null;
let _notesSaveTimer = null;

function loadNotes() {
    if (_notesCache) return _notesCache;
    try { _notesCache = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); }
    catch { _notesCache = {}; }
    return _notesCache;
}
function saveNotes(data) {
    _notesCache = data;
    if (_notesSaveTimer) return;
    _notesSaveTimer = setTimeout(() => {
        _notesSaveTimer = null;
        fs.writeFile(NOTES_FILE, JSON.stringify(_notesCache), () => {});
    }, 1000);
}

ipcMain.handle('notes-get', (e, vaultId) => { const n = loadNotes(); return n[vaultId] || ''; });
ipcMain.handle('notes-set', (e, vaultId, text) => { const n = loadNotes(); n[vaultId] = text; saveNotes(n); return true; });
ipcMain.handle('notes-get-all', () => loadNotes());


// ============================================================
//  ENCODE HISTORY LOG
// ============================================================

const ENCODE_LOG_FILE = path.join(baseDataDir, 'encode_log.json');

function loadEncodeLog() {
    try { return JSON.parse(fs.readFileSync(ENCODE_LOG_FILE, 'utf8')); } catch { return []; }
}
function appendEncodeLog(entry) {
    try {
        const log = loadEncodeLog();
        log.unshift({ ...entry, at: Date.now() });
        if (log.length > 500) log.splice(500);
        fs.writeFileSync(ENCODE_LOG_FILE, JSON.stringify(log, null, 2));
    } catch {}
}

ipcMain.handle('encode-log-get', () => loadEncodeLog());
ipcMain.handle('encode-log-clear', () => {
    try { fs.writeFileSync(ENCODE_LOG_FILE, '[]'); return true; } catch { return false; }
});


// ============================================================
//  PASSWORD CHANGE
// ============================================================

ipcMain.handle('change-password', async (e, username, oldPass, newPass) => {
    try {
        if (!fs.existsSync(usersFile)) return { ok: false, msg: 'No users file' };
        const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        const user = users.find(u => u.username === username);
        if (!user) return { ok: false, msg: 'User not found' };
        const oldHash = crypto.createHash('sha256').update(oldPass).digest('hex');
        if (user.password !== oldHash) return { ok: false, msg: 'Current password incorrect' };
        user.password = crypto.createHash('sha256').update(newPass).digest('hex');
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
        return { ok: true };
    } catch (err) { return { ok: false, msg: err.message }; }
});


// ============================================================
//  AUTO BACKUP vault.json
// ============================================================



function autoBackupVault() {
    try {
        if (!fs.existsSync(vaultIndexPath)) return;
        const content = fs.readFileSync(vaultIndexPath, 'utf8');
        try { JSON.parse(content); } catch { return; }

        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.copyFileSync(vaultIndexPath, path.join(BACKUP_DIR, `vault_${ts}.json`));
        const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('vault_') && f.endsWith('.json')).sort();
        while (files.length > 10) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    } catch {}
}

function autoBackupPlaylists() {
    try {
        if (!fs.existsSync(PLAYLISTS_FILE)) return;
        const content = fs.readFileSync(PLAYLISTS_FILE, 'utf8');
        try { JSON.parse(content); } catch { return; }

        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.copyFileSync(PLAYLISTS_FILE, path.join(BACKUP_DIR, `playlists_${ts}.json`));
        const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('playlists_') && f.endsWith('.json')).sort();
        while (files.length > 10) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    } catch {}
}

setTimeout(() => {
    autoBackupVault();
    autoBackupPlaylists();
}, 5000);

setInterval(() => {
    autoBackupVault();
    autoBackupPlaylists();
}, 30 * 60 * 1000);

ipcMain.handle('backup-list', () => {
    try {
        return fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('vault_') && f.endsWith('.json')).sort().reverse()
            .map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size, at: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }));
    } catch { return []; }
});
ipcMain.handle('backup-restore', async (e, name) => {
    try {
        const src = path.join(BACKUP_DIR, name.replace(/[^a-z0-9._-]/gi, '_'));
        fs.copyFileSync(src, vaultIndexPath);
        try { Object.assign(vaultIndex, JSON.parse(fs.readFileSync(vaultIndexPath, 'utf8'))); } catch {}
        return { ok: true };
    } catch (err) { return { ok: false, msg: err.message }; }
});


// ============================================================
//  IP CHECKER
// ============================================================

ipcMain.handle('check-ip', async () => {
    return new Promise((resolve) => {
        const sock = net.createConnection(9050, '127.0.0.1');
        let raw = ''; let step = 0;
        sock.setTimeout(10000);
        sock.on('connect', () => { sock.write(Buffer.from([0x05, 0x01, 0x00])); });
        sock.on('data', (d) => {
            if (step === 0) {
                if (d[0] === 0x05 && d[1] === 0x00) {
                    step = 1;
                    const host = 'ip-api.com';
                    const buf = Buffer.alloc(7 + host.length);
                    buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x03;
                    buf[4] = host.length; Buffer.from(host).copy(buf, 5);
                    buf[5 + host.length] = 0x00; buf[6 + host.length] = 0x50;
                    sock.write(buf);
                }
            } else if (step === 1) {
                step = 2;
                sock.write('GET /json HTTP/1.1\r\nHost: ip-api.com\r\nConnection: close\r\n\r\n');
            } else {
                raw += d.toString();
                if (raw.includes('\r\n\r\n')) {
                    const body = raw.split('\r\n\r\n').slice(1).join('');
                    try { resolve({ ok: true, data: JSON.parse(body.trim()) }); }
                    catch { resolve({ ok: false, msg: 'Parse error' }); }
                    sock.destroy();
                }
            }
        });
        sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, msg: 'Timeout' }); });
        sock.on('error', (err) => resolve({ ok: false, msg: err.message }));
    });
});


// ============================================================
//  SAFE SHUTDOWN
// ============================================================

// Synchronous save for shutdown
function saveVaultIndexNow() {
    try { fs.writeFileSync(vaultIndexPath, JSON.stringify(vaultIndex, null, 2)); }
    catch (e) { console.error('[Vault] Save error:', e.message); }
}

app.on('before-quit', () => {
    console.log('Closing Studious safely');
    saveVaultIndexNow();
    savePlaylistsNow();
    try { streamServer?.close(); }      catch {}
    try { portForwardServer?.close(); } catch {}
    try { torProcess?.kill(); }         catch {}
});