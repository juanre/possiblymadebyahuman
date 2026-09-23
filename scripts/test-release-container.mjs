// Disposable release-image gate; pgdbm's pytest fixture owns its database.
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const network = `pmbah-gate-${suffix}`;
const application = `${network}-app`;
const image = process.env.PMBAH_TEST_IMAGE ?? `pmbah-release-check:${suffix}`;
const revision = process.env.BUILD_REVISION ?? (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
if (!process.env.PMBAH_TEST_DATABASE_URL) throw new Error('PMBAH_TEST_DATABASE_URL is required; run npm run test:release-container to use pgdbm fixtures');
const databaseUrl = new URL(process.env.PMBAH_TEST_DATABASE_URL);
const hostNetworking = process.platform === 'linux';
// The host-side pgdbm fixture keeps ownership of this exact database. Only
// its network address changes when PostgreSQL is accessed from the app image.
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname);
if (process.env.PMBAH_TEST_CONTAINER_DB_HOST) databaseUrl.hostname = process.env.PMBAH_TEST_CONTAINER_DB_HOST;
else if (loopback && !hostNetworking) databaseUrl.hostname = 'host.docker.internal';
if (process.env.PMBAH_TEST_CONTAINER_DB_PORT) databaseUrl.port = process.env.PMBAH_TEST_CONTAINER_DB_PORT;
const hostAccess = databaseUrl.hostname === 'host.docker.internal' ? ['--add-host', 'host.docker.internal:host-gateway'] : [];
const interrupted = new AbortController();
// pytest terminates this child before releasing its database fixture. Exit
// through finally so the app container cannot outlive the database it uses.
process.once('SIGTERM', () => interrupted.abort(new Error('Release image test interrupted')));
process.once('SIGINT', () => interrupted.abort(new Error('Release image test interrupted')));
const run = (command, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env }, signal: interrupted.signal });
  let failure;
  child.on('error', (error) => { failure = error; });
  child.on('close', (code) => failure ? reject(failure) : code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
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
  interrupted.signal.throwIfAborted();
  if (!hostNetworking) await exec('docker', ['network', 'create', network]);
  interrupted.signal.throwIfAborted();
  // Native Linux uses the host network to reach a localhost-only PostgreSQL
  // service; Docker Desktop instead forwards through host.docker.internal.
  const networkArgs = hostNetworking ? ['--network', 'host', '-e', `PORT=${port}`]
    : ['--network', network, '-p', `127.0.0.1:${port}:8000`];
  await exec('docker', ['run', '-d', '--name', application, ...networkArgs,
    ...hostAccess, '-e', 'DATABASE_URL',
    '-e', `PUBLIC_BASE_URL=${baseUrl}`, image], { env: { ...process.env, DATABASE_URL: databaseUrl.href } });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    interrupted.signal.throwIfAborted();
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
  await exec('docker', ['rm', '-f', application]).catch(() => undefined);
  if (!hostNetworking) await exec('docker', ['network', 'rm', network]).catch(() => undefined);
  if (!process.env.PMBAH_TEST_IMAGE) await exec('docker', ['image', 'rm', image]).catch(() => undefined);
}
