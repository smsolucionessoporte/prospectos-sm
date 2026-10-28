const cron = require('node-cron');
const { pool } = require('../db');
const { AGENTE_TELEFONO } = require('../zoomAgentes');
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
    ON CONFLICT (fecha, tipo, usuario_id) DO NOTHING RETURNING id`, [fecha, tipo, usuarioId]);
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
    const tel = AGENTE_TELEFONO[u.id];
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
    const tel = AGENTE_TELEFONO[r.responsable_id];
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

function iniciarAvisosCRM() {
  // Un solo cron por proceso. El registro crm_avisos impide duplicar envíos entre réplicas.
  cron.schedule('0 9 * * 1-5', () => enviarResumenVendedor().catch(e => console.error('[CRM] Agenda:', e)), { timezone: ZONE });
  cron.schedule('30 16 * * 1-5', () => enviarResumenSupervisor().catch(e => console.error('[CRM] Supervisión:', e)), { timezone: ZONE });
  // Dos recordatorios máximos por jornada, sujetos a verificación de Chatwoot.
  cron.schedule('0 11,15 * * 1-5', () => recordarMensajesSinResponder(new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,hour:'2-digit',hourCycle:'h23'}).format(new Date())).catch(e=>console.error('[CRM] Recordatorio mensajes:',e)), {timezone:ZONE});
  console.log(`[CRM] Cron de recordatorios configurado (${process.env.CRM_ALERTAS_WHATSAPP === 'true' ? 'envíos habilitados' : 'envíos deshabilitados'})`);
}

module.exports = { iniciarAvisosCRM, resumenParaVendedor };
