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
      (SELECT COUNT(*)::int FROM crm_tareas WHERE responsable_id=$1 AND estado='pendiente' AND vence_en < NOW()) AS vencidas,
      (SELECT COUNT(*)::int FROM crm_tareas WHERE responsable_id=$1 AND estado='pendiente'
         AND vence_en >= NOW() AND vence_en < NOW() + interval '1 day') AS proximas,
      (SELECT COUNT(*)::int FROM control_ventas cv
         LEFT JOIN prospectos p ON p.chatwoot_conversation_id=cv.chatwoot_conversation_id
         WHERE cv.derivado=TRUE AND cv.vendedor_id=$1 AND cv.fecha_primera_respuesta_vendedor IS NULL
         AND COALESCE(p.estado,'prospecto') NOT IN ('confirmado','perdido')) AS sin_primera_atencion,
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
    if (!r.vencidas && !r.proximas && !r.sin_primera_atencion && !r.por_cerrar) continue;
    const aviso = await reclamarAviso('agenda_manana', u.id);
    if (!aviso) continue;
    const mensaje = `📋 *SM Comercial — agenda del día*\n\n` +
      `👤 ${u.nombre}\n` +
      `🔴 Tareas vencidas: *${r.vencidas}*\n` +
      `📅 Próximas 24 h: *${r.proximas}*\n` +
      `💬 Sin primera atención: *${r.sin_primera_atencion}*\n` +
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

function iniciarAvisosCRM() {
  // Un solo cron por proceso. El registro crm_avisos impide duplicar envíos entre réplicas.
  cron.schedule('0 9 * * 1-5', () => enviarResumenVendedor().catch(e => console.error('[CRM] Agenda:', e)), { timezone: ZONE });
  cron.schedule('30 16 * * 1-5', () => enviarResumenSupervisor().catch(e => console.error('[CRM] Supervisión:', e)), { timezone: ZONE });
  console.log(`[CRM] Cron de recordatorios configurado (${process.env.CRM_ALERTAS_WHATSAPP === 'true' ? 'envíos habilitados' : 'envíos deshabilitados'})`);
}

module.exports = { iniciarAvisosCRM, resumenParaVendedor };
