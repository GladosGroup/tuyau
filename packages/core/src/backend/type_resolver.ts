import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'

import type TS from 'typescript'

/**
 * Inference expression strings for a single route. Only fields that need
 * resolution are present (trivial `{}` / `unknown` fields are omitted by the caller).
 */
export interface RouteExpressions {
  body?: string
  query?: string
  response?: string
  errorResponse?: string
}

export type ResolvedFields = RouteExpressions

export interface ResolvableRoute {
  name: string
  expressions: RouteExpressions
}

const FIELD_KEYS = ['body', 'query', 'response', 'errorResponse'] as const
type FieldKey = (typeof FIELD_KEYS)[number]

/**
 * Bump whenever the resolution logic (RESOLVE_HELPER, cleanup, depth…) changes,
 * so previously persisted disk caches are discarded instead of serving stale output.
 */
const CACHE_VERSION = 5

/**
 * Deep "prettify" type used to force TypeScript to fully expand a type into a
 * structural literal, dropping all `import('...')` references and named aliases.
 * Depth-capped to avoid "excessively deep" errors on recursive model relations.
 * Functions and `Date` are passed through untouched.
 */
const RESOLVE_HELPER = `type __TuyauResolve<T, __D extends readonly any[] = []> =
  __D['length'] extends 4 ? T :
  T extends (...args: any[]) => any ? T :
  T extends Date ? T :
  T extends Array<infer U> ? Array<__TuyauResolve<U, readonly [...__D, 1]>> :
  T extends object
    ? string extends keyof T
      ? T
      : number extends keyof T
        ? T
        : { [K in keyof T]: __TuyauResolve<T[K], readonly [...__D, 1]> }
    : T`

/**
 * Resolves tuyau registry inference expressions (e.g. `ExtractResponse<Awaited<…>>`)
 * into concrete, fully-flattened TypeScript type strings at generation time.
 *
 * Keeps a TypeScript `LanguageService` warm across HMR reloads. A per-route memo
 * — persisted to disk — is keyed on the expression plus the mtimes of the route's
 * import closure, so a warm restart serves unchanged routes from disk WITHOUT
 * building a program, and only types whose dependencies changed are re-stringified.
 */
export class RegistryTypeResolver {
  #appRoot: string
  #ts?: typeof TS
  #service?: TS.LanguageService
  #options?: TS.CompilerOptions
  #host?: TS.LanguageServiceHost
  #rootFiles: string[] = []
  #probePath: string
  #probeContent = ''
  #probeVersion = 0

  /** routeName -> memo entry. `deps` lets us recompute the key (and thus detect
   * staleness) from file mtimes WITHOUT building a TypeScript program. */
  #memo = new Map<string, { key: string; resolved: ResolvedFields; deps: string[] }>()
  /** source file -> import closure (set of app source files it transitively pulls in) */
  #closureCache = new Map<string, Set<string>>()
  #cachePath: string
  #cacheLoaded = false

  #available = true

  constructor(options: { appRoot: string }) {
    this.#appRoot = options.appRoot
    // TypeScript normalizes all internal paths to forward slashes; match that so
    // host callbacks and `program.getSourceFile` lookups agree on Windows.
    this.#probePath = join(this.#appRoot, '.adonisjs', '.tuyau-types-probe.ts').replace(/\\/g, '/')
    // Persisted across restarts so the expensive cold resolve is paid only once.
    this.#cachePath = join(this.#appRoot, 'node_modules', '.cache', 'tuyau', 'types-cache.json')
  }

  get available() {
    return this.#available
  }

  /**
   * Lazily load TypeScript (from the host app) and set up the language service.
   * Returns false when TypeScript cannot be loaded.
   */
  async #ensureService(): Promise<boolean> {
    if (this.#service) return true
    if (!this.#available) return false

    try {
      const tsModule = await import('typescript')
      this.#ts = tsModule.default ?? tsModule
    } catch {
      this.#available = false
      return false
    }

    const ts = this.#ts!
    const configPath = ts.findConfigFile(this.#appRoot, ts.sys.fileExists, 'tsconfig.json')
    if (!configPath) {
      this.#available = false
      return false
    }

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, this.#appRoot)
    this.#options = { ...parsed.options, noEmit: true, skipLibCheck: true, declaration: false }
    this.#rootFiles = parsed.fileNames.filter((f) => f !== this.#probePath)

    const self = this
    this.#host = {
      getScriptFileNames: () => [...self.#rootFiles, self.#probePath],
      getScriptVersion: (f) =>
        f === self.#probePath ? `probe-${self.#probeVersion}` : self.#fileVersion(f),
      getScriptSnapshot: (f) => {
        if (f === self.#probePath) return ts.ScriptSnapshot.fromString(self.#probeContent)
        const text = ts.sys.readFile(f)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => self.#appRoot,
      getCompilationSettings: () => self.#options!,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => f === self.#probePath || ts.sys.fileExists(f),
      readFile: (f, enc) => (f === self.#probePath ? self.#probeContent : ts.sys.readFile(f, enc)),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    }

    this.#service = ts.createLanguageService(this.#host, ts.createDocumentRegistry())
    return true
  }

  /**
   * mtime-based file version. Uses `node:fs` directly (not `ts.sys`) so it works
   * during the warm staleness check, before TypeScript has been loaded.
   */
  #fileVersion(file: string): string {
    try {
      return String(statSync(file).mtimeMs)
    } catch {
      return '0'
    }
  }

  /**
   * Extract `import('…')` module specifiers from an expression string.
   */
  #specifiersOf(expr: string): string[] {
    const out: string[] = []
    for (const m of expr.matchAll(/import\('([^']+)'\)/g)) out.push(m[1])
    return out
  }

  /**
   * Resolve a module specifier (from the probe location) to a source file path.
   */
  #resolveSpecifier(specifier: string): string | undefined {
    const ts = this.#ts!
    const res = ts.resolveModuleName(specifier, this.#probePath, this.#options!, this.#host!)
    return res.resolvedModule?.resolvedFileName
  }

  /**
   * Compute the transitive import closure of a source file, restricted to app
   * sources (skips node_modules / lib). Over-approximates the set of files whose
   * change can affect a type that depends on `entry`. Cached per run-batch.
   */
  #importClosure(entry: string): Set<string> {
    const cached = this.#closureCache.get(entry)
    if (cached) return cached

    const ts = this.#ts!
    const program = this.#service!.getProgram()
    const seen = new Set<string>()
    const stack = [entry]

    while (stack.length) {
      const file = stack.pop()!
      if (seen.has(file) || file.includes('node_modules')) continue
      seen.add(file)

      const sf = program?.getSourceFile(file)
      if (!sf) continue

      const specs: string[] = []
      const visit = (node: TS.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          specs.push(node.moduleSpecifier.text)
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
          const lit = node.argument.literal
          if (ts.isStringLiteral(lit)) specs.push(lit.text)
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          specs.push(node.arguments[0].text)
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)

      for (const spec of specs) {
        const resolved = ts.resolveModuleName(spec, file, this.#options!, this.#host!)
        const target = resolved.resolvedModule?.resolvedFileName
        if (target && !target.includes('node_modules')) stack.push(target)
      }
    }

    this.#closureCache.set(entry, seen)
    return seen
  }

  /**
   * Build the staleness key for a route from its expressions plus the mtimes of
   * its dependency files. Pure string math — no TypeScript program required, so
   * it can run on a warm restart using `deps` loaded from the disk cache.
   */
  #keyFromDeps(route: ResolvableRoute, deps: string[]): string {
    const exprs = FIELD_KEYS.map((k) => route.expressions[k] ?? '').join(' ')
    const versions = deps.map((f) => this.#fileVersion(f)).join(',')
    return `${exprs}|${versions}`
  }

  /**
   * Compute the sorted dependency file list (import closure) for a route.
   * Requires a built program (uses the module graph). Used only for stale routes.
   */
  #computeDeps(route: ResolvableRoute): string[] {
    const closure = new Set<string>()
    for (const k of FIELD_KEYS) {
      const expr = route.expressions[k]
      if (!expr) continue
      for (const spec of this.#specifiersOf(expr)) {
        const file = this.#resolveSpecifier(spec)
        if (file) for (const dep of this.#importClosure(file)) closure.add(dep)
      }
    }
    return [...closure].sort()
  }

  /**
   * Resolve all routes. Returns a map of routeName -> resolved field strings.
   * Routes that fail to resolve are omitted.
   *
   * Fast path: routes whose expressions and dependency mtimes are unchanged are
   * served from the (disk-persisted) cache without ever building a TS program.
   * A program is built only when at least one route is stale.
   */
  async resolve(routes: ResolvableRoute[]): Promise<Map<string, ResolvedFields>> {
    const result = new Map<string, ResolvedFields>()
    this.#loadCache()

    /** Warm path: decide staleness purely from cached deps + current mtimes. */
    const stale: ResolvableRoute[] = []
    for (const route of routes) {
      const memo = this.#memo.get(route.name)
      if (memo && this.#keyFromDeps(route, memo.deps) === memo.key) {
        result.set(route.name, memo.resolved)
      } else {
        stale.push(route)
      }
    }

    if (process.env.TUYAU_DEBUG)
      console.error(`[tuyau] resolving ${stale.length}/${routes.length} routes (rest from cache)`)

    if (stale.length === 0) return result

    /** Stale routes exist → spin up TypeScript and build a single program. */
    if (!(await this.#ensureService())) {
      if (process.env.TUYAU_DEBUG) console.error('[tuyau] ensureService=false')
      return result
    }

    const ts = this.#ts!
    this.#closureCache.clear()

    const aliasMap = new Map<string, { route: string; field: FieldKey }>()
    this.#probeContent = this.#buildProbe(stale, aliasMap)
    this.#probeVersion++

    const program = this.#service!.getProgram()
    if (!program) {
      if (process.env.TUYAU_DEBUG) console.error('[tuyau] no program')
      return result
    }
    const checker = program.getTypeChecker()
    const probeSf = program.getSourceFile(this.#probePath)
    if (!probeSf) {
      if (process.env.TUYAU_DEBUG)
        console.error('[tuyau] probe not in program:', this.#probePath, 'stale:', stale.length)
      return result
    }

    const flags =
      ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.InTypeAlias |
      ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType

    const resolvedPerRoute = new Map<string, ResolvedFields>()
    ts.forEachChild(probeSf, (node) => {
      if (!ts.isTypeAliasDeclaration(node)) return
      const info = aliasMap.get(node.name.text)
      if (!info) return

      const sym = checker.getSymbolAtLocation(node.name)
      if (!sym) return
      const type = checker.getDeclaredTypeOfSymbol(sym)
      const str = this.#cleanup(checker.typeToString(type, node, flags))

      const entry = resolvedPerRoute.get(info.route) ?? {}
      entry[info.field] = str
      resolvedPerRoute.set(info.route, entry)
    })

    for (const route of stale) {
      const resolved = resolvedPerRoute.get(route.name) ?? {}
      const deps = this.#computeDeps(route)
      const key = this.#keyFromDeps(route, deps)
      this.#memo.set(route.name, { key, resolved, deps })
      result.set(route.name, resolved)
    }

    this.#saveCache()
    return result
  }

  /**
   * Load the persisted memo from disk (once per resolver instance).
   */
  #loadCache() {
    if (this.#cacheLoaded) return
    this.#cacheLoaded = true
    try {
      const data = JSON.parse(readFileSync(this.#cachePath, 'utf8')) as {
        version?: number
        routes?: Record<string, { key: string; resolved: ResolvedFields; deps: string[] }>
      }
      if (data.version !== CACHE_VERSION || !data.routes) return
      for (const [name, entry] of Object.entries(data.routes)) this.#memo.set(name, entry)
      if (process.env.TUYAU_DEBUG)
        console.error(`[tuyau] loaded ${this.#memo.size} cached routes from disk`)
    } catch {
      /* no cache yet */
    }
  }

  /**
   * Persist the memo to disk.
   */
  #saveCache() {
    try {
      mkdirSync(dirname(this.#cachePath), { recursive: true })
      const routes: Record<string, unknown> = {}
      for (const [name, entry] of this.#memo) routes[name] = entry
      writeFileSync(this.#cachePath, JSON.stringify({ version: CACHE_VERSION, routes }))
    } catch (error) {
      if (process.env.TUYAU_DEBUG)
        console.error('[tuyau] failed to persist cache:', (error as Error).message)
    }
  }

  /**
   * Build the probe file content with one type alias per (route, field).
   */
  #buildProbe(
    routes: ResolvableRoute[],
    aliasMap?: Map<string, { route: string; field: FieldKey }>,
  ): string {
    const lines: string[] = [
      '/* eslint-disable */',
      "import type { ExtractBody, ExtractErrorResponse, ExtractQuery, ExtractQueryForGet, ExtractResponse } from '@tuyau/core/types'",
      "import type { InferInput, SimpleError } from '@vinejs/vine/types'",
      '',
      'type ParamValue = string | number | bigint | boolean',
      RESOLVE_HELPER,
      '',
    ]

    let i = 0
    for (const route of routes) {
      for (const field of FIELD_KEYS) {
        const expr = route.expressions[field]
        if (!expr) continue
        const aliasName = `T${i++}`
        aliasMap?.set(aliasName, { route: route.name, field })
        lines.push(`export type ${aliasName} = __TuyauResolve<${expr}>`)
      }
    }

    return lines.join('\n') + '\n'
  }

  /**
   * Sanitize TypeScript's printed type. Inline `import("…")` type references to
   * node_modules packages are valid and self-contained, so they are kept. Any
   * surviving reference to *backend* source (a type too deep to inline within the
   * recursion cap) is replaced with `any`, so the emitted schema never depends on
   * the backend's TS path (which consumers no longer include).
   */
  #cleanup(str: string): string {
    return this.#sortObjectMembers(
      this.#simplifyAny(this.#portableGlobals(this.#replaceBackendImports(str))),
    )
  }

  /**
   * Deterministically order the members of every object-type literal alphabetically
   * by property name. TypeScript's `typeToString` does not guarantee a stable member
   * order across program builds, so an otherwise-unchanged type could be printed with
   * its fields in a different order on each regeneration — producing spurious diffs in
   * the emitted `schema.d.ts`. Parsing the printed type and re-stitching it from the
   * AST reorders only object members (unions, tuples, mapped types and signature
   * internals are left untouched) while preserving the original formatting. On any
   * parse failure the input is returned unchanged.
   */
  #sortObjectMembers(str: string): string {
    const ts = this.#ts
    if (!ts) return str

    try {
      const src = `type __T = ${str}`
      const sf = ts.createSourceFile('__tuyau_sort.ts', src, ts.ScriptTarget.Latest, true)
      const stmt = sf.statements[0]
      if (!stmt || !ts.isTypeAliasDeclaration(stmt)) return str

      const keyOf = (m: TS.TypeElement): string => {
        const name = (m as { name?: TS.PropertyName }).name
        if (name) {
          if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
            return name.text
          return name.getText(sf)
        }
        // Signatures without a name (index/call/construct) sort after named members,
        // ordered by their own text so the result stays stable.
        return '￿' + m.getText(sf)
      }

      const emit = (node: TS.Node): string => {
        if (ts.isTypeLiteralNode(node)) {
          if (node.members.length === 0) return '{}'
          const sorted = [...node.members].sort((a, b) => {
            const ka = keyOf(a)
            const kb = keyOf(b)
            return ka < kb ? -1 : ka > kb ? 1 : 0
          })
          // Each member's text includes its trailing `;`; strip it before re-joining.
          return '{ ' + sorted.map((m) => emit(m).replace(/;\s*$/, '')).join('; ') + ' }'
        }

        let out = ''
        let cursor = node.getStart(sf)
        node.forEachChild((child) => {
          out += src.slice(cursor, child.getStart(sf)) + emit(child)
          cursor = child.getEnd()
        })
        out += src.slice(cursor, node.getEnd())
        return out
      }

      return emit(stmt.type)
    } catch {
      return str
    }
  }

  /**
   * Replace Node-only global type references with portable equivalents. The
   * emitted schema is consumed by frontend apps without `@types/node`, so any
   * `NodeJS.*` reference resolves to an unknown namespace there. `NodeJS.
   * NonSharedUint8Array` (how Node types `Uint8Array` for Blob/File methods) maps
   * to the DOM-available `Uint8Array`; anything else `NodeJS.*` falls back to `any`.
   */
  #portableGlobals(str: string): string {
    return str
      .replace(/\bNodeJS\.(?:Non)?SharedUint8Array\b/g, 'Uint8Array')
      .replace(/\bNodeJS\.[A-Za-z0-9_]+/g, 'any')
  }

  /**
   * Replace `import("…").X` references to backend source with `any`. Crucially, a
   * replaced reference may carry trailing generic arguments (e.g.
   * `import("…").Readable<NodeJS.NonSharedUint8Array>`). `any` takes no type
   * arguments, so the balanced `<…>` that follows must be consumed too — otherwise
   * the emitted `any<…>` is a syntax error.
   */
  #replaceBackendImports(str: string): string {
    const re = /import\("([^"]+)"\)((?:\.[A-Za-z0-9_$]+)*)/g
    let out = ''
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(str))) {
      out += str.slice(last, m.index)
      if (m[1].includes('node_modules')) {
        out += m[0]
        last = re.lastIndex
      } else {
        const end = this.#skipTypeArgs(str, re.lastIndex)
        out += 'any'
        last = end
        re.lastIndex = end
      }
    }
    return out + str.slice(last)
  }

  /**
   * If a balanced generic argument list `<…>` starts at (or after whitespace from)
   * `i`, return the index just past its closing `>`. Otherwise return `i`. `=>`
   * arrows inside the args are ignored so they don't prematurely close the group.
   */
  #skipTypeArgs(str: string, i: number): number {
    let j = i
    while (j < str.length && /\s/.test(str[j])) j++
    if (str[j] !== '<') return i
    let depth = 0
    for (; j < str.length; j++) {
      const ch = str[j]
      if (ch === '<') depth++
      else if (ch === '>' && str[j - 1] !== '=') {
        depth--
        if (depth === 0) return j + 1
      }
    }
    return i
  }

  /**
   * Collapse unions that contain a bare `any` member down to `any` (since `any`
   * absorbs the union). This tidies the noisy nested output produced when a
   * recursive type — e.g. a JSON column — has had its leaves replaced by `any`.
   */
  #simplifyAny(str: string): string {
    let prev: string
    let out = str
    do {
      prev = out
      // Innermost parenthesised group whose top-level union contains `any` → any.
      // Skip function parameter lists / arrow types: a `:` or `=>` at this level
      // means it's `(arg: T)` not a `(A | B)` union, and must not be collapsed.
      out = out.replace(/\(([^(){}]*)\)/g, (match, inner: string) => {
        if (inner.includes(':') || inner.includes('=>')) return match
        const parts = inner.split('|').map((p) => p.trim())
        return parts.includes('any') ? 'any' : match
      })
      // any[] elements and duplicate anys
      out = out.replace(/\bany(\s*\|\s*any)+/g, 'any')
      out = out.replace(/\bany\s*\|\s*undefined/g, 'any')
    } while (out !== prev)
    return out
  }

  /**
   * Drop the in-memory program. Called on shutdown (optional).
   */
  dispose() {
    this.#service?.dispose()
    this.#service = undefined
  }
}
