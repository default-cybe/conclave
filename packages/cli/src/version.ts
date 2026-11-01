import pkg from '../package.json';

export const VERSION: string = (pkg as { version: string }).version;
