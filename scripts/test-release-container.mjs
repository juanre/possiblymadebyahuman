// Disposable release-image gate. Never reuses the developer's local stack.
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const network = `pmbah-gate-${suffix}`;
const database = `${network}-db`;
const application = `${network}-app`;
const image = process.env.PMBAH_TEST_IMAGE ?? `pmbah-release-check:${suffix}`;
const revision = process.env.BUILD_REVISION ?? (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
const password = randomUUID();
const run = (command, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const port = await new Promise((resolve, reject) => {
  const socket = createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const value = socket.address().port;
    socket.close(() => resolve(value));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;
try {
  if (!process.env.PMBAH_TEST_IMAGE) {
    await run('docker', ['build', '--build-arg', `BUILD_REVISION=${revision}`, '-t', image, '.']);
  }
  await exec('docker', ['network', 'create', network]);
  await exec('docker', ['run', '--rm', '-d', '--name', database, '--network', network,
    '-e', 'POSTGRES_USER=pmbah', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=pmbah', 'postgres:16-alpine']);
  let databaseReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await exec('docker', ['exec', database, 'pg_isready', '-U', 'pmbah']); databaseReady = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  if (!databaseReady) throw new Error('test database did not become ready');
  await exec('docker', ['run', '--rm', '-d', '--name', application, '--network', network,
    '-p', `127.0.0.1:${port}:8000`, '-e', `DATABASE_URL=postgresql://pmbah:${password}@${database}:5432/pmbah`,
    '-e', `PUBLIC_BASE_URL=${baseUrl}`, image]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const result = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(2000) }); if (result.ok) { ready = true; break; } }
    catch { /* wait for the container's startup migrations */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('release image did not become ready');
  const health = await (await fetch(`${baseUrl}/health`)).json();
  if (health.revision !== revision) throw new Error(`tested revision ${health.revision} differs from expected ${revision}`);
  console.log(`Testing release image at ${baseUrl}, revision ${health.revision}`);
  await run(process.execPath, ['scripts/smoke-local-container.mjs'], { SMOKE_BASE_URL: baseUrl });
  await run('npm', ['run', 'test:web-browser'], { PMBAH_LOCAL_BASE_URL: baseUrl });
} catch (error) {
  const logs = await exec('docker', ['logs', application]).catch(() => null);
  if (logs) process.stderr.write(logs.stdout + logs.stderr);
  throw error;
} finally {
  for (const name of [application, database]) await exec('docker', ['rm', '-f', name]).catch(() => undefined);
  await exec('docker', ['network', 'rm', network]).catch(() => undefined);
  if (!process.env.PMBAH_TEST_IMAGE) await exec('docker', ['image', 'rm', image]).catch(() => undefined);
}
