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
function enlaceChat(conversationId, inboxId = Number(process.env.BOT_INBOX_ID || 6)) {
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
    // Al abrir el CRM nunca se convierten registros históricos sin verificar en reclamos al asesor.
    const params = [];
    const responsable = filtroResponsable(usuario, 's.responsable_id', params);
    const chats = await pool.query(`
      SELECT s.*, cv.fecha_primera_respuesta_vendedor, u.nombre AS responsable_nombre,
             p.id AS prospecto_id, p.contacto, p.nombre_negocio
      FROM crm_chatwoot_estado s
      LEFT JOIN usuarios u ON u.id=s.responsable_id
      LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=s.chatwoot_conversation_id
      LEFT JOIN LATERAL (
        SELECT id, contacto, nombre_negocio, estado FROM prospectos p
        WHERE p.chatwoot_conversation_id=s.chatwoot_conversation_id
          OR EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones v
                     WHERE v.chatwoot_conversation_id=s.chatwoot_conversation_id AND v.prospecto_id=p.id)
        ORDER BY id DESC LIMIT 1
      ) p ON TRUE
      WHERE ${responsable}
        AND s.requiere_respuesta=TRUE
        AND s.ultima_revision > NOW()-interval '30 minutes'
        AND s.ultima_entrada >= NOW()-interval '14 days'
        AND COALESCE(p.estado, 'prospecto') NOT IN ('confirmado', 'perdido')
      ORDER BY s.ultima_entrada ASC LIMIT 100`, params);

    const fechaVerificada = esSupervisor(usuario)
      ? await pool.query('SELECT MAX(ultima_revision) AS ultima_revision, COUNT(*)::int AS total FROM crm_chatwoot_estado')
      : await pool.query('SELECT MAX(ultima_revision) AS ultima_revision, COUNT(*)::int AS total FROM crm_chatwoot_estado WHERE responsable_id=$1',[usuario.id]);
    const ultimaRevision = fechaVerificada.rows[0]?.ultima_revision;
    const verificacionVigente = Boolean(ultimaRevision && (Date.now() - new Date(ultimaRevision).getTime()) < 30 * 60000);
    const { configuracion, estadoSincronizacion } = require('./sync');
    const configurado = Boolean(configuracion());
    const syncEstado = estadoSincronizacion();

    // Si se realizó la demo recientemente, el CRM crea un seguimiento sin intervención del asesor.
    await pool.query(`
      INSERT INTO crm_tareas (prospecto_id,chatwoot_conversation_id,responsable_id,creado_por,
                             tipo,descripcion,vence_en,prioridad,origen,clave_automatica)
      SELECT p.id, p.chatwoot_conversation_id,
             COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por), NULL,
             'cierre', 'Contactar al prospecto después de la demostración y definir próximo paso',
             (p.actualizado_en AT TIME ZONE 'America/Argentina/Buenos_Aires') + interval '1 day',
             'alta', 'demo', 'cierre:' || p.id
      FROM prospectos p
      LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
      WHERE p.estado='demo_realizada' AND p.actualizado_en >= NOW()-interval '30 days'
        AND COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por) IS NOT NULL
      ON CONFLICT (clave_automatica) WHERE clave_automatica IS NOT NULL DO NOTHING`);
    await pool.query(`
      UPDATE crm_tareas t SET estado='cancelada',actualizada_en=NOW()
      WHERE t.origen='demo' AND t.estado='pendiente'
        AND NOT EXISTS (SELECT 1 FROM prospectos p WHERE p.id=t.prospecto_id AND p.estado='demo_realizada')`);

    const paramsT = [];
    const condT = filtroResponsable(usuario, 't.responsable_id', paramsT);
    const tareas = await pool.query(`
      SELECT t.*, p.nombre_negocio,p.contacto,u.nombre AS responsable_nombre
      FROM crm_tareas t LEFT JOIN prospectos p ON p.id=t.prospecto_id
      JOIN usuarios u ON u.id=t.responsable_id
      WHERE t.estado='pendiente' AND t.origen <> 'chatwoot' AND ${condT}
      ORDER BY (t.vence_en < NOW()) DESC,(t.prioridad='alta') DESC,t.vence_en ASC LIMIT 120`, paramsT);

    const paramsD = [];
    const condD = filtroResponsable(usuario, 'COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)', paramsD);
    const demos = await pool.query(`
      SELECT p.id,p.contacto,p.nombre_negocio,p.demo_fecha,p.chatwoot_conversation_id,
             u.nombre AS responsable_nombre FROM prospectos p
      LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
      LEFT JOIN usuarios u ON u.id=COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)
      WHERE p.estado='demo_coordinada' AND p.demo_fecha IS NOT NULL AND ${condD}
      ORDER BY p.demo_fecha ASC LIMIT 40`, paramsD);
    const paramsC = [];
    const condC = filtroResponsable(usuario, 'COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)', paramsC);
    const cierres = await pool.query(`
      SELECT p.id,p.contacto,p.nombre_negocio,p.actualizado_en,p.chatwoot_conversation_id,
             u.nombre AS responsable_nombre FROM prospectos p
      LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
      LEFT JOIN usuarios u ON u.id=COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)
      WHERE p.estado='demo_realizada' AND ${condC}
      ORDER BY p.actualizado_en ASC LIMIT 40`, paramsC);

    const paramsP = [];
    const condP = filtroResponsable(usuario, 'COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)', paramsP);
    const opciones = await pool.query(`
      SELECT DISTINCT p.id,p.contacto,p.nombre_negocio FROM prospectos p
      LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
      WHERE p.estado NOT IN ('confirmado','perdido') AND ${condP}
      ORDER BY p.id DESC LIMIT 150`, paramsP);
    const nombres = esSupervisor(usuario)
      ? (await pool.query("SELECT id,nombre FROM usuarios WHERE activo=TRUE AND rol IN ('admin','vendedor','soporte') ORDER BY nombre")).rows
      : [{ id: usuario.id,nombre: usuario.nombre }];

    const tareasRows = tareas.rows;
    const vencidas = tareasRows.filter(t => new Date(t.vence_en).getTime() < Date.now()).length;
    const chatsRows = chats.rows;
    const pendientesPrimera = chatsRows.filter(c => !c.fecha_primera_respuesta_vendedor).length;
    const format = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' });
    const fechaManana = format.format(new Date(Date.now()+86400000)).replace(' ','T');
    const elegido = /^\d+$/.test(String(req.query.prospecto||'')) ? String(req.query.prospecto)
      : /^\d+$/.test(String(req.query.chat||'')) ? `chat:${req.query.chat}` : '';
    const opcionesReferencias = opciones.rows.map(p => ({ value:String(p.id), nombre:p.nombre_negocio || p.contacto || `Prospecto #${p.id}` }));
    for (const c of chatsRows) {
      if (!opcionesReferencias.some(o => o.value===String(c.prospecto_id))) {
        opcionesReferencias.push({ value:`chat:${c.chatwoot_conversation_id}`, nombre:c.nombre_contacto || `Conversación #${c.chatwoot_conversation_id}` });
      }
    }
    if (elegido && !opcionesReferencias.some(o => o.value===elegido)) {
      // Permitir precargar una referencia desde la ficha, pero el POST validará los permisos.
      opcionesReferencias.unshift({value:elegido,nombre: elegido.startsWith('chat:') ? `Conversación #${elegido.slice(5)}` : `Prospecto #${elegido}`});
    }
    const sinSync = !verificacionVigente || !configurado;
    const syncParcial = Boolean(syncEstado.errores);
    const comentarioParcial = syncParcial ? ` · Atención: ${syncEstado.errores} chat(s) sin verificar en la última ronda.` : '';
    const bloqueSync = sinSync
      ? `<div class="crm-notice crm-warning"><i class="ti ti-alert-triangle"></i> ${configurado ? 'No hay una sincronización reciente con Chatwoot. Los mensajes por responder no pueden verificarse todavía.' : 'Falta configurar el acceso de lectura a Chatwoot. No se mostrarán supuestos pendientes sin comprobar.'}</div>`
      : `<div class="crm-notice"><i class="ti ti-refresh"></i> Mensajes comprobados con Chatwoot · última actualización ${fechaLocal(ultimaRevision)}. Los registros históricos no se cuentan como urgencias.${esc(comentarioParcial)}</div>`;
    const body = `
      <header class="crm-hero">
        <div><div class="crm-eyebrow">SM COMERCIAL · ${esSupervisor(usuario)?'SUPERVISIÓN':'MI AGENDA'}</div>
          <h1>Hola, ${esc(usuario.nombre.split(' ')[0])}</h1>
          <p>Primero respondé los mensajes; después organizá seguimientos y cierres.</p></div>
        <div class="crm-hero-actions"><form method="post" action="/crm/actualizar"><button class="btn btn-secondary" type="submit"><i class="ti ti-refresh"></i> Actualizar Chatwoot</button></form>
        <a class="btn btn-primary" href="#nueva-tarea"><i class="ti ti-plus"></i> Programar seguimiento</a></div>
      </header>
      ${bloqueSync}
      <div class="crm-stats">
        ${tarjeta('Mensajes por responder', sinSync?'—':chatsRows.length+(chatsRows.length===100?'+':''),'message-circle-exclamation',chatsRows.length?'urgent':'')}
        ${tarjeta('Sin primera respuesta registrada', sinSync?'—':pendientesPrimera,'message-exclamation','')}
        ${tarjeta('Seguimientos vencidos',vencidas,'clock-exclamation',vencidas?'urgent':'')}
        ${tarjeta('Seguimientos programados',tareasRows.length,'list-check','')}
        ${tarjeta('Por cerrar',cierres.rows.length,'target-arrow','')}
      </div>
      <div class="crm-two-col">
        <section class="crm-panel">
          <div class="crm-panel-title"><h2><i class="ti ti-message-circle-exclamation"></i> Clientes esperando respuesta</h2><span class="crm-count">${sinSync?'Sin verificar':chatsRows.length}</span></div>
          <p class="crm-help">Solo mensajes entrantes recientes sin una respuesta humana posterior detectada. Incluye conversaciones que Chatwoot dejó en Pendiente.</p>
          ${chatsRows.length?chatsRows.map(c=>{
            const url=enlaceChat(c.chatwoot_conversation_id,c.inbox_id);
            const fecha=c.ultima_entrada?fechaLocal(c.ultima_entrada):'Fecha no disponible';
            return `<article class="crm-mini-item"><div><strong>${esc(c.nombre_contacto||c.nombre_negocio||c.contacto||`Conversación #${c.chatwoot_conversation_id}`)}</strong><div class="crm-meta">Escribió ${esc(fecha)}${!c.fecha_primera_respuesta_vendedor?' · Sin primera atención registrada':''}${esSupervisor(usuario)?' · '+esc(c.responsable_nombre||`Responsable #${c.responsable_id}`):''}</div></div><div class="crm-actions">${url?`<a class="btn btn-primary" target="_blank" rel="noopener noreferrer" href="${esc(url)}">Responder</a>`:''}<a class="btn btn-secondary" href="/crm?chat=${Number(c.chatwoot_conversation_id)}#nueva-tarea">Programar</a></div></article>`;
          }).join(''): `<div class="crm-empty">${sinSync?'Todavía no hay mensajes verificados. Usá «Actualizar Chatwoot».':'No hay mensajes recientes pendientes de respuesta detectados.'}</div>`}
        </section>
        <section class="crm-panel"><div class="crm-panel-title"><h2><i class="ti ti-calendar-event"></i> Próximos seguimientos</h2><span class="crm-count">${tareasRows.length}</span></div>
          <p class="crm-help">Tareas programadas y seguimientos de cierre generados automáticamente después de las demos recientes.</p>
          ${tareasRows.length?tareasRows.map(t=>filaTarea(t,usuario)).join(''):'<div class="crm-empty">No hay seguimientos pendientes registrados.</div>'}
        </section>
      </div>
      <div class="crm-two-col crm-bottom">
        <section class="crm-panel"><div class="crm-panel-title"><h2><i class="ti ti-calendar-event"></i> Demos coordinadas</h2><span class="crm-count">${demos.rows.length}</span></div>
          ${demos.rows.length?demos.rows.map(p=>`<article class="crm-mini-item"><div><strong>${esc(p.nombre_negocio||p.contacto||`Prospecto #${p.id}`)}</strong><div class="crm-meta">${fechaDemoLocal(p.demo_fecha)}</div></div><div class="crm-actions"><a class="btn btn-secondary" href="/prospectos/${Number(p.id)}">Ficha</a><a class="btn btn-secondary" href="/crm?prospecto=${Number(p.id)}#nueva-tarea">Programar</a></div></article>`).join(''):'<div class="crm-empty">Sin demos coordinadas.</div>'}
        </section>
        <section class="crm-panel"><div class="crm-panel-title"><h2><i class="ti ti-target-arrow"></i> Oportunidades por cerrar</h2><span class="crm-count">${cierres.rows.length}</span></div>
          ${cierres.rows.length?cierres.rows.map(p=>`<article class="crm-mini-item"><div><strong>${esc(p.nombre_negocio||p.contacto||`Prospecto #${p.id}`)}</strong><div class="crm-meta">Demostración realizada · definir siguiente paso</div></div><div class="crm-actions"><a class="btn btn-secondary" href="/prospectos/${Number(p.id)}">Ficha</a><a class="btn btn-primary" href="/crm?prospecto=${Number(p.id)}#nueva-tarea">Seguimiento</a></div></article>`).join(''):'<div class="crm-empty">Sin demos pendientes de cierre.</div>'}
        </section>
      </div>
      <section class="crm-panel crm-form-panel" id="nueva-tarea"><div class="crm-panel-title"><h2><i class="ti ti-calendar-plus"></i> Programar próximo contacto</h2></div>
        <p class="crm-help">Elegí al cliente por nombre. No necesitás conocer el ID ni cambiar el estado de Chatwoot.</p>
        <form method="post" action="/crm/tareas" class="crm-task-form">
          <label>Prospecto o conversación
            <select name="referencia" required><option value="">Elegí una oportunidad…</option>${opcionesReferencias.map(p=>`<option value="${esc(p.value)}" ${elegido===p.value?'selected':''}>${esc(p.nombre)}</option>`).join('')}</select></label>
          <label>Tipo de gestión<select name="tipo">${Object.entries(TIPOS).map(([id,n])=>`<option value="${id}">${n}</option>`).join('')}</select></label>
          <label>Responsable<select name="responsable_id">${nombres.map(r=>`<option value="${Number(r.id)}" ${Number(r.id)===Number(usuario.id)?'selected':''}>${esc(r.nombre)}</option>`).join('')}</select></label>
          <label>Fecha y hora<input type="datetime-local" name="vence_en" value="${fechaManana}" required></label>
          <label class="crm-long">Qué hay que hacer<input name="descripcion" required maxlength="300" placeholder="Ej. Llamar para definir plan de contratación"></label>
          <label>Prioridad<select name="prioridad"><option value="normal">Normal</option><option value="alta">Alta</option></select></label>
          <button type="submit" class="btn btn-primary"><i class="ti ti-check"></i> Guardar seguimiento</button>
        </form>
      </section>`;
    return res.send(layout('Mi agenda',body,req));
  } catch(e) {
    console.error('[CRM] Error cargando agenda:',e);
    return res.status(500).send(layout('Error','<div class="alert alert-error">No se pudo cargar la agenda comercial. Revisá los logs del servicio.</div>',req));
  }
});

router.post('/crm/actualizar',requireAuth,requireRol('admin','vendedor','soporte'),async (req,res)=>{
  const { sincronizarCRM }=require('./sync');
  try {
    await sincronizarCRM({usuarioId: esSupervisor(req.session.usuario)?null:Number(req.session.usuario.id),limite:40});
    return res.redirect('/crm');
  } catch(e) {
    console.error('[CRM] Error en actualización manual:',e);
    return res.status(503).send(layout('Sincronización no disponible','<div class="alert alert-error">No se pudo verificar Chatwoot. Revisá la configuración y los logs.</div><a href="/crm">Volver</a>',req));
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
        const ownership = await pool.query(`
          SELECT 1 FROM control_ventas cv
          WHERE cv.vendedor_id=$2 AND (
            cv.chatwoot_conversation_id=$1
            OR EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones v
              WHERE v.prospecto_id=$3 AND v.chatwoot_conversation_id=cv.chatwoot_conversation_id)
          ) LIMIT 1`, [p.chatwoot_conversation_id, usuario.id, prospectoId]);
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
