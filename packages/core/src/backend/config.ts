import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { GenerateRegistryConfig } from './types.ts'

/**
 * Identity helper to define a tuyau config in `config/tuyau.ts` with type safety.
 *
 * @example
 * // tuyau.config.ts (at the app root)
 * import { defineConfig } from '@tuyau/core/config'
 * export default defineConfig({ errorResponseType: '...' })
 */
export function defineConfig(config: GenerateRegistryConfig): GenerateRegistryConfig {
  return config
}

/**
 * Candidate config locations, in priority order. A root-level `tuyau.config.*`
 * is framework-agnostic (independent of AdonisJS's configurable config dir);
 * `config/tuyau.*` is supported for standard layouts.
 */
const CANDIDATES = ['tuyau.config', 'config/tuyau']

/**
 * Load the tuyau config if present. Single source of truth shared by both the
 * assembler hook and the `tuyau:generate` ace command. Empty config if none.
 */
export async function loadTuyauConfig(appRoot: string): Promise<GenerateRegistryConfig> {
  for (const base of CANDIDATES) {
    for (const ext of ['ts', 'js', 'mjs']) {
      const filePath = join(appRoot, `${base}.${ext}`)
      if (!existsSync(filePath)) continue
      try {
        const mod = await import(pathToFileURL(filePath).href)
        return (mod.default ?? mod.config ?? {}) as GenerateRegistryConfig
      } catch (error) {
        if (process.env.TUYAU_DEBUG)
          console.error(`[tuyau] failed to load ${base}:`, (error as Error).message)
      }
    }
  }
  return {}
}
