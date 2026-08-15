// Plan 10 PR A + PR B: idempotent bootstrap registry seed + seed attestations.
//   npm run seed:bootstrap
// Gated by BOOTSTRAP_SEED=1 (CI/prod do not auto-seed unknown data).
// Seed attestations require BOOTSTRAP_SEED_PRIVATE_KEY_JWK (see .env.dev-keys).

import { pool } from '../db/client.js';
import { seedBootstrapRegistry } from '../domains/bootstrap/bootstrapSeeder.js';

const BOOTSTRAP_SEED_FLAG = 'BOOTSTRAP_SEED';

function assertSeedEnabled(): void {
  if (process.env[BOOTSTRAP_SEED_FLAG] !== '1') {
    throw new Error(
      'Refusing to seed without ' + BOOTSTRAP_SEED_FLAG + '=1. ' +
        'This prevents CI/prod from auto-seeding unknown data.',
    );
  }
}

async function main(): Promise<void> {
  const { assertDatabaseConfigured } = await import('../config.js');
  assertDatabaseConfigured();
  assertSeedEnabled();

  const result = await seedBootstrapRegistry();
  console.log(
    'bootstrap seed complete: is_bootstrap issuers=' + result.issuers +
    ', registry roots=' + result.roots +
    ', seed attestations=' + result.attestations +
    ', seed subjects=' + result.subjects,
  );
}

if (process.argv[1] && process.argv[1].endsWith('seed-bootstrap.ts')) {
  main()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
