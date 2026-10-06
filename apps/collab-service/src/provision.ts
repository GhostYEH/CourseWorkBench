import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { COLLAB_PROTOCOL_VERSION, learnerUidSchema } from '@sew/study-contracts';
import { CollabServiceStore } from '@sew/study-storage';
import { loadCollabConfig, parseArgs } from './config';

const argv = process.argv.slice(2);
const args = parseArgs(argv);
if (typeof args['uid'] !== 'string' || typeof args['data-dir'] !== 'string') {
  throw new Error(
    'Usage: node apps/collab-service/provision.mjs --data-dir <目录> --uid <本人UID>',
  );
}
const uid = learnerUidSchema.parse(args['uid']);
const config = loadCollabConfig(argv, process.env, COLLAB_PROTOCOL_VERSION);
mkdirSync(config.dataDir, { recursive: true });
const store = CollabServiceStore.open({ file: join(config.dataDir, 'collab.db') });
try {
  const activationToken = store.issueRegistrationClaim(uid);
  // Deliberate one-time administrator output; the token itself is never persisted in the service DB.
  process.stdout.write(`${JSON.stringify({ uid, activationToken })}\n`);
} finally {
  store.close();
}
