import './types.ts'

import { cwd } from 'node:process'

import type { AllHooks } from '@adonisjs/assembler/types'

import { RegistryGenerator } from './registry_generator.ts'
import { RegistryTypeResolver } from './type_resolver.ts'
import { GenerateRegistryConfig } from './types.ts'

/**
 * AdonisJS assembler hook that scans routes and generates
 * the tuyau typed client registry files (runtime, schema, tree).
 *
 * Types are *built* (fully resolved into structural literals) at generation
 * time via {@link RegistryTypeResolver}, so consumers no longer need the backend
 * source on their TypeScript path. The resolver is kept warm across HMR reloads
 * and only re-stringifies routes whose dependencies changed.
 */
export function generateRegistry(options?: GenerateRegistryConfig): AllHooks['init'][number] {
  const generator = new RegistryGenerator(options)
  const outputDir = options?.output ?? './.adonisjs/client/registry'
  const appRoot = cwd()
  const resolver = new RegistryTypeResolver({ appRoot })

  return {
    async run(_, hooks) {
      hooks.add('routesScanning', (_, routesScanner) => {
        routesScanner.filter((route) => generator.filterRoute(route))
      })

      hooks.add('routesScanned', async (devServer, routesScanner) => {
        const startTime = process.hrtime()
        const routes = routesScanner.getScannedRoutes()

        let resolved: Awaited<ReturnType<RegistryTypeResolver['resolve']>> | undefined
        try {
          resolved = await resolver.resolve(generator.collectResolvable(routes))
        } catch (error) {
          devServer.ui.logger.warning(
            `tuyau: failed to build resolved types, falling back to inference (${(error as Error).message})`,
          )
        }

        await generator.writeOutput({ outputDir, routes, resolved })

        devServer.ui.logger.info(`tuyau: created api client registry (${outputDir})`, {
          startTime,
        })
      })
    },
  } satisfies AllHooks['init'][number]
}
