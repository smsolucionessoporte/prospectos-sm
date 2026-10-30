'use strict';

function linkChatwoot(conversationId, inboxId = 6) {
  const base = String(process.env.CHATWOOT_URL || '').replace(/\/+$/, '');
  const accountId = Number(process.env.CHATWOOT_ACCOUNT_ID);
  const id = Number(conversationId);
  const inbox = Number(inboxId);
  if (!/^https?:\/\/[^/]+/i.test(base) || !Number.isSafeInteger(accountId) || accountId < 1 ||
      !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(inbox) || inbox < 1) {
    throw new Error('CHATWOOT_URL, CHATWOOT_ACCOUNT_ID o identificadores inválidos');
  }
  return `${base}/app/accounts/${accountId}/inbox/${inbox}/conversations/${id}`;
}

function completarEnlaceConversacion(mensaje, enlace) {
  return mensaje.includes(enlace) ? mensaje : `${mensaje.trimEnd()}\n\n🔗 Abrir conversación en Chatwoot:\n${enlace}`;
}

module.exports = { linkChatwoot, completarEnlaceConversacion };
