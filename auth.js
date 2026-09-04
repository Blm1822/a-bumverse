// Password hashing + session token generation. Rolled by hand with node:crypto
// rather than adding a dependency (bcrypt et al.) - scrypt is built in, and the
// pattern mirrors the timing-safe comparison server.js already uses for the
// analytics password.
import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, 'hex');
  const candidateBuf = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return hashBuf.length === candidateBuf.length && crypto.timingSafeEqual(hashBuf, candidateBuf);
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Recovery codes are the password-reset mechanism (no email infra to send a
// reset link through) - a high-entropy random secret shown once at signup,
// which the user has to save themselves. 80 bits of entropy is already far
// beyond brute-forceable, so unlike passwords this is hashed with plain
// sha256 (fast) rather than scrypt - there's no low-entropy human-chosen
// input here for a fast hash to make guessable.
function normalizeRecoveryCode(code) {
  return String(code || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

export function generateRecoveryCode() {
  const hex = crypto.randomBytes(10).toString('hex').toUpperCase();
  return hex.match(/.{1,5}/g).join('-');
}

export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export function verifyRecoveryCode(code, storedHash) {
  if (!storedHash) return false;
  const candidate = Buffer.from(hashRecoveryCode(code), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}
