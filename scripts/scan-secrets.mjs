#!/usr/bin/env node
// Dependency-free secret / private-data scanner for the working tree (and optionally full git history: --history).
// Exit code 1 if anything is found. Patterns are deliberately conservative; review every hit.
// Also refuses: image files that carry EXIF (location/camera data), Lightroom catalogues, database dumps, .env files, key files.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Meta/Instagram token', /\bIG[A-Za-z0-9]{60,}\b|\bEAA[A-Za-z0-9]{60,}\b/],
  ['assigned secret literal', /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{20,}["']/i],
  ['long hex secret assigned in a config file', /^(?!.*(?:example|placeholder|__GENERATED|test|aaaa|bbbb))[A-Z_]*(?:SECRET|KEY|PASSWORD|TOKEN)[A-Z_]*=[0-9a-f]{32,}\s*$/m],
  ['absolute home path', /\/(?:Users|home)\/(?!you\b|name\b|me\b|<|\.\.)[a-z0-9._-]+\//],
  ['macOS volume path', /\/Volumes\/[A-Za-z0-9 ._-]+\//],
  ['Windows user path', /[A-Z]:\\Users\\(?!you\b|name\b|me\b)[A-Za-z0-9._-]+\\/],
  ['private IPv4', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['tailnet / CGNAT address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b|\.ts\.net\b|\btail[0-9a-f]{4,}\b/i],
  ['SMB/NAS URL', /\bsmb:\/\/[^\s'"]+/i],
  ['email address', /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.(?:com|org|test)|anthropic\.com|photos\.example)[A-Za-z0-9.-]+\.[a-z]{2,}\b/i],
];
// Words that must never appear in the public tree (project-private names). Extend locally: PHOTOVAULT_SCAN_EXTRA="word1,word2".
const WORDS = ['jangounwalla', 'jangoinsta', 'jangophoto', 'com.jango', 'personalaihub', 'personal-ai-hub', 'second brain', 'unissant', 'backups-mac-mini', 'fedintel', ...(process.env.PHOTOVAULT_SCAN_EXTRA ?? '').split(',').filter(Boolean)];
const WORD_ALLOWED_FILES = /^(scripts\/scan-secrets\.mjs|\.github\/.*)$/;
const SKIP = /^(package-lock\.json|node_modules\/|.*\.(png|ico|woff2?)$)/;
const IMAGE = /\.(jpe?g|png|webp|tiff?|heic|avif)$/i;
const FORBIDDEN_FILES = [[/\.(lrcat|lrdata|lrtemplate|xmp|cr2|cr3|nef|arw|dng|orf|raf|rw2)$/i, 'photo-editor catalogue / RAW / sidecar file'], [/\.(dump|sql\.gz|bak|sqlite3?|db)$/i, 'database dump / database file'], [/(^|\/)\.env(\.(?!example$).+)?$/, '.env file'], [/\.(pem|key|p12|pfx|jks)$/i, 'key / certificate file'], [/(^|\/)(id_rsa|id_ed25519)(\.pub)?$/, 'SSH key']];

const history = process.argv.includes('--history');
const hits = [];
// synthetic fixtures in test files (documentation-range IPs, example.test addresses, test passwords) are not private data; everything else still applies
const TEST_FILE = /(\.(?:i?test)\.tsx?$|(^|\/)test\/)/;
const TEST_SKIPS = new Set(['private IPv4', 'email address', 'absolute home path', 'macOS volume path', 'assigned secret literal', 'tailnet / CGNAT address']);
function scanText(label, file, text) {
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (!(TEST_FILE.test(file) && TEST_SKIPS.has(name)) && re.test(line)) hits.push(`${label}${file}:${i + 1}  ${name}`);
    if (!WORD_ALLOWED_FILES.test(file)) { const low = line.toLowerCase(); for (const w of WORDS) if (low.includes(w)) hits.push(`${label}${file}:${i + 1}  forbidden word "${w}"`); }
  });
}
// an EXIF block ("Exif\0\0" in APP1) means camera/location metadata may be present
function scanImage(label, file, buf) {
  if (buf.includes(Buffer.from('Exif\0\0', 'latin1'))) hits.push(`${label}${file}  image contains an EXIF block (strip it: location, camera and owner data)`);
  if (buf.includes(Buffer.from('<x:xmpmeta', 'latin1'))) hits.push(`${label}${file}  image contains an XMP packet`);
  if (buf.includes(Buffer.from('Photoshop 3.0', 'latin1'))) hits.push(`${label}${file}  image contains IPTC/IRB metadata`);
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const gitBuf = (...a) => execFileSync('git', a, { maxBuffer: 1 << 28 });
let files;
try { files = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean); }
catch { console.error('Not a git repository (or git missing).'); process.exit(2); }
for (const f of files) {
  for (const [re, why] of FORBIDDEN_FILES) if (re.test(f)) hits.push(`${f}  ${why}`);
  if (SKIP.test(f) && !IMAGE.test(f)) continue;
  try { const buf = readFileSync(f); if (IMAGE.test(f)) scanImage('', f, buf); else if (!SKIP.test(f)) scanText('', f, buf.toString('utf8')); } catch { /* unreadable */ }
}
if (history) {
  for (const c of git('rev-list', '--all').split('\n').filter(Boolean)) {
    for (const f of git('ls-tree', '-r', '--name-only', c).split('\n').filter(Boolean)) {
      for (const [re, why] of FORBIDDEN_FILES) if (re.test(f)) hits.push(`[${c.slice(0, 8)}] ${f}  ${why}`);
      if (SKIP.test(f) && !IMAGE.test(f)) continue;
      try { const buf = gitBuf('show', `${c}:${f}`); if (IMAGE.test(f)) scanImage(`[${c.slice(0, 8)}] `, f, buf); else if (!SKIP.test(f)) scanText(`[${c.slice(0, 8)}] `, f, buf.toString('utf8')); } catch { /* binary */ }
    }
  }
  scanText('[commit metadata] ', 'log', git('log', '--all', '--format=%an <%ae> | %cn <%ce> | %s'));
}
if (hits.length) { console.error(`Potential secrets / private data found (${hits.length}):\n` + [...new Set(hits)].join('\n')); process.exit(1); }
console.log(`scan-secrets: clean (${files.length} files${history ? ', full history' : ''}).`);
