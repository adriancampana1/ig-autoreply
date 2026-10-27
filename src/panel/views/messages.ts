import type { Account } from '../../db/repos/accounts.js';
import type { Tone } from './components.js';

/** Textos em português simples para a usuária (sem jargão técnico). */
export const FAIL_REASON_TEXT: Record<string, string> = {
  token_invalid: 'A conta precisa ser reconectada',
  rate_limited: 'Limite do Instagram atingido; vamos tentar de novo mais tarde',
  messaging_disabled: 'A conta está com "Permitir acesso a mensagens" desativado',
  abuse_blocked: 'O Instagram pediu uma pausa: automações pausadas por 24h',
  comment_unavailable: 'Comentário apagado ou indisponível',
  window_expired: 'Passou do prazo de 7 dias ou a pessoa já recebeu a mensagem',
  permission_denied: 'O Instagram não permitiu esta ação',
  temporary_error: 'Instabilidade no Instagram: não foi possível enviar',
  unknown_error: 'Erro inesperado do Instagram',
  account_disconnected: 'A conta foi desconectada antes do envio',
};

export const SKIP_REASON_TEXT: Record<string, string> = {
  already_replied_to_person: 'Esta pessoa já recebeu resposta neste post',
};

export function accountStatus(account: Account, now: number): { label: string; tone: Tone; help?: string } {
  if (account.status === 'disconnected') return { label: 'Desconectada', tone: 'neutral' };
  if (account.status === 'reconnect_required') {
    return { label: 'Precisa reconectar', tone: 'danger', help: 'Toque em "Reconectar" e entre de novo com a conta do Instagram.' };
  }
  if (account.status === 'paused_by_safety' && account.pausedUntil && account.pausedUntil > now) {
    const until = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(account.pausedUntil);
    return {
      label: `Pausada por segurança até ${until}`,
      tone: 'warning',
      help: 'O Instagram sinalizou excesso de ações. As respostas voltam sozinhas depois da pausa.',
    };
  }
  if (account.messagingDisabled) {
    return {
      label: 'DMs bloqueadas',
      tone: 'warning',
      help: 'No app do Instagram: Configurações › Mensagens e respostas a stories › Ferramentas conectadas › ative "Permitir acesso a mensagens".',
    };
  }
  return { label: 'Funcionando', tone: 'success' };
}

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  done: { label: 'Enviada', tone: 'success' },
  pending: { label: 'Na fila', tone: 'info' },
  running: { label: 'Enviando', tone: 'info' },
  failed: { label: 'Falhou', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};
