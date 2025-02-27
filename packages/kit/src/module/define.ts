import { promises as fsp } from 'fs'
import defu from 'defu'
import { applyDefaults } from 'untyped'
import consola from 'consola'
import { dirname } from 'pathe'
import type { Nuxt, NuxtTemplate, NuxtModule, ModuleOptions, ModuleDefinition } from '@nuxt/schema'
import { useNuxt, nuxtCtx } from '../context'
import { isNuxt2, checkNuxtCompatibility } from '../compatibility'
import { templateUtils, compileTemplate } from '../internal/template'

/**
 * Define a Nuxt module, automatically merging defaults with user provided options, installing
 * any hooks that are provided, and calling an optional setup function for full control.
 */
export function defineNuxtModule<OptionsT extends ModuleOptions> (definition: ModuleDefinition<OptionsT>): NuxtModule<OptionsT> {
  // Legacy format. TODO: Remove in RC
  if (typeof definition === 'function') {
    // @ts-ignore
    definition = definition(useNuxt())
    consola.warn('Module definition as function is deprecated and will be removed in the future versions', definition)
  }

  // Normalize definition and meta
  if (!definition.meta) { definition.meta = {} }
  if (!definition.meta.configKey) {
    // @ts-ignore TODO: Remove non-meta fallbacks in RC
    definition.meta.name = definition.meta.name || definition.name
    // @ts-ignore
    definition.meta.configKey = definition.meta.configKey || definition.configKey || definition.meta.name
  }

  // Resolves module options from inline options, [configKey] in nuxt.config, defaults and schema
  function getOptions (inlineOptions?: OptionsT, nuxt: Nuxt = useNuxt()) {
    const configKey = definition.meta.configKey || definition.meta.name
    const _defaults = typeof definition.defaults === 'function' ? definition.defaults(nuxt) : definition.defaults
    let _options = defu(inlineOptions, nuxt.options[configKey], _defaults) as OptionsT
    if (definition.schema) {
      _options = applyDefaults(definition.schema, _options) as OptionsT
    }
    return Promise.resolve(_options)
  }

  // Module format is always a simple function
  async function normalizedModule (inlineOptions: OptionsT, nuxt: Nuxt) {
    if (!nuxt) {
      nuxt = useNuxt() || this.nuxt /* invoked by nuxt 2 */
    }

    // Avoid duplicate installs
    const uniqueKey = definition.meta.name || definition.meta.configKey
    if (uniqueKey) {
      nuxt.options._requiredModules = nuxt.options._requiredModules || {}
      if (nuxt.options._requiredModules[uniqueKey]) {
        // TODO: Notify user if inline options is provided since will be ignored!
        return
      }
      nuxt.options._requiredModules[uniqueKey] = true
    }

    // Check compatibility contraints
    if (definition.meta.compatibility) {
      const issues = await checkNuxtCompatibility(definition.meta.compatibility, nuxt)
      if (issues.length) {
        consola.warn(`Module \`${definition.meta.name}\` is disabled due to incompatibility issues:\n${issues.toString()}`)
        return
      }
    }

    // Prepare
    nuxt2Shims(nuxt)

    // Resolve module and options
    const _options = await getOptions(inlineOptions, nuxt)

    // Register hooks
    if (definition.hooks) {
      nuxt.hooks.addHooks(definition.hooks)
    }

    // Call setup
    await definition.setup?.call(null, _options, nuxt)
  }

  // Define getters for options and meta
  normalizedModule.getMeta = () => Promise.resolve(definition.meta)
  normalizedModule.getOptions = getOptions

  return normalizedModule as NuxtModule<OptionsT>
}

// -- Nuxt 2 compatibility shims --
const NUXT2_SHIMS_KEY = '__nuxt2_shims_key__'
function nuxt2Shims (nuxt: Nuxt) {
  // Avoid duplicate install and only apply to Nuxt2
  if (!isNuxt2(nuxt) || nuxt[NUXT2_SHIMS_KEY]) { return }
  nuxt[NUXT2_SHIMS_KEY] = true

  // Allow using nuxt.hooks
  // @ts-ignore Nuxt 2 extends hookable
  nuxt.hooks = nuxt

  // Allow using useNuxt()
  if (!nuxtCtx.use()) {
    nuxtCtx.set(nuxt)
    nuxt.hook('close', () => nuxtCtx.unset())
  }

  // Support virtual templates with getContents() by writing them to .nuxt directory
  let virtualTemplates: NuxtTemplate[]
  nuxt.hook('builder:prepared', (_builder, buildOptions) => {
    virtualTemplates = buildOptions.templates.filter(t => t.getContents)
    for (const template of virtualTemplates) {
      buildOptions.templates.splice(buildOptions.templates.indexOf(template), 1)
    }
  })
  nuxt.hook('build:templates', async (templates) => {
    const context = {
      nuxt,
      utils: templateUtils,
      app: {
        dir: nuxt.options.srcDir,
        extensions: nuxt.options.extensions,
        plugins: nuxt.options.plugins,
        templates: [
          ...templates.templatesFiles,
          ...virtualTemplates
        ],
        templateVars: templates.templateVars
      }
    }
    for await (const template of virtualTemplates) {
      const contents = await compileTemplate({ ...template, src: '' }, context)
      await fsp.mkdir(dirname(template.dst), { recursive: true })
      await fsp.writeFile(template.dst, contents)
    }
  })
}
