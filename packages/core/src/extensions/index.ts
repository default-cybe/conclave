export * from './types';
export { BUILTIN_AGENTS, builtinAgents } from './builtin-agents';
export {
  defaultModelMapper,
  loadAgentsFromDir,
  loadSkillsFromDir,
  loadSkillFolder,
  loadCommandsFromDir,
  mergeScopes,
  type ModelMapper,
  type ScanDirs,
  type LoadResult,
} from './loader';
export { Extensions, resolveName, type ExtensionsOptions, type InventoryItem, type ComponentKind } from './registry';
export { PluginManager, parsePluginSource, expandRoot, translateMcpVars, pluginComponentName, pluginMcpKey, type PluginManagerOptions } from './plugins';
export { Hooks, matcherMatches, ifMatches, mergeOutcomes, applyJsonOutput, type HooksOptions } from './hooks';
export * as compat from './compat';
export { McpManager, type McpManagerOptions } from './mcp';
export { expandCommand, substituteArgs, substituteArgsStyled, splitArgs, type ExpandContext } from './commands';
export { loadProjectInstructions, type InstructionFile } from './instructions';
export { syncToClis, type SyncInput } from './cli-sync';
