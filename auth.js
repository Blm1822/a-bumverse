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
