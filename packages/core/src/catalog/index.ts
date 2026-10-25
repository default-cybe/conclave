/** Discover catalog (docs/design/ECOSYSTEM.md). */
export * from './recommended';
export * from './types';
export * from './packs';
export { CatalogService, recipeItem, suggestionItem, type CatalogServiceOptions } from './service';
export { CatalogInstaller, CatalogError, fillPlaceholders, hrefFor, type CatalogHost } from './install';
export { CatalogStore } from './store';
export { HUB_INSTALLERS, UV_INSTALLER_URL, UV_VERSION, TailLines, canRunOnHub, firstProgram, hubSetupBins, hubSetupOffer, rootCommand, uvToolCommand, type HubFacts, type HubInstaller } from './hub-setup';
export { CatalogHttp, OfflineError } from './http';
export { GithubClient } from './github';
export { McpRegistry, deriveFromServerJson, registryToItem, namespaceMatches } from './registry';
export { detectKinds, deriveMcpFromRepo } from './detect';
export { importAgenticTools } from './tasks-import';
