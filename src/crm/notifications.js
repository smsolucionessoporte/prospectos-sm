const cron = require('node-cron');
const { pool } = require('../db');
const { AGENTE_TELEFONO, telefonoVendedor } = require('../zoomAgentes');
const { enviarPorChatwoot } = require('../zoomChatwoot');

const ZONE = 'America/Argentina/Buenos_Aires';
const appUrl = () => String(process.env.APP_URL || '').replace(/\/$/, '');
const fechaArgentina = () => {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const v = tipo => partes.find(p => p.type === tipo)?.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
};

async function reclamarAviso(tipo, usuarioId) {
  const fecha = fechaArgentina();
  const result = await pool.query(`
    INSERT INTO crm_avisos (fecha, tipo, usuario_id)
    VALUES ($1::date, $2, $3)
    ON CONFLICT (fecha, tipo, usuario_id) DO UPDATE SET
      estado='procesando', creado_en=NOW(), enviado_en=NULL, error=NULL
    WHERE crm_avisos.estado='error'
      AND crm_avisos.creado_en <= NOW()-interval '15 minutes'
    RETURNING id`, [fecha, tipo, usuarioId]);
  return result.rows[0]?.id || null;
}

async function terminarAviso(id, enviado, error) {
  await pool.query(`UPDATE crm_avisos SET estado=$2, enviado_en=CASE WHEN $2='enviado' THEN NOW() ELSE NULL END, error=$3 WHERE id=$1`,
    [id, enviado ? 'enviado' : 'error', error || null]);
}

async function resumenParaVendedor(usuarioId) {
  const { rows: [r] } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM crm_tareas WHERE responsable_id=$1 AND estado='pendiente' AND origen <> 'chatwoot' AND vence_en < NOW()) AS vencidas,
      (SELECT COUNT(*)::int FROM crm_tareas WHERE responsable_id=$1 AND estado='pendiente' AND origen <> 'chatwoot'
         AND vence_en >= NOW() AND vence_en < NOW() + interval '1 day') AS proximas,
      (SELECT COUNT(*)::int FROM crm_chatwoot_estado s
         WHERE s.responsable_id=$1 AND s.requiere_respuesta=TRUE
         AND s.ultima_revision >= NOW()-interval '30 minutes'
         AND s.ultima_entrada >= NOW()-interval '14 days') AS mensajes_por_responder,
      (SELECT COUNT(*)::int FROM prospectos p LEFT JOIN control_ventas cv
         ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
         WHERE p.estado='demo_realizada' AND COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)=$1) AS por_cerrar`, [usuarioId]);
  return r;
}

async function enviarResumenVendedor() {
  if (process.env.CRM_ALERTAS_WHATSAPP !== 'true') return;
  const { rows: usuarios } = await pool.query("SELECT id, nombre FROM usuarios WHERE activo=TRUE AND rol='vendedor' ORDER BY id");
  for (const u of usuarios) {
    const tel = telefonoVendedor(u.id);
    if (!tel) { console.warn(`[CRM] Resumen omitido para usuario ${u.id}: falta teléfono de contacto`); continue; }
    const r = await resumenParaVendedor(u.id);
    if (!r.vencidas && !r.proximas && !r.mensajes_por_responder && !r.por_cerrar) continue;
    const aviso = await reclamarAviso('agenda_manana', u.id);
    if (!aviso) continue;
    const mensaje = `📋 *SM Comercial — agenda del día*\n\n` +
      `👤 ${u.nombre}\n` +
      `🔴 Tareas vencidas: *${r.vencidas}*\n` +
      `📅 Próximas 24 h: *${r.proximas}*\n` +
      `💬 Mensajes sin responder (verificados): *${r.mensajes_por_responder}*\n` +
      `🤝 Oportunidades por cerrar: *${r.por_cerrar}*\n\n` +
      `Ingresá y gestioná los casos:\n${appUrl()}/crm`;
    try {
      const ok = await enviarPorChatwoot(tel, mensaje, u.id);
      await terminarAviso(aviso, Boolean(ok), ok ? null : 'El canal Chatwoot no confirmó el envío');
    } catch (error) {
      console.error(`[CRM] Error de aviso a ${u.id}:`, error.message);
      await terminarAviso(aviso, false, error.message.slice(0, 250));
    }
  }
}

async function enviarResumenSupervisor() {
  if (process.env.CRM_ALERTAS_WHATSAPP !== 'true') return;
  const id = Number(process.env.CRM_SUPERVISOR_USUARIO_ID);
  if (!Number.isInteger(id) || !AGENTE_TELEFONO[id]) {
    console.warn('[CRM] Resumen supervisor omitido: configurar CRM_SUPERVISOR_USUARIO_ID con un contacto válido');
    return;
  }
  const { rows: casos } = await pool.query(`
    SELECT u.nombre, COUNT(t.id)::int AS vencidas
    FROM usuarios u LEFT JOIN crm_tareas t ON t.responsable_id=u.id
       AND t.estado='pendiente' AND t.vence_en < NOW()
    WHERE u.activo=TRUE AND u.rol='vendedor'
    GROUP BY u.id,u.nombre HAVING COUNT(t.id) > 0 ORDER BY vencidas DESC`);
  if (!casos.length) return;
  const aviso = await reclamarAviso('supervisor_tarde', id);
  if (!aviso) return;
  const mensaje = '📊 *SM Comercial — pendientes vencidos del equipo*\n\n' +
    casos.map(u => `• ${u.nombre}: ${u.vencidas} vencidos`).join('\n') +
    `\n\nRevisá las excepciones:\n${appUrl()}/crm`;
  try {
    const ok = await enviarPorChatwoot(AGENTE_TELEFONO[id], mensaje, id);
    await terminarAviso(aviso, Boolean(ok), ok ? null : 'El canal no confirmó el envío');
  } catch (error) {
    console.error('[CRM] Error aviso supervisor:', error.message);
    await terminarAviso(aviso, false, error.message.slice(0, 250));
  }
}

async function recordarMensajesSinResponder(hora) {
  if (process.env.CRM_ALERTAS_WHATSAPP !== 'true') return;
  const { businessMinutesBetween } = require('../salesBusinessTime');
  const { rows } = await pool.query(`
    SELECT s.responsable_id, u.nombre, COUNT(*)::int AS cantidad,
           MIN(s.ultima_entrada) AS mas_antiguo
    FROM crm_chatwoot_estado s
    JOIN usuarios u ON u.id=s.responsable_id
    WHERE u.activo=TRUE AND u.rol='vendedor'
      AND s.requiere_respuesta=TRUE
      AND s.ultima_revision >= NOW()-interval '30 minutes'
      AND s.ultima_entrada >= NOW()-interval '14 days'
    GROUP BY s.responsable_id,u.nombre`);
  for (const r of rows) {
    // Al menos una hora de trabajo real; nunca alertar por un chat viejo no verificado.
    if (businessMinutesBetween(r.mas_antiguo) < 60) continue;
    const tel = telefonoVendedor(r.responsable_id);
    if (!tel) continue;
    const aviso = await reclamarAviso(`respuesta_${hora}`,r.responsable_id);
    if (!aviso) continue;
    try {
      const ok = await enviarPorChatwoot(tel,
        `🔔 *SM Comercial — mensajes por responder*\n\n${r.nombre}, tenés *${r.cantidad}* conversación(es) con mensaje del cliente pendiente de respuesta.\n\nRevisalas acá: ${appUrl()}/crm`,
        r.responsable_id);
      await terminarAviso(aviso,Boolean(ok),ok?null:'No se confirmó el envío');
    } catch(e) {
      await terminarAviso(aviso,false,String(e.message).slice(0,250));
      console.warn('[CRM] Recordatorio de mensajes:',e.message);
    }
  }
}

async function recordarSeguimientosProgramados() {
  if (process.env.CRM_ALERTAS_WHATSAPP !== 'true') return;
  const {rows: tareas} = await pool.query(`
    SELECT t.id,t.vence_en,t.descripcion,t.responsable_id,p.nombre_negocio,p.contacto
    FROM crm_tareas t LEFT JOIN prospectos p ON p.id=t.prospecto_id
    JOIN usuarios u ON u.id=t.responsable_id
    WHERE t.estado='pendiente' AND t.origen <> 'chatwoot'
      AND t.recordatorio=TRUE AND t.vence_en <= NOW()
      AND NOT EXISTS (SELECT 1 FROM crm_recordatorios_tareas r
        WHERE r.tarea_id=t.id AND r.vence_en=t.vence_en
          AND (r.estado='enviado' OR r.creado_en > NOW()-interval '15 minutes'))
      AND u.activo=TRUE ORDER BY t.vence_en ASC LIMIT 100`);
  for (const t of tareas) {
    const tel = telefonoVendedor(t.responsable_id);
    if (!tel) continue;
    const registrado = await pool.query(`
      INSERT INTO crm_recordatorios_tareas (tarea_id,vence_en) VALUES($1,$2)
      ON CONFLICT (tarea_id,vence_en) DO UPDATE SET
        estado='procesando', creado_en=NOW(), enviado_en=NULL, error=NULL
      WHERE crm_recordatorios_tareas.estado IN ('error','procesando')
        AND crm_recordatorios_tareas.creado_en <= NOW()-interval '15 minutes'
      RETURNING id`,[t.id,t.vence_en]);
    const avisoId = registrado.rows[0]?.id;
    if (!avisoId) continue;
    const contacto = t.nombre_negocio || t.contacto || 'Prospecto comercial';
    try {
      const ok = await enviarPorChatwoot(tel,
        `⏰ *SM Comercial — recordatorio de seguimiento*\n\n*${contacto}*\n${t.descripcion}\n\nEl seguimiento ya alcanzó su vencimiento.\n${appUrl()}/crm#agenda-seguimientos`,
        t.responsable_id);
      await pool.query(`UPDATE crm_recordatorios_tareas SET estado=$2,enviado_en=CASE WHEN $2='enviado' THEN NOW() ELSE NULL END,error=$3 WHERE id=$1`,
        [avisoId,ok?'enviado':'error',ok?null:'No se confirmó el envío']);
    } catch(error) {
      console.warn(`[CRM] No se pudo recordar tarea ${t.id}:`,error.message);
      await pool.query(`UPDATE crm_recordatorios_tareas SET estado='error',error=$2 WHERE id=$1`,[avisoId,String(error.message).slice(0,250)]);
    }
  }
}

function iniciarAvisosCRM() {
  // Un solo cron por proceso. La restricción UNIQUE y el reclamo condicional bloquean duplicados entre réplicas.
  cron.schedule('*/15 9-16 * * 1-5', () => recordarSeguimientosProgramados().catch(e => console.error('[CRM] Recordatorio seguimiento:',e)), {timezone:ZONE});
  cron.schedule('0,15 9 * * 1-5', () => enviarResumenVendedor().catch(e => console.error('[CRM] Agenda:', e)), { timezone: ZONE });
  cron.schedule('30,45 16 * * 1-5', () => enviarResumenSupervisor().catch(e => console.error('[CRM] Supervisión:', e)), { timezone: ZONE });
  // Dos franjas diarias como máximo; la segunda ejecución por franja solo reintenta avisos fallidos.
  cron.schedule('0,15 11,15 * * 1-5', () => recordarMensajesSinResponder(new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,hour:'2-digit',hourCycle:'h23'}).format(new Date())).catch(e=>console.error('[CRM] Recordatorio mensajes:',e)), {timezone:ZONE});
  console.log(`[CRM] Cron de recordatorios configurado (${process.env.CRM_ALERTAS_WHATSAPP === 'true' ? 'envíos habilitados' : 'envíos deshabilitados'})`);
}

module.exports = { iniciarAvisosCRM, resumenParaVendedor, reclamarAviso, recordarSeguimientosProgramados };
