'use strict';
// La fuente de verdad de mensajes y asignación es Chatwoot, no un campo histórico de Control de Ventas.
const axios = require('axios');
const { pool } = require('../db');
const { AGENTE_CHATWOOT_ID } = require('../zoomAgentes');
const { esContactoInterno, tieneAtributoInterno, esGrupoWhatsapp } = require('./internal-contact');

const VENTANA_DIAS = 45;
const MAX_POR_RONDA = 40;
let ejecutando = false;
let ultimoResultado = { terminado: null, procesadas: 0, errores: 0, inexistentes: 0, motivo: null };
const limpiar = v => String(v ?? '').trim();
const { sumarMinutosLaborales, evaluarConversacion, requiereAviso } = require('./actividad');

function configuracion() {
  const base = limpiar(process.env.CHATWOOT_URL).replace(/\/$/, '');
  const token = limpiar(process.env.CHATWOOT_API_TOKEN);
  const account = Number(process.env.CHATWOOT_ACCOUNT_ID || 1);
  if (!/^https?:\/\//.test(base) || !token || !Number.isSafeInteger(account)) return null;
  return { url: `${base}/api/v1/accounts/${account}`, headers: { api_access_token: token } };
}

function extraerMensajes(respuesta) {
  if (Array.isArray(respuesta)) return respuesta;
  if (Array.isArray(respuesta?.payload)) return respuesta.payload;
  if (Array.isArray(respuesta?.payload?.messages)) return respuesta.payload.messages;
  if (Array.isArray(respuesta?.messages)) return respuesta.messages;
  return [];
}

async function detalleChatwoot(cfg, id) {
  let data;
  try {
    ({ data } = await axios.get(`${cfg.url}/conversations/${id}`, { headers: cfg.headers, timeout: 12000 }));
  } catch (error) {
    // Un 404 del detalle acredita que Chatwoot ya no tiene la conversación.
    // Un 404 de /messages NO es lo mismo y no debe excluir ningún registro.
    if (error.response?.status === 404) {
      error.chatwootConversationNotFound = true;
    }
    throw error;
  }
  if (!data || Number(data.id) !== Number(id)) throw new Error('Respuesta de conversación inesperada');
  // El detalle de la conversación puede traer mensajes parciales/desactualizados.
  // Consultar SIEMPRE el endpoint de mensajes antes de decidir si hay respuesta pendiente.
  const { data: mensajesData } = await axios.get(`${cfg.url}/conversations/${id}/messages`,
    { headers: cfg.headers, timeout: 12000 });
  const mensajes = extraerMensajes(mensajesData);
  if (!mensajes.length) throw new Error('Chatwoot no devolvió mensajes actuales para verificar');
  const unicos = new Map();
  for (const mensaje of [...extraerMensajes(data.messages), ...mensajes]) {
    if (mensaje && mensaje.id != null) unicos.set(String(mensaje.id), mensaje);
  }
  return { ...data, messages: Array.from(unicos.values()) };
}

async function esConversacionExcluida(cfg, chat) {
  const meta = chat.meta || {};
  const sender = meta.sender || chat.contact || {};
  if (esGrupoWhatsapp(sender.identifier, sender.phone_number, chat.contact_inbox?.source_id, chat.source_id)) return true;
  const atributos = sender.custom_attributes || chat.contact?.custom_attributes || chat.custom_attributes;
  if (esContactoInterno(atributos)) return true;
  const id = Number(sender.id || chat.contact?.id || 0);
  if (tieneAtributoInterno(atributos) || !Number.isSafeInteger(id) || id <= 0) return false;
  const respuesta = await axios.get(`${cfg.url}/contacts/${id}`, { headers: cfg.headers, timeout: 12000 });
  const contacto = respuesta.data?.payload || respuesta.data || {};
  return esContactoInterno(contacto.custom_attributes);
}

async function excluirDeAgenda(chatId) {
  await pool.query('UPDATE crm_chatwoot_estado SET requiere_respuesta=FALSE,ultima_revision=NOW() WHERE chatwoot_conversation_id=$1', [chatId]);
  await pool.query(`UPDATE crm_tareas SET estado='completada',completada_en=NOW(),actualizada_en=NOW()
    WHERE clave_automatica=$1 AND estado='pendiente'`, [`respuesta:${chatId}`]);
}

async function registrarConversacionInexistente(chatId) {
  // Idempotente. Una eliminación real se informa una sola vez; ningún borrado de historial.
  // Primero cerrar la tarea: si la actualización falla, el siguiente ciclo
  // puede volver a probar y la conversación NO queda excluida a medias.
  await excluirDeAgenda(chatId);
  const { rows } = await pool.query(`
    INSERT INTO crm_chatwoot_inexistentes(chatwoot_conversation_id)
    VALUES($1) ON CONFLICT (chatwoot_conversation_id) DO NOTHING
    RETURNING chatwoot_conversation_id`, [chatId]);
  return rows.length > 0;
}

async function grabarRevision(row, chat) {
  const id = Number(row.chatwoot_conversation_id);
  const meta = chat.meta || {};
  const contacto = limpiar(meta.sender?.name || chat.contact?.name || chat.contact?.available_name || row.contacto || row.nombre_negocio) || `Conversación #${id}`;
  const chatwootResponsable = Number(meta.assignee?.id ?? chat.assignee_id ?? 0);
  const tieneAsignacionActual = Object.prototype.hasOwnProperty.call(meta, 'assignee') ||
    Object.prototype.hasOwnProperty.call(chat, 'assignee_id');
  // Si Chatwoot confirma que está sin agente, NO rescatar el vendedor histórico
  // de control_ventas: generaría alertas para un agente que ya no la tiene.
  const responsableId = AGENTE_CHATWOOT_ID[chatwootResponsable] ||
    (tieneAsignacionActual ? null : (Number(row.vendedor_id) || null));
  const resultado = evaluarConversacion(chat);
  if (row.respondio_cliente === true && !resultado.ultimaEntrada) {
    console.warn('[CRM] Chatwoot devolvió mensajes pero no una entrada del cliente', {
      chatwoot_conversation_id: id,
      mensajes: chat.messages?.length || 0,
      tipos: [...new Set((chat.messages || []).map(m => String(m.message_type)))].slice(0, 8),
    });
  }
  const estado = limpiar(chat.status).toLowerCase();
  // No se registran como urgentes los clientes confirmados/perdidos ni los no asignados.
  // Conservar la decisión de 'descartar hasta el próximo mensaje' al sincronizar.
  const { rows: decisiones } = await pool.query(
    'SELECT descartado_mensaje_id FROM crm_chatwoot_estado WHERE chatwoot_conversation_id=$1', [id]);
  const descartadoId = decisiones[0]?.descartado_mensaje_id;
  const necesita = requiereAviso(resultado, descartadoId) && !['confirmado', 'perdido'].includes(row.estado_prospecto) &&
    responsableId > 0 && ['open', 'pending', 'snoozed', 'resolved'].includes(estado);
  const registro = await pool.query(`
    INSERT INTO crm_chatwoot_estado
      (chatwoot_conversation_id,inbox_id,responsable_id,nombre_contacto,estado_chatwoot,
       ultima_entrada,ultima_salida_humana,ultimo_mensaje_id,requiere_respuesta,ultima_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
       inbox_id=EXCLUDED.inbox_id, responsable_id=EXCLUDED.responsable_id,
       nombre_contacto=EXCLUDED.nombre_contacto,estado_chatwoot=EXCLUDED.estado_chatwoot,
       ultima_entrada=EXCLUDED.ultima_entrada,ultima_salida_humana=EXCLUDED.ultima_salida_humana,
       ultimo_mensaje_id=EXCLUDED.ultimo_mensaje_id,
       requiere_respuesta=EXCLUDED.requiere_respuesta AND
         (crm_chatwoot_estado.descartado_mensaje_id IS DISTINCT FROM EXCLUDED.ultimo_mensaje_id),
       ultima_revision=NOW()
    RETURNING requiere_respuesta`, [id, Number(chat.inbox_id || 6), responsableId, contacto, estado,
      resultado.ultimaEntrada, resultado.ultimaSalida, resultado.ultimoMensajeId, necesita]);

  const clave = `respuesta:${id}`;
  const confirmadoPendiente = registro.rows[0]?.requiere_respuesta === true;
  if (confirmadoPendiente) {
    const vence = sumarMinutosLaborales(resultado.ultimaEntrada, 60);
    await pool.query(`
      INSERT INTO crm_tareas (prospecto_id,chatwoot_conversation_id,responsable_id,creado_por,
                             tipo,descripcion,vence_en,prioridad,origen,clave_automatica)
      VALUES($1,$2,$3,NULL,'seguimiento','Responder el último mensaje del cliente', $4,'alta','chatwoot',$5)
      ON CONFLICT (clave_automatica) WHERE clave_automatica IS NOT NULL
      DO UPDATE SET
        responsable_id=EXCLUDED.responsable_id,
        vence_en=EXCLUDED.vence_en,
        estado='pendiente', completada_en=NULL,
        actualizada_en=NOW()`, [row.prospecto_id || null, id, responsableId, vence, clave]);
  } else {
    await pool.query(`UPDATE crm_tareas SET estado='completada',completada_en=NOW(),actualizada_en=NOW()
      WHERE clave_automatica=$1 AND estado='pendiente'`, [clave]);
  }
  return confirmadoPendiente;
}

async function sincronizarCRM({ usuarioId = null, limite = MAX_POR_RONDA } = {}) {
  if (ejecutando) return { ...ultimoResultado, enProceso: true };
  const cfg = configuracion();
  if (!cfg) {
    ultimoResultado = { terminado: new Date(), procesadas: 0, errores: 0, inexistentes: 0, motivo: 'Falta configurar CHATWOOT_URL o CHATWOOT_API_TOKEN' };
    return ultimoResultado;
  }
  ejecutando = true;
  let procesadas = 0, errores = 0, inexistentes = 0;
  try {
    const params = [VENTANA_DIAS, Math.max(1, Math.min(100, Number(limite) || MAX_POR_RONDA))];
    // Incluir el responsable actual cacheado: el histórico puede estar sin actualizar
    // luego de una reasignación manual desde Chatwoot.
    const filtro = usuarioId ? ' AND (cv.vendedor_id=$3 OR s.responsable_id=$3)' : '';
    if (usuarioId) params.push(usuarioId);
    const candidatos = await pool.query(`
      SELECT cv.chatwoot_conversation_id, cv.vendedor_id, cv.respondio_cliente,
             p.id AS prospecto_id, p.contacto, p.nombre_negocio, p.estado AS estado_prospecto
      FROM control_ventas cv
      LEFT JOIN LATERAL (
        SELECT id,contacto,nombre_negocio,estado FROM prospectos p
        WHERE p.chatwoot_conversation_id=cv.chatwoot_conversation_id
           OR EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones v
                      WHERE v.chatwoot_conversation_id=cv.chatwoot_conversation_id AND v.prospecto_id=p.id)
        ORDER BY p.id DESC LIMIT 1
      ) p ON TRUE
      LEFT JOIN crm_chatwoot_estado s ON s.chatwoot_conversation_id=cv.chatwoot_conversation_id
      WHERE NOT EXISTS (
        SELECT 1 FROM crm_chatwoot_inexistentes ci
        WHERE ci.chatwoot_conversation_id=cv.chatwoot_conversation_id
      ) AND (cv.derivado=TRUE OR (cv.vendedor_id IS NOT NULL AND cv.fecha_ingreso >= NOW()-interval '14 days'))
        AND (cv.vendedor_id IS NOT NULL OR s.responsable_id IS NOT NULL)
        AND (COALESCE(cv.fecha_derivacion,cv.fecha_ingreso) >= NOW()-($1::int * interval '1 day')
             OR cv.actualizado_en >= NOW()-interval '14 days')
        AND COALESCE(p.estado,'prospecto') NOT IN ('confirmado','perdido')${filtro}
      ORDER BY s.ultima_revision ASC NULLS FIRST, cv.fecha_ingreso DESC LIMIT $2`, params);
    // Máximo dos conversaciones simultáneas. Consultar detalle, mensajes
    // y contacto en paralelo con cuatro conversaciones causó timeouts HTTP.
    for (let i = 0; i < candidatos.rows.length; i += 2) {
      await Promise.all(candidatos.rows.slice(i, i + 2).map(async row => {
        try {
          const chat = await detalleChatwoot(cfg, row.chatwoot_conversation_id);
          if (await esConversacionExcluida(cfg, chat)) {
            await excluirDeAgenda(row.chatwoot_conversation_id);
          } else {
            await grabarRevision(row, chat);
          }
          procesadas++;
        } catch (err) {
          if (err.chatwootConversationNotFound === true) {
            try {
              if (await registrarConversacionInexistente(row.chatwoot_conversation_id)) {
                console.info(`[CRM] Chat #${row.chatwoot_conversation_id} eliminado en Chatwoot: excluido de futuras sincronizaciones`);
              }
              inexistentes++;
            } catch (dbError) {
              errores++;
              console.error('[CRM] No se pudo registrar conversación eliminada', {
                chatwoot_conversation_id: row.chatwoot_conversation_id,
                error: dbError.message,
              });
            }
          } else {
            errores++;
            console.warn(`[CRM] No se pudo comprobar chat #${row.chatwoot_conversation_id}:`, err.response?.status || err.message);
          }
        }
      }));
    }
    ultimoResultado = { terminado: new Date(), procesadas, errores, inexistentes, motivo: errores ? 'Algunas conversaciones no se pudieron comprobar' : null };
  } catch (err) {
    ultimoResultado = { terminado: new Date(), procesadas, errores: errores + 1, inexistentes, motivo: err.message };
    console.error('[CRM] Error sincronizando:', err.message);
  } finally {
    ejecutando = false;
  }
  return ultimoResultado;
}

function iniciarSincronizacionCRM() {
  // Sincronización periódica, sin modificar los estados de Chatwoot ni enviar mensajes al cliente.
  setTimeout(() => sincronizarCRM().catch(e => console.error('[CRM] Sync inicial:', e)), 10000);
  const cron = require('node-cron');
  cron.schedule('*/5 * * * *', () => sincronizarCRM().catch(e => console.error('[CRM] Sync:', e)),
    { timezone: 'America/Argentina/Buenos_Aires' });
}

module.exports = { extraerMensajes, detalleChatwoot, registrarConversacionInexistente, grabarRevision, sincronizarCRM, iniciarSincronizacionCRM, configuracion, esConversacionExcluida, estadoSincronizacion: () => ({ ...ultimoResultado }) };
