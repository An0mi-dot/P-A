// Proteção da API key do OCR remoto em repouso.
// A chave real NUNCA fica em texto puro no config.json/instalador: é cifrada
// com AES-256-GCM e a chave de cifra é derivada de um segredo constante do
// app. Isso não é segurança absoluta contra engenharia reversa (o app precisa
// decriptar em runtime), mas remove o segredo em claro do disco e do pacote.
'use strict';

const crypto = require('crypto');

// Derivado em runtime (nunca literalmente a chave final). Muda por build.
function _secret() {
  const parts = ['EXTRATJUD-PROTO-2026', 'aes-gcm', 'prot', process.platform === 'win32' ? 'nt' : 'posix'];
  return crypto.createHash('sha256').update(parts.join('::')).digest();
}

// Envelope: base64(iv) :: base64(tag) :: base64(payload)
function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const key = _secret();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('::');
}

function decrypt(envelope) {
  if (!envelope || envelope === '') return '';
  const eq = /\benv:/.test(envelope) ? envelope.replace(/^env:/, '') : envelope;
  const parts = eq.split('::');
  if (parts.length !== 3) return eq;
  try {
    const key = _secret();
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const data = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && /\b[a-zA-Z0-9+/=]+::[a-zA-Z0-9+/=]+::[a-zA-Z0-9+/=]+\b/.test(value);
}

module.exports = { encrypt, decrypt, isEncrypted };