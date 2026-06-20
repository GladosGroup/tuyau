import './types.ts'

import { cwd } from 'node:process'

import type { AllHooks, ScannedRoute } from '@adonisjs/assembler/types'

import { RegistryGenerator } from './registry_generator.ts'
import { RegistryTypeResolver } from './type_resolver.ts'
import { loadTuyauConfig } from './config.ts'
import { GenerateRegistryConfig } from './types.ts'

/**
 * Resolve every route's types and write the registry files (index.ts,
 * schema.d.ts, tree.d.ts). Shared by the assembler hook and the
 * `tuyau:generate` ace command so both produce identical output.
 */
export async function writeRegistry(options: {
  generator: RegistryGenerator
  resolver: RegistryTypeResolver
  routes: ScannedRoute[]
  outputDir: string
}) {
  const { generator, resolver, routes, outputDir } = options
  const resolved = await resolver.resolve(generator.collectResolvable(routes))
  await generator.writeOutput({ outputDir, routes, resolved })
  return resolved
}

/**
 * AdonisJS assembler hook that scans routes and (re)generates the tuyau client
 * registry with *built* types — fully resolved structural types, no inference.
 *
 * The resolution can be expensive on a cold cache, so on HMR it runs in the
 * **background** (non-blocking): the dev server is never stalled and the registry
 * already on disk (from a previous run or `node ace tuyau:generate`) stays valid
 * until the background pass swaps in the updated types. Subsequent passes are
 * fast thanks to the resolver's per-route, disk-persisted cache.
 */
export function generateRegistry(options?: GenerateRegistryConfig): AllHooks['init'][number] {
  const appRoot = cwd()
  const resolver = new RegistryTypeResolver({ appRoot })

  let generator: RegistryGenerator
  let outputDir = './.adonisjs/client/registry'

  /** Single-flight background runner: coalesces overlapping HMR triggers. */
  let running = false
  let queued: ScannedRoute[] | null = null

  type Logger = { info: (msg: string) => void; warning: (msg: string) => void }
  const runInBackground = (routes: ScannedRoute[], logger: Logger) => {
    if (running) {
      queued = routes
      return
    }
    running = true
    void (async () => {
      try {
        await writeRegistry({ generator, resolver, routes, outputDir })
        logger.info('tuyau: updated client registry (built types)')
      } catch (error) {
        logger.warning(`tuyau: failed to build registry types (${(error as Error).message})`)
      } finally {
        running = false
        if (queued) {
          const next = queued
          queued = null
          runInBackground(next, logger)
        }
      }
    })()
  }

  return {
    async run(_, hooks) {
      const config = options ?? (await loadTuyauConfig(appRoot))
      generator = new RegistryGenerator(config)
      outputDir = config.output ?? outputDir

      hooks.add('routesScanning', (_, routesScanner) => {
        routesScanner.filter((route) => generator.filterRoute(route))
      })

      hooks.add('routesScanned', async (devServer, routesScanner) => {
        const routes = routesScanner.getScannedRoutes()
        // Fire-and-forget: do not block the dev server on type resolution.
        runInBackground(routes, devServer.ui.logger)
      })
    },
  } satisfies AllHooks['init'][number]
}
