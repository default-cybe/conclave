/**
 * Is a folder there on a device? The folder pickers ask before Choose or
 * Start (GET /api/devices/:device/folder), and the hub asks again when a
 * session is made with a cwd, so no client can skip it. The same words on
 * both sides. No node imports: the web app uses this file too.
 */

export interface FolderCheckDto {
  /** The path as the device resolves it ("~" expanded). */
  path: string;
  /** A folder is there (a file at the path is not one). */
  exists: boolean;
}

/** The inline error under a folder field, and the hub's 400 for createSession. */
export function noFolderLine(path: string, device: string): string {
  return `No folder at ${path} on ${device}`;
}

/** An offline device cannot be asked: the pickers say so and offer "Use anyway". */
export function offlineFolderLine(device: string): string {
  return `${device} is offline, the folder can't be checked`;
}
