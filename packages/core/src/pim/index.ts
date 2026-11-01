/** Calendar and mail (docs/DESIGN.md, Calendar and mail). */
export * from './types';
export { PimService, PimError, DEFAULT_PIM_ENDPOINTS, type PimHost, type PimEndpoints, type AddCaldav, type AddImap } from './service';
export { PimStore, shortId, PROPOSAL_RETENTION_MS, PROPOSALS_PRUNE_JOB } from './store';
export { OAuthFlows, GOOGLE_CALLBACK, refreshSecret, relayCallback, relayReturn, isRelayReturn } from './oauth-flows';
export { attachPim, pimOf, pimFor, pimServices, forgetPim } from './registry';
