import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(root, 'apps/desktop/src/preload.template.cjs');
const outputPath = path.join(root, 'apps/desktop/src/preload.cjs');
const channelsPath = path.join(root, 'packages/study-contracts/ipc-channels.json');
const checkOnly = process.argv.includes('--check');

if (process.argv.slice(2).some((arg) => arg !== '--check' && arg !== '--write')) {
  throw new Error('Usage: node scripts/generate-preload.mjs [--check]');
}

const [template, rawChannels] = await Promise.all([
  readFile(templatePath, 'utf8'),
  readFile(channelsPath, 'utf8'),
]);
const channels = JSON.parse(rawChannels);
if (
  !channels ||
  typeof channels !== 'object' ||
  Array.isArray(channels) ||
  Object.keys(channels).length === 0 ||
  Object.values(channels).some((channel) => typeof channel !== 'string' || !channel.startsWith('sew:'))
) {
  throw new Error(`${channelsPath} must contain a non-empty map of sew:* channel names`);
}
if (new Set(Object.values(channels)).size !== Object.values(channels).length) {
  throw new Error(`${channelsPath} contains duplicate channel values`);
}

const marker = '__IPC_CHANNELS__';
if (template.split(marker).length !== 2) {
  throw new Error(`${templatePath} must contain exactly one ${marker} marker`);
}
const generated = template.replace(marker, JSON.stringify(channels, null, 2));
const current = await readFile(outputPath, 'utf8').catch(() => null);

if (checkOnly) {
  if (current !== generated) {
    console.error('apps/desktop/src/preload.cjs is stale; run pnpm gen:preload.');
    process.exitCode = 1;
  } else {
    console.log('Sandbox preload is up to date.');
  }
} else {
  if (current !== generated) await writeFile(outputPath, generated, 'utf8');
  console.log('Generated apps/desktop/src/preload.cjs from the IPC contract.');
}
