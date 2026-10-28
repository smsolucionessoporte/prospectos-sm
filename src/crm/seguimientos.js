'use strict';
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRol } = require('../middleware/auth');
const router = express.Router();
const ZONA = 'America/Argentina/Buenos_Aires';
const esc = x => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function fechaAR(d) {
  return d ? new Intl.DateTimeFormat('es-AR', { timeZone: ZONA, day: '2-digit', month: '2-digit',year: 'numeric',hour: '2-digit',minute: '2-digit' }).format(new Date(d)) : 'Sin fecha';
}
function fechaParaInput(d) {
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA,year: 'numeric',month: '2-digit',day: '2-digit',hour: '2-digit',minute: '2-digit',hourCycle: 'h23' }).formatToParts(new Date(d));
  const part = k => parts.find(x => x.type === k)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
function fechaRecibida(x) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(x ?? ''))) return null;
  const d = new Date(`${x}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
async function vendedorAsignado(p) {
  const r = await pool.query(`
    SELECT cv.vendedor_id FROM control_ventas cv
    WHERE cv.chatwoot_conversation_id = $1
       OR cv.chatwoot_conversation_id IN
          (SELECT v.chatwoot_conversation_id FROM prospectos_chatwoot_conversaciones v WHERE v.prospecto_id=$2)
    ORDER BY cv.actualizado_en DESC NULLS LAST LIMIT 1`, [p.chatwoot_conversation_id, p.id]);
  return Number(r.rows[0]?.vendedor_id || p.demo_responsable || p.creado_por || 0);
}
async function puedeGestionar(p, u) {
  if (u.rol === 'admin') return true;
  return (u.rol === 'vendedor' || u.rol === 'soporte') && (await vendedorAsignado(p)) === Number(u.id);
}

async function renderSeguimientosFicha(p, usuario, tareaSeleccionada) {
  const permitido = await puedeGestionar(p, usuario);
  const { rows: tareas } = await pool.query(`
    SELECT t.*, u.nombre AS responsable_nombre FROM crm_tareas t
    JOIN usuarios u ON u.id=t.responsable_id
    WHERE t.prospecto_id=$1 AND t.estado='pendiente' AND t.origen <> 'chatwoot'
    ORDER BY t.vence_en ASC LIMIT 50`, [p.id]);
  const seleccionada = tareas.find(t => Number(t.id) === Number(tareaSeleccionada));
  const terminal = ['confirmado', 'perdido'].includes(p.estado);
  const nombre = esc(p.contacto || p.nombre_negocio || `Prospecto #${p.id}`);
  const pendientes = tareas.length ? tareas.map(t => `<div class="crm-ficha-tarea">
       <div><strong>${esc(t.descripcion)}</strong><div class="crm-meta">${fechaAR(t.vence_en)} · Prioridad ${t.prioridad === 'alta' ? 'alta' : 'normal'} ${t.recordatorio ? '⏰ Recordatorio' : ''} · ${esc(t.responsable_nombre)}</div></div>
       ${permitido && !terminal ? `<a class="btn btn-secondary" href="/prospectos/${p.id}?tarea=${Number(t.id)}#seguimientos">Dejar seguimiento</a>` : ''}</div>`).join('')
       : '<div class="crm-empty">No hay próximos seguimientos programados.</div>';
  const formulario = permitido && !terminal ? `<form method="post" action="/prospectos/${p.id}/seguimientos" class="crm-ficha-form">
        ${seleccionada ? `<input type="hidden" name="tarea_id" value="${Number(seleccionada.id)}">` : ''}
        <label>¿Qué se hizo? <textarea name="gestion_realizada" required maxlength="2000" rows="3" placeholder="Ej.: Llamé, conversamos sobre los planes y quedó en revisarlo"></textarea></label>
        <label>Próxima acción <input name="proxima_accion" maxlength="300" value="${esc(seleccionada?.descripcion || '')}" placeholder="Ej.: Volver a llamar el viernes"></label>
        <label>Fecha y hora límite <input type="datetime-local" name="vence_en" value="${esc(fechaParaInput(seleccionada?.vence_en))}"></label>
        <label>Prioridad <select name="prioridad"><option value="normal" ${seleccionada?.prioridad !== 'alta' ? 'selected' : ''}>Normal</option><option value="alta" ${seleccionada?.prioridad === 'alta' ? 'selected' : ''}>Alta</option></select></label>
        <div class="crm-form-tip">Al programar una próxima acción con fecha se genera automáticamente un recordatorio ⏰, visible en la agenda. El seguimiento queda abierto hasta que el prospecto avance de etapa o se cierre.</div>
        <button type="submit" class="btn btn-primary">Guardar gestión y seguimiento</button>
      </form>` : '<p class="crm-help">Solo el responsable comercial o un administrador puede registrar nuevas gestiones de este prospecto.</p>';
  return `<section class="detail-section crm-ficha-section" id="seguimientos">
    <div class="section-title-row"><i class="ti ti-notes"></i><span>Seguimientos comerciales</span></div>
    ${p.estado === 'demo_realizada' ? `<p class="crm-help">Si el cliente confirma o no continúa, usá las acciones de cierre de esta ficha; eso retira sus tareas de la agenda.</p>` : ''}
    ${formulario}
    <p class="crm-help">Las gestiones guardadas también aparecen en el Historial de la ficha.</p>
    <h3 class="crm-ficha-subtitulo">Agenda pendiente (${tareas.length})</h3>${pendientes}
  </section>`;
}

router.post('/prospectos/:id/seguimientos', requireAuth, requireRol('admin', 'vendedor', 'soporte'), async (req, res) => {
  const id = Number(req.params.id);
  const usuario = req.session.usuario;
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).send('Prospecto inválido');
  const { rows: encontrados } = await pool.query('SELECT id,estado,chatwoot_conversation_id,demo_responsable,creado_por FROM prospectos WHERE id=$1', [id]);
  if (!encontrados.length) return res.status(404).send('Prospecto no encontrado');
  const p = encontrados[0];
  if (!await puedeGestionar(p, usuario)) return res.status(403).send('Sin permisos para gestionar esta oportunidad');
  if (['confirmado','perdido'].includes(p.estado)) return res.status(409).send('La oportunidad ya está cerrada');

  const gestion = String(req.body.gestion_realizada || '').trim();
  const siguiente = String(req.body.proxima_accion || '').trim();
  const fecha = fechaRecibida(req.body.vence_en);
  const prioridad = String(req.body.prioridad || 'normal');
  // El recordatorio es automático al indicar acción y fecha; no depende de un checkbox.
  const recordatorio = Boolean(siguiente && fecha);
  const tareaSolicitada = Number(req.body.tarea_id || 0);
  const tareaId = Number.isSafeInteger(tareaSolicitada) && tareaSolicitada > 0 ? tareaSolicitada : null;
  if (!gestion || gestion.length > 2000 || siguiente.length > 300 || !['normal','alta'].includes(prioridad) ||
      (Boolean(siguiente) !== Boolean(fecha)) ||
      (fecha && fecha.getTime() < Date.now() - 60000 && !tareaId)) {
    return res.status(400).send('Completá qué se hizo. Si programás un próximo paso, indicá acción y vencimiento válido.');
  }
  const responsable = await vendedorAsignado(p);
  if (!responsable) return res.status(400).send('Este prospecto no tiene responsable comercial');

  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    const vigente = await db.query('SELECT estado FROM prospectos WHERE id=$1 FOR UPDATE', [id]);
    if (!vigente.rows.length || vigente.rows[0].estado !== p.estado || ['confirmado','perdido'].includes(vigente.rows[0].estado)) {
      await db.query('ROLLBACK');
      return res.status(409).send('El prospecto cambió de etapa. Actualizá la ficha antes de registrar la gestión.');
    }
    // Siempre se valida que una tarea seleccionada pertenezca a esta ficha y permanezca abierta.
    if (tareaId) {
      const bloqueo = await db.query("SELECT id FROM crm_tareas WHERE id=$1 AND prospecto_id=$2 AND estado='pendiente' AND origen <> 'chatwoot' FOR UPDATE", [tareaId,id]);
      if (!bloqueo.rowCount) { await db.query('ROLLBACK'); return res.status(409).send('El seguimiento ya no está pendiente'); }
    }
    let idTarea = tareaId;
    if (siguiente && fecha) {
      if (tareaId) {
        await db.query(`UPDATE crm_tareas SET descripcion=$2,vence_en=$3,prioridad=$4,recordatorio=$5,
          responsable_id=$6,actualizada_en=NOW() WHERE id=$1`, [tareaId,siguiente,fecha,prioridad,recordatorio,responsable]);
      } else {
        const insert = await db.query(`INSERT INTO crm_tareas
          (prospecto_id,chatwoot_conversation_id,responsable_id,creado_por,tipo,descripcion,vence_en,prioridad,recordatorio,origen,etapa_origen)
          VALUES($1,$2,$3,$4,'seguimiento',$5,$6,$7,$8,'manual',$9) RETURNING id`,
        [id,p.chatwoot_conversation_id,responsable,usuario.id,siguiente,fecha,prioridad,recordatorio,p.estado]);
        idTarea = insert.rows[0].id;
      }
    }
    await db.query(`INSERT INTO crm_seguimientos
      (prospecto_id,tarea_id,usuario_id,gestion_realizada,proxima_accion,vence_en,prioridad,recordatorio)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id,idTarea,usuario.id,gestion,siguiente || null,fecha,prioridad,recordatorio]);
    await db.query('COMMIT');
    return res.redirect(`/prospectos/${id}?seguimiento=ok#seguimientos`);
  } catch(e) {
    if (db) await db.query('ROLLBACK').catch(() => {});
    console.error('[CRM] Error guardando gestión comercial:',e);
    return res.status(500).send('No se pudo guardar el seguimiento');
  } finally { if (db) db.release(); }
});

module.exports = { router, renderSeguimientosFicha, fechaRecibida, puedeGestionar };
