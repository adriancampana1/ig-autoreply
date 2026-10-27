import { html, type SafeHtml } from '../lib/html.js';

export function publicPage(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="bg-background text-foreground antialiased">
  <main class="prose-sm mx-auto max-w-2xl space-y-4 px-4 py-10 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">${body}</main>
</body>
</html>`.value;
}

export function privacyPolicy(input: { contactEmail: string; updatedAt: string }): SafeHtml {
  return html`
  <h1>Política de Privacidade</h1>
  <p><em>Atualizada em ${input.updatedAt}.</em></p>
  <p>Este sistema ("Respostas automáticas") é uma ferramenta de uso exclusivo dos titulares das contas profissionais do Instagram
    conectadas a ele. Ele responde comentários com palavras-chave definidas pelo titular e envia uma única mensagem privada a quem comentou,
    usando a API oficial da Meta (Instagram Platform).</p>
  <h2>Dados tratados</h2>
  <ul>
    <li>Da conta conectada: identificador, nome de usuário e token de acesso (armazenado criptografado).</li>
    <li>De quem comenta nos posts com automação ativa: identificador escopado do Instagram, nome de usuário, texto do comentário e o status das respostas enviadas.</li>
  </ul>
  <h2>Finalidade</h2>
  <p>Os dados são usados apenas para identificar comentários com palavras-chave, responder a eles e mostrar o histórico ao titular da conta.
    Não vendemos, compartilhamos ou usamos os dados para publicidade ou qualquer outra finalidade.</p>
  <h2>Retenção</h2>
  <p>Registros de comentários e respostas são apagados automaticamente após 90 dias; notificações técnicas recebidas da Meta, após 30 dias.
    Ao desconectar uma conta, o token de acesso é apagado imediatamente.</p>
  <h2>Exclusão de dados</h2>
  <p>O titular pode remover o app nas configurações do Instagram (Configurações › Apps e sites), o que dispara a exclusão automática dos dados
    da conta. Qualquer pessoa pode pedir a exclusão dos seus dados pelo e-mail <a href="mailto:${input.contactEmail}">${input.contactEmail}</a>.</p>

  <h1 lang="en">Privacy Policy (English)</h1>
  <p lang="en">This private tool is used only by the owners of the connected Instagram professional accounts. It replies to comments containing
    owner-defined keywords and sends one private reply to the commenter through Meta's official Instagram Platform API. We process the connected
    account's ID, username and access token (encrypted), and, for commenters on posts with an active automation, their Instagram-scoped ID,
    username, comment text and reply status. Data is used solely to provide this feature, is never sold or shared, and is deleted automatically after
    90 days (technical webhook logs after 30 days). Removing the app from Instagram triggers deletion of the account's data. Deletion requests:
    <a href="mailto:${input.contactEmail}">${input.contactEmail}</a>.</p>`;
}
