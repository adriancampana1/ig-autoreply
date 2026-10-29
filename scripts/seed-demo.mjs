// Popula um banco SEPARADO com dados fictícios para revisar o visual do painel (Task 15).
// Uso: npm run build && DATABASE_PATH=./data-demo/app.db node --env-file=.env scripts/seed-demo.mjs
import { migrate, openDatabase } from '../dist/db/database.js';
import { setMessagingDisabled, upsertConnectedAccount } from '../dist/db/repos/accounts.js';
import { createAutomation } from '../dist/db/repos/automations.js';
import { insertInteraction, refreshInteractionStatus } from '../dist/db/repos/interactions.js';
import { completeJob, enqueueJob, failJob } from '../dist/db/repos/jobs.js';
import { createTokenCipher } from '../dist/lib/crypto.js';

if (process.env.NODE_ENV === 'production' || !process.env.DATABASE_PATH?.includes('demo')) {
  console.error('Use apenas com um DATABASE_PATH de demonstração (ex.: ./data-demo/app.db), nunca em produção.');
  process.exit(1);
}

const db = openDatabase(process.env.DATABASE_PATH);
migrate(db);
const cipher = createTokenCipher(process.env.ENCRYPTION_KEY);
const now = Date.now();
const day = 86_400_000;

const loja = upsertConnectedAccount(db, { igId: '17840001', appUserId: 'demo1', username: 'loja.demo', tokenEnc: cipher.encrypt('demo'), tokenExpiresAt: now + 50 * day }, now);
const atelie = upsertConnectedAccount(db, { igId: '17840002', appUserId: 'demo2', username: 'atelie.demo', tokenEnc: cipher.encrypt('demo'), tokenExpiresAt: now + 50 * day }, now);
setMessagingDisabled(db, atelie.id, true, now);

const promo = createAutomation(db, {
  accountId: loja.id, mediaId: '17900001', mediaPermalink: 'https://www.instagram.com/',
  mediaCaption: 'Promoção de outubro! Comente EU QUERO que eu te mando o link com desconto 💜',
  keywords: ['EU QUERO', 'link'],
  publicVariations: ['Oi {usuario}, te mandei no direct! 💌', 'Prontinho {usuario}, olha o direct!', 'Enviado, {usuario}! Confere sua caixa de mensagens.'],
  dmText: 'Oi! Aqui está o link com desconto: https://exemplo.com/promo\n\n(mensagem automática)',
}, now - 3 * day);
createAutomation(db, {
  accountId: atelie.id, mediaId: '17900002', mediaCaption: 'Novo curso de bordado — comente CURSO',
  keywords: ['curso'], publicVariations: ['Te mandei, {usuario}!', 'Olha o direct, {usuario}', 'Enviado {usuario} ✨'], dmText: 'Inscrições: https://exemplo.com/curso',
}, now - day);

const samples = [
  ['ana.souza', 'Eu quero!!', 'done', 'done'],
  ['bia_m', 'EU QUERO 😍', 'done', 'failed'],
  ['carla.rp', 'eu quero também', 'pending', 'pending'],
  ['ana.souza', 'eu quero de novo', null, null],
];
samples.forEach(([user, text, pub, dm], i) => {
  const id = insertInteraction(db, {
    automationId: promo.id, commentId: `demo-${i}`, commenterIgsid: user, commenterUsername: user, commentText: text,
    matchedKeyword: 'EU QUERO', source: 'webhook', status: pub ? 'queued' : 'skipped', skipReason: pub ? undefined : 'already_replied_to_person',
  }, now - i * 600_000);
  if (!id || !pub) return;
  enqueueJob(db, { interactionId: id, accountId: loja.id, type: 'public_reply', runAt: now + 365 * day }, now);
  enqueueJob(db, { interactionId: id, accountId: loja.id, type: 'private_reply', runAt: now + 365 * day }, now);
  const [publicJob, dmJob] = db.prepare('SELECT id FROM jobs WHERE interaction_id = ? ORDER BY id').all(id);
  if (pub === 'done') completeJob(db, publicJob.id, 'demo', now);
  if (dm === 'done') completeJob(db, dmJob.id, 'demo', now);
  if (dm === 'failed') failJob(db, dmJob.id, { reason: 'messaging_disabled' }, now);
  refreshInteractionStatus(db, id);
});
console.log('Dados de demonstração criados em', process.env.DATABASE_PATH);
db.close();
