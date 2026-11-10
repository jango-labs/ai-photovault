import os from 'node:os';
import path from 'node:path';

/** Where AI PhotoVault keeps small local state (the import-approval file): PHOTOVAULT_STATE_DIR, else ~/.photovault */
export const defaultStateDir = (env: NodeJS.ProcessEnv = process.env): string => env.PHOTOVAULT_STATE_DIR ?? path.join(os.homedir(), '.photovault');
