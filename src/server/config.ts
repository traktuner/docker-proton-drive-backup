import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { backupSets, type BackupMode, type Schedule } from './db';
import { catalog } from './catalog';
import { LOCAL_ROOT, resolveLocal, sanitizeSegment } from './local';
import { DOW, pad } from '@/lib/schedule';
import { isBackupSetBusy } from './backup-lock';
import {
  classifySourceListChange,
  planSourceAdditions,
  SourceValidationError,
  verifySourceAdditionsSync,
} from './source-paths';

/**
 * Backup sets as portable, version-controllable YAML. Source paths are exported
 * relative to LOCAL_ROOT so the config is portable across hosts.
 */

const MODES: BackupMode[] = ['add', 'backup', 'mirror'];
const SCHEDULES: Schedule[] = ['off', 'hourly', 'daily', 'weekly'];

function relSource(abs: string): string {
  return abs === LOCAL_ROOT ? '/' : abs.startsWith(LOCAL_ROOT) ? abs.slice(LOCAL_ROOT.length) : abs;
}

export function exportConfig(): string {
  const sets = backupSets.all().map((s) => {
    const item: Record<string, unknown> = {
      name: s.name,
      sources: s.sourcePaths.map(relSource),
      target: s.targetPath,
      mode: s.mode,
      schedule: s.schedule,
    };
    // Only emit the subfolder when it isn't the plain derived-from-name default
    // (e.g. a uniqueness suffix), so common configs stay clean and human-readable.
    if (s.targetSubfolder !== sanitizeSegment(s.name)) item.targetFolder = s.targetSubfolder;
    if (s.schedule === 'daily' || s.schedule === 'weekly') {
      item.time = `${pad(s.scheduleHour)}:${pad(s.scheduleMinute)}`;
    }
    if (s.schedule === 'weekly') item.dayOfWeek = DOW[s.scheduleDow];
    if (s.excludes.length) item.excludes = s.excludes;
    if (s.skipThumbnails) item.skipThumbnails = true;
    if (s.includeHidden) item.includeHidden = true;
    if (s.watch) item.watch = true;
    return item;
  });
  return YAML.stringify({ version: 1, backupSets: sets });
}

export interface ImportResult {
  imported: number;
  updated: number;
  errors: string[];
}

export function importConfig(text: string): ImportResult {
  const res: ImportResult = { imported: 0, updated: 0, errors: [] };
  let doc: any;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    res.errors.push(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
    return res;
  }
  const items = Array.isArray(doc?.backupSets) ? doc.backupSets : [];
  if (items.length === 0) res.errors.push('No backupSets found in the config.');

  const existing = backupSets.all();

  for (const [i, raw] of items.entries()) {
    const name = String(raw?.name ?? '').trim();
    const sourcesRaw = Array.isArray(raw?.sources) ? raw.sources : [];
    const target = String(raw?.target ?? '/').trim() || '/';
    if (!name) {
      res.errors.push(`Entry ${i + 1}: missing name`);
      continue;
    }
    if (sourcesRaw.length === 0) {
      res.errors.push(`"${name}": no sources`);
      continue;
    }
    let sourcePaths: string[];
    try {
      sourcePaths = sourcesRaw.map((p: unknown) => resolveLocal(String(p)));
    } catch {
      res.errors.push(`"${name}": invalid source path`);
      continue;
    }
    const mode: BackupMode = MODES.includes(raw?.mode) ? raw.mode : 'backup';
    const schedule: Schedule = SCHEDULES.includes(raw?.schedule) ? raw.schedule : 'off';
    const [h, m] = String(raw?.time ?? '03:00').split(':');
    const dowIdx = DOW.findIndex((d) => d.toLowerCase() === String(raw?.dayOfWeek ?? '').toLowerCase());

    const rawFolder = typeof raw?.targetFolder === 'string' ? raw.targetFolder.trim() : '';
    const payload = {
      name,
      sourcePaths,
      targetPath: target,
      // Only honoured on create (stable after that); db.create derives it if empty.
      targetSubfolder: rawFolder || undefined,
      mode,
      schedule,
      scheduleHour: Math.min(23, Math.max(0, parseInt(h, 10) || 3)),
      scheduleMinute: Math.min(59, Math.max(0, parseInt(m, 10) || 0)),
      scheduleDow: dowIdx >= 0 ? dowIdx : 1,
      excludes: Array.isArray(raw?.excludes) ? raw.excludes.map(String) : [],
      skipThumbnails: raw?.skipThumbnails === true,
      includeHidden: raw?.includeHidden === true,
      watch: raw?.watch === true,
    };

    const dupe = existing.find((e) => e.name === name);
    if (dupe) {
      if (dupe.lastStatus === 'running' || isBackupSetBusy(dupe.id)) {
        res.errors.push(`"${name}": stop the backup before importing changes`);
        continue;
      }

      // Existing source roots are immutable. A config may append disjoint roots,
      // but removal or replacement requires an explicit future detach workflow.
      // This prevents an import from invalidating the delta catalog or turning a
      // removed Mirror root into an implicit Drive deletion.
      const sourceChange = classifySourceListChange(dupe.sourcePaths, payload.sourcePaths);
      if (sourceChange.kind === 'destructive') {
        res.errors.push(`"${name}": source removal or replacement is not allowed; add separate sources only`);
        continue;
      }
      try {
        if (sourceChange.kind === 'additive') {
          const additions = planSourceAdditions(dupe.sourcePaths, sourceChange.additions);
          verifySourceAdditionsSync(additions);
          payload.sourcePaths = [...dupe.sourcePaths, ...additions];
        } else {
          payload.sourcePaths = dupe.sourcePaths;
        }
      } catch (error) {
        res.errors.push(
          `"${name}": ${error instanceof SourceValidationError ? error.message : 'invalid source change'}`,
        );
        continue;
      }

      // A source addition keeps every retained catalog key valid. Only moving the
      // Drive target invalidates the catalog and still requires a rebuild.
      const targetChanged = dupe.targetPath !== payload.targetPath;
      backupSets.update(dupe.id, payload);
      if (targetChanged) catalog.clear(dupe.id);
      res.updated++;
    } else {
      backupSets.create(payload);
      res.imported++;
    }
  }
  return res;
}

/**
 * Auto-import backup sets from a config file in CONFIG_DIR (default /config) on
 * startup, so the container can be deployed declaratively (Ansible/GitOps): drop
 * a YAML or JSON file there and the jobs are created automatically - you only log
 * in once interactively. Idempotent (upsert by name). Accepts YAML or JSON
 * (YAML.parse handles both).
 */
export function autoImportFromConfigDir(): void {
  const dir = process.env.CONFIG_DIR || '/config';
  for (const name of ['backup-sets.yaml', 'backup-sets.yml', 'backup-sets.json']) {
    const p = path.join(dir, name);
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue; // not present
    }
    const res = importConfig(text);
    console.log(
      `[config] auto-imported ${p}: ${res.imported} added, ${res.updated} updated` +
        (res.errors.length ? `, ${res.errors.length} error(s): ${res.errors[0]}` : ''),
    );
    return;
  }
}
