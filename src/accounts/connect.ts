import type { Config } from '../config.js';
import type { DB } from '../db/database.js';
import { upsertConnectedAccount, type Account } from '../db/repos/accounts.js';
import type { InstagramClient } from '../instagram/client.js';
import { REQUIRED_SCOPES, type InstagramOAuth } from '../instagram/oauth.js';
import type { TokenCipher } from '../lib/crypto.js';

export class ConnectError extends Error {}

export interface ConnectDeps {
  config: Config;
  db: DB;
  client: InstagramClient;
  oauth: InstagramOAuth;
  cipher: TokenCipher;
  now: () => number;
  log?: { info: (obj: object, msg: string) => void };
}

/** Conclui o Business Login: troca de tokens, checagens (allowlist, tipo, permissões) e assinatura do webhook (spec §6.5). */
export async function completeConnection(deps: ConnectDeps, code: string): Promise<Account> {
  const short = await deps.oauth.exchangeCode(code);
  if (short.permissions === undefined) {
    // A Meta nem sempre devolve `permissions` na troca do code: sem a lista, não há como conferir — segue o fluxo.
    deps.log?.info({}, 'troca do code sem "permissions": checagem de escopos pulada');
  } else {
    const granted = short.permissions;
    const missing = REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
    if (missing.length) {
      throw new ConnectError('Faltou autorizar todas as permissões. Clique em reconectar e deixe todas as opções marcadas.');
    }
  }
  const long = await deps.oauth.exchangeForLongLived(short.accessToken);
  const profile = await deps.client.getProfile(long.accessToken);

  const allowed = deps.config.REVIEW_MODE || deps.config.IG_ALLOWED_USERNAMES.includes(profile.username.toLowerCase());
  if (!allowed) throw new ConnectError(`A conta @${profile.username} não está autorizada a usar este sistema.`);
  if (profile.accountType && !['business', 'media_creator'].includes(profile.accountType.toLowerCase())) {
    throw new ConnectError('Apenas contas profissionais (Comercial ou Criador de conteúdo) podem ser conectadas.');
  }

  await deps.client.subscribeToComments(long.accessToken);
  const now = deps.now();
  return upsertConnectedAccount(
    deps.db,
    {
      igId: profile.igId,
      appUserId: profile.appUserId,
      username: profile.username,
      profilePictureUrl: profile.profilePictureUrl,
      tokenEnc: deps.cipher.encrypt(long.accessToken),
      tokenExpiresAt: now + long.expiresInSec * 1000,
    },
    now,
  );
}
