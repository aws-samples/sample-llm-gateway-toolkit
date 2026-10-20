/**
 * Official Session Manager plugin release shipped with the CLI.
 */
export const PLUGIN_VERSION = '1.2.896.0';

/**
 * Pinned AWS archives and their extracted native executables.
 */
export const PLUGIN_ASSETS = {
  'win32-x64': {
    archive: 'windows/SessionManagerPlugin.zip',
    archiveSha256: 'b09adc18721b6e7a9888c98cb1a3aa55b681b8f12391fc1a983410cb1163f670',
    nestedArchive: 'package.zip',
    executable: 'bin/session-manager-plugin.exe',
    executableSha256: '03e9f869cdcb41c02060a4e8f8a07faabaae05f9940ec221d4a010b481a9ae30'
  },
  'linux-x64': {
    archive: 'ubuntu_64bit/session-manager-plugin.deb',
    archiveSha256: '53f51fcc67314a4bf85888a38a3967cd41f8d0f28a60a9469a63acf935ba713e',
    executable: 'usr/local/sessionmanagerplugin/bin/session-manager-plugin',
    executableSha256: '6f6971b0ea322215cb8b316cd290c09a13c916114149a6b4c65358c232be6130'
  },
  'linux-arm64': {
    archive: 'ubuntu_arm64/session-manager-plugin.deb',
    archiveSha256: '914eeca87b18b55356c58be197080f73742b3ca60d3823f0a45670dc9056aa9c',
    executable: 'usr/local/sessionmanagerplugin/bin/session-manager-plugin',
    executableSha256: '3f0efc482ce165fcf60a1ec44b40a700d48e7ec4b88cf0c339dd40d1620e98bf'
  },
  'darwin-arm64': {
    archive: 'mac_arm64/sessionmanager-bundle.zip',
    archiveSha256: '05c5ef53fb262de2fa1b46cf457890ee4152ec1dd8b2fdd94d028fa9b885ff36',
    executable: 'sessionmanager-bundle/bin/session-manager-plugin',
    executableSha256: '71258c3f7d5c15603a3b75bc8dfd62f595e8ec6ef3b8132ab59a005eebb7fa35'
  }
} as const;
