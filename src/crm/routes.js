const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRol, layout } = require('../middleware/auth');
const router = express.Router();

const TIME_ZONE = 'America/Argentina/Buenos_Aires';
const TIPOS = { llamada: 'Llamada', seguimiento: 'Seguimiento', demo: 'Demostración', cierre: 'Cierre', otro: 'Otra gestión' };
function esc(x) {
  return String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fechaDemoLocal(d) {
  if (!d) return 'Sin fecha';
  // La columna demo_fecha es TIMESTAMP sin zona: conservar la hora local guardada.
  const fecha = new Date(d);
  if (Number.isNaN(fecha.getTime())) return 'Fecha inválida';
  const iso = fecha.toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
}
function fechaLocal(d) {
  if (!d) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-AR', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
}
function esSupervisor(u) { return u.rol === 'admin'; }
function filtroResponsable(u, campo, params) {
  if (esSupervisor(u)) return 'TRUE';
  params.push(u.id);
  return `${campo} = $${params.length}`;
}
function enlaceChat(conversationId) {
  const chatwoot = String(process.env.CHATWOOT_URL || '').replace(/\/$/, '');
  const cuenta = Number(process.env.CHATWOOT_ACCOUNT_ID || 1);
  if (!chatwoot || !conversationId) return '';
  return `${chatwoot}/app/accounts/${cuenta}/inbox/6/conversations/${Number(conversationId)}`;
}
function etiquetaTiempo(d) {
  return new Date(d).getTime() < Date.now() ? 'Vencida' : 'Programada';
}
function tarjeta(label, valor, icono, className) {
  return `<div class="crm-card ${className}"><div class="crm-card-head"><i class="ti ti-${icono}"></i><span>${esc(label)}</span></div><strong>${valor}</strong></div>`;
}
function filaTarea(t, usuario) {
  const late = new Date(t.vence_en).getTime() < Date.now();
  const url = enlaceChat(t.chatwoot_conversation_id);
  return `<article class="crm-item ${late ? 'crm-late' : ''}">
    <div class="crm-item-main">
      <div class="crm-item-top"><span class="crm-kind">${esc(TIPOS[t.tipo] || 'Seguimiento')}</span>${late ? '<span class="crm-overdue">Vencida</span>' : ''}${t.prioridad === 'alta' ? '<span class="crm-high">Prioridad alta</span>' : ''}</div>
      <strong>${esc(t.descripcion)}</strong>
      <div class="crm-meta">${esc(t.nombre_negocio || t.contacto || `Conversación #${t.chatwoot_conversation_id}`)} · ${fechaLocal(t.vence_en)}${esSupervisor(usuario) ? ' · ' + esc(t.responsable_nombre) : ''}</div>
    </div>
    <div class="crm-actions">
      ${t.prospecto_id ? `<a class="btn btn-secondary" href="/prospectos/${Number(t.prospecto_id)}">Ficha</a>` : ''}
      ${url ? `<a class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Chatwoot</a>` : ''}
      <form method="post" action="/crm/tareas/${Number(t.id)}/completar"><button class="btn btn-primary" type="submit" aria-label="Completar tarea">Hecha <i class="ti ti-check"></i></button></form>
    </div>
  </article>`;
}

router.get('/crm', requireAuth, requireRol('admin', 'vendedor', 'soporte'), async (req, res) => {
  const usuario = req.session.usuario;
  try {
    const params = [];
    const condicion = filtroResponsable(usuario, 't.responsable_id', params);
    const tareas = await pool.query(`
      SELECT t.*, p.nombre_negocio, p.contacto, u.nombre AS responsable_nombre
      FROM crm_tareas t
      LEFT JOIN prospectos p ON p.id = t.prospecto_id
      JOIN usuarios u ON u.id = t.responsable_id
      WHERE t.estado = 'pendiente' AND ${condicion}
      ORDER BY (t.vence_en < NOW()) DESC, (t.prioridad = 'alta') DESC, t.vence_en ASC
      LIMIT 120`, params);

    const sqlPendientes = [];
    const condicionPendientes = filtroResponsable(usuario, 'cv.vendedor_id', sqlPendientes);
    const primeraAtencion = await pool.query(`
      SELECT cv.chatwoot_conversation_id, cv.vendedor_nombre, cv.fecha_derivacion,
             cv.fecha_ingreso, COALESCE(p.contacto, p.nombre_negocio, 'Prospecto comercial') AS contacto,
             p.id AS prospecto_id
      FROM control_ventas cv
      LEFT JOIN prospectos p ON p.chatwoot_conversation_id = cv.chatwoot_conversation_id
      WHERE cv.derivado = TRUE AND cv.vendedor_id IS NOT NULL
        AND cv.fecha_primera_respuesta_vendedor IS NULL
        AND COALESCE(p.estado, 'prospecto') NOT IN ('confirmado', 'perdido')
        AND ${condicionPendientes}
      ORDER BY COALESCE(cv.fecha_derivacion, cv.fecha_ingreso) DESC
      LIMIT 60`, sqlPendientes);

    const paramsDemos = [];
    const condDemos = filtroResponsable(usuario, 'COALESCE(cv.vendedor_id, p.demo_responsable, p.creado_por)', paramsDemos);
    const demos = await pool.query(`
      SELECT p.id, p.contacto, p.nombre_negocio, p.demo_fecha, cv.chatwoot_conversation_id,
             u.nombre AS responsable_nombre
      FROM prospectos p
      LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id = p.chatwoot_conversation_id
      LEFT JOIN usuarios u ON u.id = COALESCE(cv.vendedor_id, p.demo_responsable, p.creado_por)
      WHERE p.estado = 'demo_coordinada' AND p.demo_fecha IS NOT NULL AND ${condDemos}
      ORDER BY p.demo_fecha ASC LIMIT 40`, paramsDemos);

    const paramsCierres = [];
    const condCierres = filtroResponsable(usuario, 'COALESCE(cv.vendedor_id, p.demo_responsable, p.creado_por)', paramsCierres);
    const cierres = await pool.query(`
      SELECT p.id, p.contacto, p.nombre_negocio, p.actualizado_en, cv.chatwoot_conversation_id,
             u.nombre AS responsable_nombre
      FROM prospectos p
      LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id = p.chatwoot_conversation_id
      LEFT JOIN usuarios u ON u.id = COALESCE(cv.vendedor_id, p.demo_responsable, p.creado_por)
      WHERE p.estado = 'demo_realizada' AND ${condCierres}
      ORDER BY p.actualizado_en ASC LIMIT 40`, paramsCierres);

    const responsables = esSupervisor(usuario)
      ? (await pool.query("SELECT id, nombre FROM usuarios WHERE activo=TRUE AND rol IN ('vendedor','soporte','admin') ORDER BY nombre")).rows
      : [{ id: usuario.id, nombre: usuario.nombre }];

    const tareasRows = tareas.rows;
    const vencidas = tareasRows.filter(t => new Date(t.vence_en) < new Date()).length;
    const pendientes = primeraAtencion.rows.length;
    const ahora = Date.now();
    const format = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const fechaManana = format.format(new Date(ahora + 24 * 3600 * 1000)).replace(' ', 'T');
    const body = `
      <header class="crm-hero">
        <div><div class="crm-eyebrow">SM COMERCIAL · ${esSupervisor(usuario) ? 'SUPERVISIÓN' : 'MI AGENDA'}</div>
          <h1>Buen día, ${esc(usuario.nombre.split(' ')[0])}</h1>
          <p>Gestioná prioridades, seguimientos y oportunidades desde un solo lugar.</p></div>
        <a class="btn btn-primary" href="#nueva-tarea"><i class="ti ti-plus"></i> Programar acción</a>
      </header>
      <div class="crm-stats">
        ${tarjeta('Sin primera atención', pendientes + (pendientes === 60 ? '+' : ''), 'message-exclamation', 'urgent')}
        ${tarjeta('Tareas vencidas', vencidas, 'clock-exclamation', vencidas ? 'urgent' : '')}
        ${tarjeta('Tareas pendientes', tareasRows.length + (tareasRows.length === 120 ? '+' : ''), 'list-check', '')}
        ${tarjeta('Demos coordinadas', demos.rows.length, 'video', '')}
        ${tarjeta('Por cerrar', cierres.rows.length, 'target-arrow', '')}
      </div>
      <div class="crm-two-col">
      <section class="crm-panel">
        <div class="crm-panel-title"><h2><i class="ti ti-message-circle-exclamation"></i> Sin primera atención</h2><span class="crm-count">${pendientes}${pendientes === 60 ? '+' : ''}</span></div>
        <p class="crm-help">Derivados sin primera respuesta humana registrada. No se confunden con clientes que ya recibieron atención.</p>
        ${primeraAtencion.rows.length ? primeraAtencion.rows.map(p => {
          const url = enlaceChat(p.chatwoot_conversation_id);
          return `<article class="crm-mini-item"><div><strong>${esc(p.contacto)}</strong><div class="crm-meta">${fechaLocal(p.fecha_derivacion || p.fecha_ingreso)} · ${esc(p.vendedor_nombre || 'Sin vendedor')}</div></div><div>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">Abrir chat</a>` : ''}</div></article>`;
        }).join('') : '<div class="crm-empty">No hay casos sin primera atención.</div>'}
      </section>
      <section class="crm-panel">
        <div class="crm-panel-title"><h2><i class="ti ti-clipboard-list"></i> Próximas acciones</h2><span class="crm-count">${tareasRows.length}${tareasRows.length === 120 ? '+' : ''}</span></div>
        <p class="crm-help">Cada compromiso tiene un responsable y vencimiento. Marcá completada una tarea cuando la hayas realizado.</p>
        ${tareasRows.length ? tareasRows.map(t => filaTarea(t, usuario)).join('') : '<div class="crm-empty">No hay tareas abiertas. Programá el próximo contacto de tus oportunidades.</div>'}
      </section>
      </div>
      <div class="crm-two-col crm-bottom">
        <section class="crm-panel"><div class="crm-panel-title"><h2><i class="ti ti-calendar-event"></i> Demos coordinadas</h2><span class="crm-count">${demos.rows.length}</span></div>
          ${demos.rows.length ? demos.rows.map(p => `<article class="crm-mini-item"><div><strong>${esc(p.nombre_negocio || p.contacto)}</strong><div class="crm-meta">${esc(p.contacto)} · ${fechaDemoLocal(p.demo_fecha)}${esSupervisor(usuario) ? ' · ' + esc(p.responsable_nombre) : ''}</div></div><a href="/prospectos/${Number(p.id)}" class="btn btn-secondary">Ficha</a></article>`).join('') : '<div class="crm-empty">Sin demos coordinadas.</div>'}
        </section>
        <section class="crm-panel"><div class="crm-panel-title"><h2><i class="ti ti-target-arrow"></i> Oportunidades por cerrar</h2><span class="crm-count">${cierres.rows.length}</span></div>
          ${cierres.rows.length ? cierres.rows.map(p => `<article class="crm-mini-item"><div><strong>${esc(p.nombre_negocio || p.contacto)}</strong><div class="crm-meta">Demo realizada · ${esc(p.contacto)}${esSupervisor(usuario) ? ' · ' + esc(p.responsable_nombre) : ''}</div></div><a href="/prospectos/${Number(p.id)}" class="btn btn-secondary">Gestionar</a></article>`).join('') : '<div class="crm-empty">Sin demos pendientes de cierre.</div>'}
        </section>
      </div>
      <section class="crm-panel crm-form-panel" id="nueva-tarea"><div class="crm-panel-title"><h2><i class="ti ti-calendar-plus"></i> Programar próxima acción</h2></div>
        <p class="crm-help">No cambies el estado de Chatwoot para recordar un seguimiento; creá una tarea comercial.</p>
        <form method="post" action="/crm/tareas" class="crm-task-form">
          <label>Prospecto ID o conversación de Chatwoot
            <input name="referencia" value="${/^\d+$/.test(String(req.query.prospecto || '')) ? esc(req.query.prospecto) : ''}" placeholder="Ej. 107 o chat:3080" required maxlength="80" autocomplete="off"></label>
          <label>Acción
            <select name="tipo">${Object.entries(TIPOS).map(([id,n]) => `<option value="${id}">${n}</option>`).join('')}</select></label>
          <label>Responsable
            <select name="responsable_id">${responsables.map(r => `<option value="${Number(r.id)}" ${Number(r.id)===Number(usuario.id)?'selected':''}>${esc(r.nombre)}</option>`).join('')}</select></label>
          <label>Fecha y hora
            <input type="datetime-local" name="vence_en" value="${fechaManana}" required></label>
          <label class="crm-long">Qué hay que hacer
            <input name="descripcion" required maxlength="300" placeholder="Ej. Llamar para definir el plan y cerrar la propuesta"></label>
          <label>Prioridad
            <select name="prioridad"><option value="normal">Normal</option><option value="alta">Alta</option></select></label>
          <button type="submit" class="btn btn-primary"><i class="ti ti-plus"></i> Guardar seguimiento</button>
        </form>
        <p class="crm-help">Para usar una conversación escribí <strong>chat:3080</strong>; para una ficha interna, su ID numérico.</p>
      </section>`;
    return res.send(layout('Mi agenda', body, req));
  } catch (e) {
    console.error('[CRM] Error cargando agenda:', e);
    return res.status(500).send(layout('Error', '<div class="alert alert-error">No se pudo cargar la agenda comercial. Revisá los logs del servicio.</div>', req));
  }
});

router.post('/crm/tareas', requireAuth, requireRol('admin','vendedor','soporte'), async (req, res) => {
  const usuario = req.session.usuario;
  try {
    const raw = String(req.body.referencia || '').trim();
    const esChat = /^chat:\d{1,15}$/i.test(raw);
    const esProspecto = /^\d{1,12}$/.test(raw);
    const tipo = String(req.body.tipo || 'seguimiento');
    const prioridad = String(req.body.prioridad || 'normal');
    const descripcion = String(req.body.descripcion || '').trim();
    const responsable = esSupervisor(usuario) ? Number(req.body.responsable_id) : Number(usuario.id);
    const fechaRaw = String(req.body.vence_en || '');
    const vence = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(fechaRaw) ? new Date(`${fechaRaw}:00-03:00`) : new Date('bad date');
    if ((!esChat && !esProspecto) || !TIPOS[tipo] || !['normal','alta'].includes(prioridad) || !descripcion || descripcion.length > 300 || !Number.isInteger(responsable) || Number.isNaN(vence.getTime())) {
      return res.status(400).send(layout('Datos incompletos', '<div class="alert alert-error">Revisá el prospecto, fecha, responsable y descripción.</div><a href="/crm">Volver</a>', req));
    }
    const owner = await pool.query("SELECT id FROM usuarios WHERE id=$1 AND activo=TRUE AND rol IN ('admin','soporte','vendedor')", [responsable]);
    if (!owner.rowCount) return res.status(400).send('Responsable inválido');
    let prospectoId = null, conversacionId = null;
    if (esChat) conversacionId = Number(raw.split(':')[1]);
    else {
      prospectoId = Number(raw);
      const prospecto = await pool.query('SELECT id, creado_por, demo_responsable, chatwoot_conversation_id FROM prospectos WHERE id=$1', [prospectoId]);
      if (!prospecto.rowCount) return res.status(404).send('No existe ese prospecto');
      const p = prospecto.rows[0];
      if (!esSupervisor(usuario)) {
        const ownership = await pool.query('SELECT 1 FROM control_ventas WHERE chatwoot_conversation_id=$1 AND vendedor_id=$2', [p.chatwoot_conversation_id, usuario.id]);
        if (!ownership.rowCount && Number(p.demo_responsable) !== usuario.id && Number(p.creado_por) !== usuario.id) return res.status(403).send('No podés cargar tareas para ese prospecto');
      }
      conversacionId = p.chatwoot_conversation_id;
    }
    if (esChat && !esSupervisor(usuario)) {
      const assigned = await pool.query('SELECT 1 FROM control_ventas WHERE chatwoot_conversation_id=$1 AND vendedor_id=$2', [conversacionId, usuario.id]);
      if (!assigned.rowCount) return res.status(403).send('La conversación no está asignada a tu usuario');
    }
    await pool.query(`INSERT INTO crm_tareas (prospecto_id,chatwoot_conversation_id,responsable_id,creado_por,tipo,descripcion,vence_en,prioridad)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [prospectoId, conversacionId, responsable, usuario.id, tipo, descripcion, vence, prioridad]);
    return res.redirect('/crm');
  } catch (e) {
    console.error('[CRM] Error creando tarea:', e);
    return res.status(500).send('No se pudo guardar el seguimiento');
  }
});

router.post('/crm/tareas/:id/completar', requireAuth, requireRol('admin','vendedor','soporte'), async (req, res) => {
  const u = req.session.usuario;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).send('ID inválido');
  const params = [id];
  const owner = esSupervisor(u) ? '' : ` AND responsable_id=$2`;
  if (!esSupervisor(u)) params.push(u.id);
  try {
    const result = await pool.query(`UPDATE crm_tareas SET estado='completada', completada_en=NOW(), actualizada_en=NOW()
      WHERE id=$1 AND estado='pendiente'${owner} RETURNING id`, params);
    if (!result.rowCount) return res.status(404).send('Tarea inexistente o sin permisos');
    return res.redirect('/crm');
  } catch (e) {
    console.error('[CRM] Error cerrando tarea:', e);
    return res.status(500).send('Error al completar la tarea');
  }
});
module.exports = router;
