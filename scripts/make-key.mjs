// Generates a manifest "key" so the extension ID stays fixed (the OAuth redirect
// URI depends on it). Prints the key and the resulting extension ID. The key is
// a public key and is not secret; the private half is not needed for unpacked
// extensions and is not saved.
import { createHash, generateKeyPairSync } from 'node:crypto';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const key = der.toString('base64');
const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');

console.log(`manifestKey (put in src/config.ts):\n\n${key}\n`);
console.log(`Extension ID: ${id}`);
console.log(`OAuth redirect URI: https://${id}.chromiumapp.org/`);
