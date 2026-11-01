/** The compiled daemon's entry (scripts/build-cli.ts --entry daemon); see bin.ts. */
import { runDaemonCli } from './daemon-main';

runDaemonCli(process.argv.slice(2));
