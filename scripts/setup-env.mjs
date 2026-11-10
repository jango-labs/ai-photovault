#!/usr/bin/env node
// Creates .env from .env.example with freshly generated random secrets. Never overwrites an existing .env.
//   node scripts/setup-env.mjs [--photos /absolute/path/to/your/photos]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.env');
if (fs.existsSync(target)) { console.error('.env already exists; not touching it. Delete it first if you really want new secrets (that also needs a fresh database).'); process.exit(1); }
let text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const hex = (n) => crypto.randomBytes(n).toString('hex');
text = text.replace(/=__GENERATED_HEX__/g, () => `=${hex(32)}`).replace(/=__GENERATED__/g, () => `=${hex(24)}`);
const i = process.argv.indexOf('--photos');
if (i >= 0 && process.argv[i + 1]) text = text.replace(/^PHOTOVAULT_PHOTOS_DIR=.*$/m, `PHOTOVAULT_PHOTOS_DIR=${process.argv[i + 1].replace(/\\/g, '/')}`);
fs.writeFileSync(target, text, { mode: 0o600 });
console.log('Created .env with new random secrets (file permissions: owner only). Next: edit PHOTOVAULT_PHOTOS_DIR to point at your photo folder.');
