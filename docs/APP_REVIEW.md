# Kit do App Review (Instagram API with Instagram Login)

Referência: https://developers.facebook.com/documentation/instagram-platform/app-review

## Antes de enviar

- [ ] Verificação de Negócio **aprovada** e app conectado ao portfólio (App settings › Basic › Verification).
- [ ] App settings › Basic: ícone 1024×1024, **Privacy Policy URL** = `https://dm.adriancampana.cloud/privacidade`,
      categoria (ex.: "Business and Pages"), e-mail de contato.
- [ ] Business login settings: OAuth redirect URI = `https://dm.adriancampana.cloud/auth/instagram/callback`,
      Deauthorize callback = `https://dm.adriancampana.cloud/meta/deauthorize`,
      Data deletion request = `https://dm.adriancampana.cloud/meta/data-deletion`.
- [ ] Pelo menos **1 chamada bem-sucedida** de cada permissão nos últimos dias (conectar conta + resposta + DM de teste).
- [ ] Na VPS: `REVIEW_MODE=true` no `.env` e `docker compose up -d` (libera a conta de teste do revisor).
- [ ] Crie um usuário do painel para o revisor: `docker compose exec ig-autoreply node dist/cli/users.js create reviewer@adriancampana.cloud`
      (o comando gera a senha; cole-a no texto abaixo no lugar de `<SENHA GERADA PELO CLI>`).
- [ ] Permissões solicitadas: **somente** `instagram_business_basic`, `instagram_business_manage_comments`,
      `instagram_business_manage_messages`. Desmarque `instagram_business_content_publish`, `instagram_business_manage_insights`
      e o recurso **Human Agent** (se não for possível desmarcá-lo, explique que não é usado).

## Textos para colar (em inglês)

### App verification — instructions for reviewers

```
1. Open https://dm.adriancampana.cloud/entrar and sign in with the panel credentials below.
2. Go to "Contas" (Accounts) and click "Conectar conta do Instagram" (Connect Instagram account).
   Log in with an Instagram professional account and grant all requested permissions.
3. Go to "Automações" (Automations) › "Nova automação" (New automation). Select the account and one of its posts,
   type a keyword (e.g. "INFO"), write three public reply variations and the private message text, then save.
4. From another Instagram account, comment "INFO" on that post.
5. Within ~2 minutes the app replies publicly to the comment (instagram_business_manage_comments) and sends one
   private reply to the commenter (instagram_business_manage_messages). The result is listed under "Atividade" (Activity).

Panel credentials: reviewer@adriancampana.cloud / <SENHA GERADA PELO CLI>
The UI is in Portuguese; the screencasts include English captions.
(Note: after 5 failed sign-in attempts the panel locks sign-in for 15 minutes.)
```

### instagram_business_basic

```
Used to identify the Instagram professional account that the business owner connects (user ID, username, profile picture),
to list the account's own recent posts so the owner can choose which post an automation applies to, and to refresh the
long-lived access token. This data is shown only to the account owner inside our private panel.
```

### instagram_business_manage_comments

```
Used to receive the "comments" webhook for the owner's own posts, read new comments on posts where the owner enabled an
automation, and publish a single public reply to comments that contain the owner-defined keyword. We never comment on
third-party content, and each commenter receives at most one public reply per post.
```

### instagram_business_manage_messages

```
Used exclusively to send one Private Reply (POST /<IG_ID>/messages with recipient.comment_id) to a person who commented a
keyword on the owner's post, within the 7-day window, containing the information the commenter asked for (e.g. a link).
We do not send unsolicited messages, follow-ups or bulk messages, and the message is identified as automated.
```

## Roteiro dos vídeos (1 por permissão, ~1–2 min cada, legendas em inglês)

1. **basic**: login no painel → Contas → "Conectar conta do Instagram" → tela de permissões do Instagram → volta com
   "Conta @x conectada!" → Nova automação mostrando a grade de posts da conta.
2. **manage_comments**: criar automação com palavra-chave → em outro celular/conta, comentar a palavra → mostrar a
   resposta pública aparecendo no post → tela Atividade com a linha "Comentário" marcada como "Enviada".
3. **manage_messages**: mesmo fluxo, mostrando a DM recebida pela conta que comentou (pasta Solicitações/Principal) →
   Atividade com a linha "Direct" marcada como "Enviada".

Dica: grave a tela do computador (painel) e do celular (Instagram) lado a lado; adicione legendas curtas explicando
cada botão ("Contas = Accounts", "Automações = Automations"...).

## Depois da aprovação

- `REVIEW_MODE=false` e `docker compose up -d`.
- Invalide o usuário do revisor com `docker compose exec ig-autoreply node dist/cli/users.js reset-password reviewer@adriancampana.cloud` (e descarte a nova senha).
- Desconecte a conta de teste do revisor, se ela tiver sido conectada (em **Contas › Desconectar**; isso pausa as
  automações dela e cancela respostas pendentes).
