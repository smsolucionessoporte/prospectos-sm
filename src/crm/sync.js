'use strict';
// La fuente de verdad de mensajes y asignación es Chatwoot, no un campo histórico de Control de Ventas.
const axios = require('axios');
const { pool } = require('../db');
const { AGENTE_CHATWOOT_ID } = require('../zoomAgentes');

const VENTANA_DIAS = 45;
const MAX_POR_RONDA = 40;
let ejecutando = false;
let ultimoResultado = { terminado: null, procesadas: 0, errores: 0, motivo: null };
const limpiar = v => String(v ?? '').trim();
const { sumarMinutosLaborales, evaluarConversacion } = require('./actividad');

function configuracion() {
  const base = limpiar(process.env.CHATWOOT_URL).replace(/\/$/, '');
  const token = limpiar(process.env.CHATWOOT_API_TOKEN);
  const account = Number(process.env.CHATWOOT_ACCOUNT_ID || 1);
  if (!/^https?:\/\//.test(base) || !token || !Number.isSafeInteger(account)) return null;
  return { url: `${base}/api/v1/accounts/${account}`, headers: { api_access_token: token } };
}

async function detalleChatwoot(cfg, id) {
  const { data } = await axios.get(`${cfg.url}/conversations/${id}`, { headers: cfg.headers, timeout: 8000 });
  if (!data || Number(data.id) !== Number(id)) throw new Error('Respuesta de conversación inesperada');
  let messages = Array.isArray(data.messages) ? data.messages : [];
  if (!messages.length) {
    const r = await axios.get(`${cfg.url}/conversations/${id}/messages`, { headers: cfg.headers, timeout: 8000 });
    messages = Array.isArray(r.data?.payload) ? r.data.payload : Array.isArray(r.data) ? r.data : [];
  }
  if (!messages.length) throw new Error('Chatwoot no devolvió mensajes para verificar');
  return { ...data, messages };
}

async function grabarRevision(row, chat) {
  const id = Number(row.chatwoot_conversation_id);
  const meta = chat.meta || {};
  const contacto = limpiar(meta.sender?.name || chat.contact?.name || chat.contact?.available_name || row.contacto || row.nombre_negocio) || `Conversación #${id}`;
  const chatwootResponsable = Number(meta.assignee?.id || chat.assignee_id || 0);
  const responsableId = AGENTE_CHATWOOT_ID[chatwootResponsable] || Number(row.vendedor_id);
  const resultado = evaluarConversacion(chat);
  const estado = limpiar(chat.status).toLowerCase();
  // No se registran como urgentes los clientes confirmados/perdidos ni los no asignados.
  const necesita = resultado.requiereRespuesta && !['confirmado', 'perdido'].includes(row.estado_prospecto) &&
    responsableId > 0 && ['open', 'pending', 'snoozed', 'resolved'].includes(estado);
  await pool.query(`
    INSERT INTO crm_chatwoot_estado
      (chatwoot_conversation_id,inbox_id,responsable_id,nombre_contacto,estado_chatwoot,
       ultima_entrada,ultima_salida_humana,ultimo_mensaje_id,requiere_respuesta,ultima_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (chatwoot_conversation_id) DO UPDATE SET
       inbox_id=EXCLUDED.inbox_id, responsable_id=EXCLUDED.responsable_id,
       nombre_contacto=EXCLUDED.nombre_contacto,estado_chatwoot=EXCLUDED.estado_chatwoot,
       ultima_entrada=EXCLUDED.ultima_entrada,ultima_salida_humana=EXCLUDED.ultima_salida_humana,
       ultimo_mensaje_id=EXCLUDED.ultimo_mensaje_id,requiere_respuesta=EXCLUDED.requiere_respuesta,
       ultima_revision=NOW()`, [id, Number(chat.inbox_id || 6), responsableId, contacto, estado,
      resultado.ultimaEntrada, resultado.ultimaSalida, resultado.ultimoMensajeId, necesita]);

  const clave = `respuesta:${id}`;
  if (necesita) {
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
  return necesita;
}

async function sincronizarCRM({ usuarioId = null, limite = MAX_POR_RONDA } = {}) {
  if (ejecutando) return { ...ultimoResultado, enProceso: true };
  const cfg = configuracion();
  if (!cfg) {
    ultimoResultado = { terminado: new Date(), procesadas: 0, errores: 0, motivo: 'Falta configurar CHATWOOT_URL o CHATWOOT_API_TOKEN' };
    return ultimoResultado;
  }
  ejecutando = true;
  let procesadas = 0, errores = 0;
  try {
    const params = [VENTANA_DIAS, Math.max(1, Math.min(100, Number(limite) || MAX_POR_RONDA))];
    const filtro = usuarioId ? ' AND cv.vendedor_id=$3' : '';
    if (usuarioId) params.push(usuarioId);
    const candidatos = await pool.query(`
      SELECT cv.chatwoot_conversation_id, cv.vendedor_id,
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
      WHERE cv.derivado=TRUE AND cv.vendedor_id IS NOT NULL
        AND (COALESCE(cv.fecha_derivacion,cv.fecha_ingreso) >= NOW()-($1::int * interval '1 day')
             OR cv.actualizado_en >= NOW()-interval '14 days')
        AND COALESCE(p.estado,'prospecto') NOT IN ('confirmado','perdido')${filtro}
      ORDER BY s.ultima_revision ASC NULLS FIRST, cv.fecha_ingreso DESC LIMIT $2`, params);
    // Concurrencia limitada para no saturar la API de Chatwoot.
    for (let i = 0; i < candidatos.rows.length; i += 4) {
      await Promise.all(candidatos.rows.slice(i, i + 4).map(async row => {
        try {
          const chat = await detalleChatwoot(cfg, row.chatwoot_conversation_id);
          await grabarRevision(row, chat);
          procesadas++;
        } catch (err) {
          errores++;
          console.warn(`[CRM] No se pudo comprobar chat #${row.chatwoot_conversation_id}:`, err.response?.status || err.message);
        }
      }));
    }
    ultimoResultado = { terminado: new Date(), procesadas, errores, motivo: errores ? 'Algunas conversaciones no se pudieron comprobar' : null };
  } catch (err) {
    ultimoResultado = { terminado: new Date(), procesadas, errores: errores + 1, motivo: err.message };
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

module.exports = { sincronizarCRM, iniciarSincronizacionCRM, configuracion, estadoSincronizacion: () => ({ ...ultimoResultado }) };
