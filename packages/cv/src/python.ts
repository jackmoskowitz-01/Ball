import { existsSync } from 'fs';
import path from 'path';
import { REPO_ROOT } from '@autocode/db';

export const PY_DIR = path.join(REPO_ROOT, 'packages/cv/python');

export function pythonBin(): string {
  const venv = path.join(PY_DIR, 'venv/bin/python');
  if (existsSync(venv)) return venv;
  return 'python3'; // pre-setup fallback; setup.sh creates the venv
}
