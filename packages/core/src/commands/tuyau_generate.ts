import { fileURLToPath } from 'node:url'

import { BaseCommand } from '@adonisjs/core/ace'
import { RoutesScanner } from '@adonisjs/assembler/routes_scanner'

import { RegistryGenerator } from '../backend/registry_generator.ts'
import { RegistryTypeResolver } from '../backend/type_resolver.ts'
import { loadTuyauConfig } from '../backend/config.ts'
import { writeRegistry } from '../backend/generate_registry.ts'

/**
 * Generate the tuyau client registry with fully *built* (resolved) types.
 *
 * Boots the app to read its committed routes, runs the same static scan the
 * assembler uses, then resolves every route type into a concrete structural
 * type. Use this once before `pnpm dev` (or in CI) so the registry already
 * exists; the dev-server hook then keeps it fresh in the background.
 */
export default class TuyauGenerate extends BaseCommand {
  static commandName = 'tuyau:generate'
  static description = 'Generate the Tuyau client registry with fully built (resolved) types'
  static options = { startApp: true }

  async run() {
    const appRoot = fileURLToPath(this.app.appRoot)
    const router = await this.app.container.make('router')
    if (!router.commited) router.commit()

    const config = await loadTuyauConfig(appRoot)
    const outputDir = config.output ?? './.adonisjs/client/registry'

    const generator = new RegistryGenerator(config)
    const resolver = new RegistryTypeResolver({ appRoot })

    /**
     * Statically scan the runtime route list (per domain) to extract the
     * request/response type expressions, exactly like the assembler does.
     */
    const scanner = new RoutesScanner(appRoot, [])
    scanner.filter((route) => generator.filterRoute(route))

    const routesList = router.toJSON() as Record<string, any[]>
    for (const domain of Object.keys(routesList)) {
      await scanner.scan(routesList[domain])
    }
    const routes = scanner.getScannedRoutes()

    this.logger.info(`tuyau: resolving types for ${routes.length} routes (this can take a while cold)…`)
    const resolved = await writeRegistry({ generator, resolver, routes, outputDir })
    this.logger.success(
      `tuyau: registry generated — ${resolved.size}/${routes.length} routes resolved (${outputDir})`,
    )
  }
}
