'use strict';
const chatIdValido = id => Number.isSafeInteger(Number(id)) && Number(id) > 0;
function tieneEtiquetaClienteActivo(chat) {
  const etiquetas = [chat?.labels, chat?.meta?.labels, chat?.conversation?.labels];
  return etiquetas.some(lista => Array.isArray(lista) && lista.some(e =>
    String(typeof e === 'string' ? e : e?.title || e?.name || '').trim().toLowerCase() === 'cliente-activo'));
}
async function excluirConversacion(id, motivo='cliente_activo', db=null) {
  if (!db) db = require('../db').pool;
  if (!chatIdValido(id)) throw new Error('ID de conversación inválido');
  const numero = Number(id);
  await db.query(`INSERT INTO crm_chatwoot_exclusiones(chatwoot_conversation_id,motivo)
    VALUES($1,$2) ON CONFLICT(chatwoot_conversation_id) DO UPDATE SET
      motivo=EXCLUDED.motivo`, [numero,motivo]);
  if (motivo === 'cliente_activo') {
    // Baja lógica de la ficha vinculada; conservar todo el historial para auditoría.
    await db.query(`UPDATE prospectos SET eliminado_en=COALESCE(eliminado_en,NOW()),actualizado_en=NOW()
      WHERE chatwoot_conversation_id=$1 OR id IN
        (SELECT prospecto_id FROM prospectos_chatwoot_conversaciones
         WHERE chatwoot_conversation_id=$1)`,[numero]);
  }
  await db.query(`UPDATE campania_destinatarios SET estado='omitido',detalle='Cliente activo / excluido del circuito comercial'
    WHERE chatwoot_conversation_id=$1 AND estado IN ('pendiente','error')`,[numero]);
  // Limpiar el pendiente de Control de Ventas aunque se haya caído el bot.
  await db.query(`UPDATE control_ventas SET fecha_inicio_espera_vendedor=NULL,
    actualizado_en=NOW() WHERE chatwoot_conversation_id=$1`,[numero]);
  await db.query(`UPDATE crm_chatwoot_estado SET requiere_respuesta=FALSE
    WHERE chatwoot_conversation_id=$1`,[numero]);
  await db.query(`UPDATE crm_tareas SET estado='cancelada',actualizada_en=NOW()
    WHERE estado='pendiente' AND (chatwoot_conversation_id=$1 OR prospecto_id IN (
      SELECT id FROM prospectos WHERE chatwoot_conversation_id=$1 UNION
      SELECT prospecto_id FROM prospectos_chatwoot_conversaciones WHERE chatwoot_conversation_id=$1)
      OR chatwoot_conversation_id IN (SELECT v.chatwoot_conversation_id FROM prospectos_chatwoot_conversaciones v
        WHERE v.prospecto_id IN (SELECT prospecto_id FROM prospectos_chatwoot_conversaciones WHERE chatwoot_conversation_id=$1)))`,[numero]);
}
module.exports = { chatIdValido, tieneEtiquetaClienteActivo, excluirConversacion };
