import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ASSETS } from './plugin-assets.ts';

/**
 * Resolves and verifies the bundled plugin for this machine.
 */
export const getPluginPath = async () => {
  const platform = `${process.platform}-${process.arch}`;
  const asset = Object.entries(PLUGIN_ASSETS)
    .find(([name]) => name === platform)?.[1];

  if (!asset) {
    throw new Error(
      `SSM access is not supported on ${platform}. ` +
      `Supported platforms: ${Object.keys(PLUGIN_ASSETS).join(', ')}.`
    );
  }

  const executable = fileURLToPath(new URL(
    `../../vendor/session-manager-plugin/${platform}/${posix.basename(asset.executable)}`,
    import.meta.url
  ));

  try {
    const [bytes] = await Promise.all([
      readFile(executable),
      access(executable, constants.X_OK)
    ]);
    const checksum = createHash('sha256').update(bytes).digest('hex');

    if (checksum !== asset.executableSha256) {
      throw new Error('The bundled Session Manager plugin checksum does not match.');
    }

    return (executable);
  } catch (error) {
    throw new Error(
      'The bundled Session Manager plugin is missing, damaged, or not executable. ' +
      'Reinstall the gateway CLI.',
      { cause: error }
    );
  }
};
