import { runMigrations } from '../src/migrate.ts';
import { main } from '../src/server.ts';

const result = await runMigrations();
console.log(`Startup migrations complete: applied=${result.applied} skipped=${result.skipped}`);
await main();
