const crypto = require('node:crypto');

function verifySignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string') return false;

  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('base64'));
  const given = Buffer.from(signature);
  // timingSafeEqual throws if the lengths differ. Checking length first leaks nothing secret:
  // every valid signature has the same length.
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { verifySignature };
