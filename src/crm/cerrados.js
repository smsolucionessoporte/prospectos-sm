'use strict';
// Los prospectos cerrados conservan su historial pero no generan agenda comercial.
// Comprueba tanto el vínculo directo como los chats asociados a una misma ficha.
const aliasValido = a => { if (!/^[a-z][a-z0-9_]*$/i.test(a)) throw new Error('Alias SQL inválido'); return a; };
function tareaDeProspectoAbierto(alias='t') {
  const t=aliasValido(alias);
  return `NOT EXISTS (SELECT 1 FROM crm_chatwoot_exclusiones x
      WHERE x.chatwoot_conversation_id=${t}.chatwoot_conversation_id OR EXISTS (
        SELECT 1 FROM prospectos_chatwoot_conversaciones v
        WHERE v.prospecto_id=${t}.prospecto_id AND v.chatwoot_conversation_id=x.chatwoot_conversation_id))
    AND NOT EXISTS (SELECT 1 FROM prospectos cierre
    WHERE (cierre.estado IN ('perdido','confirmado') OR cierre.eliminado_en IS NOT NULL)
      AND (cierre.id=${t}.prospecto_id
        OR cierre.chatwoot_conversation_id=${t}.chatwoot_conversation_id
        OR EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones vinculo
                   WHERE vinculo.prospecto_id=cierre.id
                     AND vinculo.chatwoot_conversation_id=${t}.chatwoot_conversation_id)))`;
}
function chatDeProspectoAbierto(alias='s') {
  const s=aliasValido(alias);
  return `NOT EXISTS (SELECT 1 FROM crm_chatwoot_exclusiones x WHERE x.chatwoot_conversation_id=${s}.chatwoot_conversation_id)
    AND NOT EXISTS (SELECT 1 FROM prospectos cierre
    WHERE (cierre.estado IN ('perdido','confirmado') OR cierre.eliminado_en IS NOT NULL)
      AND (cierre.chatwoot_conversation_id=${s}.chatwoot_conversation_id
        OR EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones vinculo
                   WHERE vinculo.prospecto_id=cierre.id
                     AND vinculo.chatwoot_conversation_id=${s}.chatwoot_conversation_id)))`;
}
const cerrado = estado => ['perdido','confirmado'].includes(String(estado||'').toLowerCase());
module.exports={tareaDeProspectoAbierto,chatDeProspectoAbierto,cerrado};
