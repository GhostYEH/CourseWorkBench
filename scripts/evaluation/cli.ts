import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  freezeEvaluation,
  verifyFrozenEvaluation,
} from '../../packages/study-domain/src/evaluation';
import { runSyntheticEvaluation } from './synthetic';

const read = (path: string): unknown => JSON.parse(readFileSync(resolve(path), 'utf8'));
const write = (path: string, value: unknown): void =>
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'freeze' && args.length === 5) {
    write(
      args[4]!,
      freezeEvaluation(read(args[0]!), read(args[1]!), read(args[2]!), read(args[3]!)),
    );
  } else if (command === 'recompute' && args.length === 2) {
    write(args[1]!, verifyFrozenEvaluation(read(args[0]!)).report);
  } else if (command === 'synthetic' && args.length === 2) {
    write(args[0]!, runSyntheticEvaluation(args[1]!));
  } else
    throw new Error(
      'Usage: pnpm exec tsx scripts/evaluation/cli.ts freeze DATASET CONFIG GOLD PREDICTIONS OUTPUT | recompute FROZEN OUTPUT | synthetic OUTPUT BUILD_ID',
    );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
