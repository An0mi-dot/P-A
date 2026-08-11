/**
 * history-service.js — Execução de Histórico (local JSON file)
 * Armazena registros de execução em JSON no userData do Electron.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const HISTORY_FILE = path.join(app.getPath('userData'), 'execution_history.json');
const MAX_RECORDS = 500;
const MAX_LOGS_PER_RECORD = 1000;

let _history = [];

function load() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            _history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[HistoryService] Falha ao carregar histórico:', e.message);
        _history = [];
    }
    // Execuções de sessões anteriores não podem permanecer "running" após o boot
    // (ex.: app fechado no meio de uma automação). Marca como interrompidas para
    // o hub/dashboard não exibir "Processando" para algo que não está rodando.
    const now = new Date().toISOString();
    let changed = false;
    for (const r of _history) {
        if (r && r.status === 'running') {
            r.status = 'stopped';
            r.finishedAt = r.finishedAt || now;
            r.error = r.error || 'Interrompido (sessão anterior)';
            changed = true;
        }
    }
    if (changed) save();
}

function save() {
    try {
        // Keep only last MAX_RECORDS
        if (_history.length > MAX_RECORDS) {
            _history = _history.slice(-MAX_RECORDS);
        }
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(_history, null, 2), 'utf8');
    } catch (e) {
        console.error('[HistoryService] Falha ao salvar histórico:', e.message);
    }
}

/**
 * Add a new execution record. Returns the generated ID.
 * @param {Object} record - { type, status, files, logFile, error, args }
 * @returns {string} record ID
 */
function addRecord(record) {
    const id = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
        id,
        type: record.type || 'unknown',
        status: record.status || 'running',
        startedAt: record.startedAt || new Date().toISOString(),
        finishedAt: record.finishedAt || null,
        files: record.files || [],
        logFile: record.logFile || null,
        error: record.error || null,
        args: record.args || {},
        logs: []
    };
    _history.unshift(entry); // newest first
    save();
    return id;
}

/**
 * Update an existing record by ID.
 */
function updateRecord(id, updates) {
    const idx = _history.findIndex(r => r.id === id);
    if (idx === -1) return false;
    _history[idx] = { ..._history[idx], ...updates };
    _flushSave();
    return true;
}

/**
 * Get all records, newest first. Supports optional filter.
 * @param {Object} filter - { type?, status?, limit?, offset? }
 */
function getRecords(filter = {}) {
    let results = [..._history];

    if (filter.type) {
        results = results.filter(r => r.type === filter.type);
    }
    if (filter.status) {
        results = results.filter(r => r.status === filter.status);
    }

    const total = results.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || 50;

    return {
        records: results.slice(offset, offset + limit),
        total,
        offset,
        limit
    };
}

/**
 * Get a single record by ID.
 */
function getRecord(id) {
    return _history.find(r => r.id === id) || null;
}

/**
 * Delete a record by ID.
 */
function deleteRecord(id) {
    const idx = _history.findIndex(r => r.id === id);
    if (idx === -1) return false;
    _history.splice(idx, 1);
    save();
    return true;
}

/**
 * Clear all history.
 */
function clearHistory() {
    _history = [];
    save();
}

/**
 * Append a log entry to a running record.
 */
function addLog(id, logEntry) {
    const idx = _history.findIndex(r => r.id === id);
    if (idx === -1) return false;
    if (!_history[idx].logs) _history[idx].logs = [];
    _history[idx].logs.push({
        msg: logEntry.msg || '',
        type: logEntry.type || 'info',
        tech: logEntry.tech || null,
        timestamp: logEntry.timestamp || new Date().toISOString()
    });
    if (_history[idx].logs.length > MAX_LOGS_PER_RECORD) {
        _history[idx].logs = _history[idx].logs.slice(-MAX_LOGS_PER_RECORD);
    }
    // Debounced save (avoid writing on every log line)
    _debouncedSave();
    return true;
}

let _saveTimer = null;
function _debouncedSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => { _saveTimer = null; save(); }, 2000);
}

function _flushSave() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    save();
}

/**
 * Get summary stats.
 */
function getStats() {
    const total = _history.length;
    const success = _history.filter(r => r.status === 'success').length;
    const error = _history.filter(r => r.status === 'error').length;
    const stopped = _history.filter(r => r.status === 'stopped').length;
    const running = _history.filter(r => r.status === 'running').length;

    const byType = {};
    for (const r of _history) {
        byType[r.type] = (byType[r.type] || 0) + 1;
    }

    return { total, success, error, stopped, running, byType };
}

// Load on module init
load();

module.exports = {
    addRecord,
    updateRecord,
    addLog,
    getRecords,
    getRecord,
    deleteRecord,
    clearHistory,
    getStats
};
