'use strict';
// El vendedor actual se guarda en control_ventas. Los campos creado_por y
// demo_responsable representan hechos históricos y NO deben sobrescribirse
// por una reasignación desde Chatwoot.
const { AGENTE_CHATWOOT_ID } = require('../zoomAgentes');

async function sincronizarResponsableChatwoot(dbPool, conversationId, chatwootAgentId) {
  const id = Number(conversationId);
  const chatwootId = Number(chatwootAgentId);
  const usuarioId = AGENTE_CHATWOOT_ID[chatwootId];
  if (!Number.isSafeInteger(id) || id <= 0 || ![4, 11, 19].includes(chatwootId) || !usuarioId) {
    const error = new Error('Conversación o vendedor comercial inválido');
    error.status = 400;
    throw error;
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: usuarios } = await client.query(
      'SELECT nombre FROM usuarios WHERE id=$1 AND activo=TRUE', [usuarioId]);
    const nombre = usuarios[0]?.nombre;
    if (!nombre) {
      const error = new Error('Vendedor comercial inactivo o inexistente');
      error.status = 409;
      throw error;
    }
    const resultado = await client.query(`
      INSERT INTO control_ventas
        (chatwoot_conversation_id,fecha_ingreso,derivado,fecha_derivacion,vendedor_id,vendedor_nombre)
      VALUES ($1,NOW(),TRUE,NOW(),$2,$3)
      ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
        derivado=TRUE,
        fecha_derivacion=COALESCE(control_ventas.fecha_derivacion,NOW()),
        vendedor_id=EXCLUDED.vendedor_id,
        vendedor_nombre=EXCLUDED.vendedor_nombre,
        fecha_inicio_espera_vendedor=CASE
          WHEN control_ventas.fecha_primera_respuesta_vendedor IS NOT NULL
            THEN control_ventas.fecha_inicio_espera_vendedor
          WHEN control_ventas.vendedor_id IS DISTINCT FROM EXCLUDED.vendedor_id
            THEN NOW()
          ELSE control_ventas.fecha_inicio_espera_vendedor END,
        actualizado_en=NOW()
      WHERE COALESCE(control_ventas.clasificacion,'') NOT IN ('consulta_erronea','no_interesado')
      RETURNING vendedor_id, vendedor_nombre`, [id, usuarioId, nombre]);
    if (!resultado.rowCount) {
      const error = new Error('La conversación está clasificada como no comercial');
      error.status = 409;
      throw error;
    }
    // Invalidar la lectura anterior: no mostrar una alerta basada en mensajes
    // examinados bajo el responsable previo. El sync volverá a verificar Chatwoot.
    await client.query(`UPDATE crm_chatwoot_estado SET responsable_id=$2,
       ultima_revision=NOW()-interval '31 minutes'
       WHERE chatwoot_conversation_id=$1`, [id, usuarioId]);
    // Las tareas automáticas de respuesta deben seguir al responsable actual.
    await client.query(`UPDATE crm_tareas SET responsable_id=$2,actualizada_en=NOW()
       WHERE chatwoot_conversation_id=$1 AND origen='chatwoot' AND estado='pendiente'`, [id, usuarioId]);
    await client.query('COMMIT');
    return { usuario_id: usuarioId, vendedor_nombre: nombre };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { sincronizarResponsableChatwoot };
