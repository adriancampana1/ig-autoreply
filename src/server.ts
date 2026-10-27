import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db/database.js';
import { resetRunningJobs } from './db/repos/jobs.js';
import { refreshExpiringTokens, runHousekeeping } from './engine/maintenance.js';
import { reconcileOnce } from './engine/reconciler.js';
import { startScheduler, type Health } from './engine/scheduler.js';
import { runWorkerTick } from './engine/worker.js';
import { createInstagramClient } from './instagram/client.js';
import { createInstagramOAuth } from './instagram/oauth.js';
import { serializeRequest } from './http/logSerializers.js';
import { createTokenCipher } from './lib/crypto.js';
import { OAUTH_CALLBACK_PATH } from './panel/routes/accounts.js';

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
migrate(db);

const now = () => Date.now();
const random = () => Math.random();
const health: Health = { lastWorkerTickAt: null };
const cipher = createTokenCipher(config.ENCRYPTION_KEY);
const client = createInstagramClient({ version: config.GRAPH_API_VERSION });
const oauth = createInstagramOAuth({
  appId: config.IG_APP_ID,
  appSecret: config.IG_APP_SECRET,
  redirectUri: `${config.APP_BASE_URL}${OAUTH_CALLBACK_PATH}`,
});

const app = await buildApp({
  config,
  db,
  client,
  oauth,
  cipher,
  health,
  now,
  random,
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    // A query string (OAuth code/state, hub.verify_token) e os cabeçalhos nunca entram no log: ver serializeRequest.
    serializers: { req: serializeRequest },
    redact: ['req.headers.cookie', 'req.headers["x-hub-signature-256"]', 'req.query.code', '*.access_token', '*.token', '*.client_secret', '*.code'],
  },
});
const log = app.log;

resetRunningJobs(db, now());
const decryptToken = (encoded: string) => cipher.decrypt(encoded);
const scheduler = startScheduler(
  [
    {
      name: 'worker',
      intervalMs: 1_000,
      run: async () => {
        await runWorkerTick({ db, client, decryptToken, now, random, maxActionsPerHour: config.MAX_ACTIONS_PER_HOUR, log });
        health.lastWorkerTickAt = now();
      },
      runOnStart: true,
    },
    {
      name: 'reconciler',
      intervalMs: 10 * 60_000,
      // Roda também ao subir: cobre lacunas de webhook durante a indisponibilidade sem esperar 10 min.
      runOnStart: true,
      run: () => reconcileOnce({ db, client, decryptToken, now, random, log }),
    },
    {
      name: 'maintenance',
      intervalMs: 6 * 60 * 60_000,
      runOnStart: true,
      run: async () => {
        const tokens = await refreshExpiringTokens({ db, refresh: oauth.refresh, encrypt: cipher.encrypt, decrypt: decryptToken, now, log });
        const housekeeping = runHousekeeping(db, now());
        log.info({ tokens, housekeeping }, 'manutenção concluída');
      },
    },
  ],
  log,
);

await app.listen({ host: '0.0.0.0', port: config.PORT });

const FORCED_EXIT_MS = 8_000;
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'encerrando');
    // Se scheduler.stop()/app.close() travarem, sai à força para o orquestrador não esperar o SIGKILL.
    setTimeout(() => {
      log.error({ signal }, 'encerramento excedeu o prazo; saindo à força');
      process.exit(1);
    }, FORCED_EXIT_MS).unref();
    let exitCode = 0;
    try {
      await scheduler.stop();
      await app.close();
    } catch (error) {
      exitCode = 1;
      log.error({ err: error }, 'falha ao encerrar');
    } finally {
      try {
        db.close();
      } catch (error) {
        exitCode = 1;
        log.error({ err: error }, 'falha ao fechar o banco');
      }
    }
    process.exit(exitCode);
  });
}
