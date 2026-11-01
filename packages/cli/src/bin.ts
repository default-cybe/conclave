/**
 * The compiled conclave binary's entry (scripts/build-cli.ts). It runs the CLI
 * without asking import.meta.main, which a Windows build answered false: the
 * hub then exited at once with code 0 and printed nothing.
 */
import { runCli } from './index';

runCli(process.argv.slice(2));
