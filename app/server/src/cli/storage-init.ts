// Prepares the data folder on a mounted drive and writes the marker file the storage guard looks for.
//   PHOTOVAULT_STORAGE_MOUNT=/Volumes/Photos PHOTOVAULT_STORAGE_ID=my-photo-drive npm run storage:init
// Only needed when you set PHOTOVAULT_STORAGE_MOUNT / PHOTOVAULT_STORAGE_ID (the optional "refuse to run if the drive is missing" guard).
import fs from 'node:fs/promises';
import path from 'node:path';
import { MARKER } from '../storage/dataRoot.js';

const mount = process.env.PHOTOVAULT_STORAGE_MOUNT?.trim(); const id = process.env.PHOTOVAULT_STORAGE_ID?.trim();
const subdir = process.env.PHOTOVAULT_DATA_SUBDIR?.trim() || 'PhotoVaultData';
if (!mount || !id) { console.error('Set PHOTOVAULT_STORAGE_MOUNT (the folder where the drive is mounted) and PHOTOVAULT_STORAGE_ID (any name of 8 to 64 letters, digits, dots, dashes or underscores).'); process.exit(2); }
if (!/^[A-Za-z0-9._-]{8,64}$/.test(id)) { console.error('PHOTOVAULT_STORAGE_ID must be 8 to 64 letters, digits, dots, dashes or underscores.'); process.exit(2); }
if (path.isAbsolute(subdir) || subdir.split(/[\\/]/).includes('..')) { console.error('PHOTOVAULT_DATA_SUBDIR must be a plain relative folder name.'); process.exit(2); }
const st = await fs.stat(mount).catch(() => null);
if (!st?.isDirectory()) { console.error(`${mount} is not a folder: is the drive connected and mounted?`); process.exit(1); }
const root = path.join(mount, subdir);
await fs.mkdir(root, { recursive: true });
for (const d of ['derivatives', 'ai-assets', 'cache', 'ig-media', 'delivery']) await fs.mkdir(path.join(root, d), { recursive: true });
const marker = path.join(root, MARKER);
const existing = await fs.readFile(marker, 'utf8').then((t) => JSON.parse(t) as { storageId?: string }).catch(() => null);
if (existing && String(existing.storageId).toUpperCase() !== id.toUpperCase()) { console.error(`${root} already belongs to a different storage id (${existing.storageId}). Refusing to overwrite its marker.`); process.exit(1); }
await fs.writeFile(marker, JSON.stringify({ version: 1, storageId: id.toUpperCase(), createdAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`Data folder ready: ${root}`);
