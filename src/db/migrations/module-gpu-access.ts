import type { Migration } from './index.js';

/**
 * Adds `gpu_access` column to `container_configs`. Per-agent control over
 * GPU passthrough to the container (`--gpus` docker arg). Default `'none'`
 * keeps existing agents on CPU-only — opt-in to GPU per group via
 * `ncl groups config update --id <group> --gpu-access all` (or a specific
 * GPU id like `0` or `device=GPU-UUID`).
 *
 * Module migration — installs that don't need GPU never need to know.
 */
export const moduleGpuAccess: Migration = {
  version: 100,
  name: 'container-configs-gpu-access',
  up(db) {
    try {
      db.exec(`ALTER TABLE container_configs ADD COLUMN gpu_access TEXT NOT NULL DEFAULT 'none'`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate column') || msg.includes('already exists')) return;
      throw err;
    }
  },
};
