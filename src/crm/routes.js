'use strict';
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRol, layout } = require('../middleware/auth');
const { router: seguimientosRouter } = require('./seguimientos');
const router = express.Router();
router.use(seguimientosRouter);
const TIME_ZONE = 'America/Argentina/Buenos_Aires';
const esc = x => String(x ?? '').replace(/&/g, '&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const supervisor = u => u.rol === 'admin';
function filtro(u, campo, params) {
  if (supervisor(u)) return 'TRUE';
  params.push(u.id);
  return `${campo} = $${params.length}`;
}
function fechaAR(d) {
  if (!d) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-AR', { timeZone:TIME_ZONE,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit' }).format(new Date(d));
}
function fechaDemo(d) {
  if (!d) return 'Sin fecha';
  // demo_fecha se guarda como hora local (timestamp sin zona)
  const iso = new Date(d).toISOString();
  return `${iso.slice(8,10)}/${iso.slice(5,7)} ${iso.slice(11,16)}`;
}
function chatUrl(id, inbox = 6) {
  const base = String(process.env.CHATWOOT_URL || '').replace(/\/$/,'');
  const account = Number(process.env.CHATWOOT_ACCOUNT_ID || 1);
  const inboxId = Number(inbox);
  return base && Number.isSafeInteger(Number(id)) && Number(id)>0 && Number.isSafeInteger(inboxId)
    ? `${base}/app/accounts/${account}/inbox/${inboxId}/conversations/${Number(id)}` : '';
}
function tituloContacto(p) { return esc(p.nombre_contacto || p.nombre_negocio || p.contacto || `Conversación #${p.chatwoot_conversation_id}`); }
function filaSeguimiento(t, usuario) {
  const overdue = new Date(t.vence_en).getTime() < Date.now();
  const url = chatUrl(t.chatwoot_conversation_id, t.inbox_id || 6);
  const p = Number(t.prospecto_id);
  return `<article class="crm-item ${overdue?'crm-late':''}">
    <div class="crm-item-main">
      <div class="crm-item-top">
        <span class="crm-kind">${esc(t.tipo === 'cierre'?'Cierre':t.tipo === 'llamada'?'Llamada':'Seguimiento')}</span>
        <span class="${t.prioridad === 'alta'?'crm-high':'crm-normal'}">${t.prioridad === 'alta'?'Prioridad alta':'Prioridad normal'}</span>
        ${overdue?'<span class="crm-overdue">Vencido</span>':''}
        ${t.recordatorio?'<span class="crm-reminder" title="Tiene recordatorio">⏰ Recordatorio</span>':''}
      </div>
      <strong>${esc(t.nombre_negocio || t.contacto || `Conversación #${t.chatwoot_conversation_id}`)}</strong>
      <div class="crm-followup-detail">${esc(t.descripcion)}</div>
      <div class="crm-meta">Vence ${fechaAR(t.vence_en)}${supervisor(usuario)?' · '+esc(t.responsable_nombre):''}</div>
    </div>
    <div class="crm-actions">
      ${p>0?`<a class="btn btn-secondary" href="/prospectos/${p}">Ir a ficha</a>`:''}
      ${url?`<a class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Contactar vía Chatwoot</a>`:''}
      ${p>0?`<a class="btn btn-primary" href="/prospectos/${p}?tarea=${Number(t.id)}#seguimientos">Dejar seguimiento</a>`:''}
    </div>
  </article>`;
}

router.get('/crm', requireAuth, requireRol('admin','vendedor','soporte'), async (req,res) => {
  const usuario = req.session.usuario;
  try {
    const params = [];
    const owner = filtro(usuario,'s.responsable_id',params);
    const {rows: mensajes} = await pool.query(`
      SELECT s.*,u.nombre AS responsable_nombre,p.id AS prospecto_id,p.contacto,p.nombre_negocio
      FROM crm_chatwoot_estado s
      LEFT JOIN usuarios u ON u.id=s.responsable_id
      LEFT JOIN LATERAL (
        SELECT p.id,p.contacto,p.nombre_negocio,p.estado FROM prospectos p
        WHERE p.chatwoot_conversation_id=s.chatwoot_conversation_id OR EXISTS
          (SELECT 1 FROM prospectos_chatwoot_conversaciones v
           WHERE v.prospecto_id=p.id AND v.chatwoot_conversation_id=s.chatwoot_conversation_id)
        ORDER BY p.id DESC LIMIT 1
      ) p ON TRUE
      WHERE ${owner} AND s.requiere_respuesta=TRUE
        AND s.ultima_revision >= NOW()-interval '30 minutes'
        AND s.ultima_entrada >= NOW()-interval '14 days'
        AND COALESCE(p.estado,'prospecto') NOT IN ('confirmado','perdido')
      ORDER BY s.ultima_entrada ASC LIMIT 100`,params);
    const ver = supervisor(usuario)
      ? await pool.query('SELECT MAX(ultima_revision) AS revisado FROM crm_chatwoot_estado')
      : await pool.query('SELECT MAX(ultima_revision) AS revisado FROM crm_chatwoot_estado WHERE responsable_id=$1',[usuario.id]);
    const ultimaRevision = ver.rows[0]?.revisado;
    const {configuracion,estadoSincronizacion} = require('./sync');
    const sinSync = !configuracion() || !ultimaRevision || Date.now()-new Date(ultimaRevision).getTime() >= 30*60000;
    const errSync = estadoSincronizacion().errores || 0;

    // Retirar de la agenda los compromisos de etapas ya cambiadas, incluidos cambios desde otras integraciones.
    await pool.query(`UPDATE crm_tareas t SET estado='cancelada',actualizada_en=NOW()
      FROM prospectos p WHERE t.prospecto_id=p.id AND t.estado='pendiente' AND t.origen <> 'chatwoot'
        AND (p.estado IN ('confirmado','perdido') OR
             (t.etapa_origen IS NOT NULL AND t.etapa_origen IS DISTINCT FROM p.estado))`);

    // Demo realizada: seguimiento inicial automático, prioridad alta y plazo de 24 h corridas desde el cambio de etapa.
    await pool.query(`
      INSERT INTO crm_tareas (prospecto_id,chatwoot_conversation_id,responsable_id,creado_por,
                             tipo,descripcion,vence_en,prioridad,origen,clave_automatica,etapa_origen)
      SELECT p.id,p.chatwoot_conversation_id,COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por),NULL,
             'cierre','Contactar después de la demostración y definir próximo paso',
             (p.actualizado_en AT TIME ZONE 'America/Argentina/Buenos_Aires') + interval '1 day',
             'alta','demo','cierre:'||p.id,'demo_realizada'
      FROM prospectos p LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
      WHERE p.estado='demo_realizada' AND p.actualizado_en >= NOW()-interval '30 days'
        AND COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por) IS NOT NULL
      ON CONFLICT (clave_automatica) WHERE clave_automatica IS NOT NULL DO NOTHING`);

    const pt=[];
    const condT=filtro(usuario,'t.responsable_id',pt);
    const {rows:tareas}=await pool.query(`
      SELECT t.*,p.nombre_negocio,p.contacto,u.nombre AS responsable_nombre,s.inbox_id
      FROM crm_tareas t
      LEFT JOIN prospectos p ON p.id=t.prospecto_id
      LEFT JOIN usuarios u ON u.id=t.responsable_id
      LEFT JOIN crm_chatwoot_estado s ON s.chatwoot_conversation_id=t.chatwoot_conversation_id
      WHERE t.estado='pendiente' AND t.origen <> 'chatwoot' AND ${condT}
      ORDER BY (t.vence_en < NOW()) DESC,(t.prioridad='alta') DESC,t.vence_en ASC LIMIT 150`,pt);

    const pd=[];
    const condD=filtro(usuario,'COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)',pd);
    const {rows:demos}=await pool.query(`
      SELECT p.id,p.contacto,p.nombre_negocio,p.demo_fecha,p.chatwoot_conversation_id
      FROM prospectos p LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
      WHERE p.estado='demo_coordinada' AND p.demo_fecha IS NOT NULL AND ${condD}
      ORDER BY p.demo_fecha ASC LIMIT 50`,pd);
    const pc=[];
    const condC=filtro(usuario,'COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)',pc);
    const {rows:cierres}=await pool.query(`
      SELECT p.id,p.contacto,p.nombre_negocio,p.chatwoot_conversation_id
      FROM prospectos p LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
      WHERE p.estado='demo_realizada' AND ${condC}
      ORDER BY p.actualizado_en ASC LIMIT 50`,pc);

    const notice = sinSync
      ? `<div class="crm-notice crm-warning"><i class="ti ti-alert-triangle"></i> No hay verificación reciente de Chatwoot. La lista de mensajes podría estar incompleta. Usá «Actualizar Chatwoot».</div>`
      : `<div class="crm-notice"><i class="ti ti-refresh"></i> Última revisión de Chatwoot: ${fechaAR(ultimaRevision)}.${errSync?' Hay '+errSync+' conversación(es) que no pudieron verificarse.':''}</div>`;
    const descartado = req.query.descartado === '1'
      ? `<div class="crm-notice crm-success"><i class="ti ti-circle-check"></i> Conversación considerada atendida para esta agenda. Volverá a aparecer si el cliente envía un nuevo mensaje. No se modificó Chatwoot.</div>` : '';
    const html=`
      <header class="crm-hero"><div><div class="crm-eyebrow">SM COMERCIAL · ${supervisor(usuario)?'SUPERVISIÓN':'MI AGENDA'}</div>
        <h1>Hola, ${esc(usuario.nombre.split(' ')[0])}</h1>
        <p>Primero atendé las conversaciones; después registrá gestiones y próximos pasos desde cada ficha.</p></div>
        <div class="crm-hero-actions"><form method="post" action="/crm/actualizar"><button class="btn btn-secondary" type="submit"><i class="ti ti-refresh"></i> Actualizar Chatwoot</button></form></div>
      </header>${descartado}${notice}
      <div class="crm-pila">
        <section class="crm-panel" id="esperando-respuesta">
          <div class="crm-panel-title"><h2><i class="ti ti-message-circle-exclamation"></i> Conversaciones esperando respuesta</h2><span class="crm-count">${sinSync?'Sin verificar':mensajes.length}</span></div>
          <p class="crm-help">Solo se muestran conversaciones cuyo último mensaje público es del cliente y todavía no tienen una respuesta posterior.</p>
          ${mensajes.length?mensajes.map(c=>{
            const url=chatUrl(c.chatwoot_conversation_id,c.inbox_id);
            return `<article class="crm-mini-item"><div class="crm-item-main"><strong>${tituloContacto(c)}</strong>
              <div class="crm-meta">Escribió ${fechaAR(c.ultima_entrada)}${supervisor(usuario)?' · '+esc(c.responsable_nombre||'Sin responsable'):''}</div></div>
              <div class="crm-actions">${url?`<a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Responder</a>`:''}
                <form method="post" action="/crm/conversaciones/${Number(c.chatwoot_conversation_id)}/descartar" onsubmit="return confirm('¿Descartar este mensaje? Se considerará el chat atendido para la agenda, sin enviar respuesta ni cambiar el estado en Chatwoot. Volverá a aparecer cuando el cliente escriba de nuevo.')">
                  <input type="hidden" name="mensaje_id" value="${esc(c.ultimo_mensaje_id)}">
                  <button type="submit" class="btn btn-secondary">Descartar hasta próximo mensaje</button>
                </form>
              </div></article>`;
          }).join(''): `<div class="crm-empty">${sinSync?'No se pueden confirmar mensajes pendientes hasta actualizar Chatwoot.':'No hay mensajes esperando respuesta.'}</div>`}
        </section>
        <section class="crm-panel" id="agenda-seguimientos">
          <div class="crm-panel-title"><h2><i class="ti ti-calendar-time"></i> Agenda de seguimientos</h2><span class="crm-count">${tareas.length}</span></div>
          <p class="crm-help">Próximos pasos abiertos, con prioridad y vencimiento. ⏰ señala los que tienen recordatorio activado. Se gestionan desde la ficha y salen de la agenda al avanzar la etapa comercial.</p>
          ${tareas.length?tareas.map(t=>filaSeguimiento(t,usuario)).join(''):'<div class="crm-empty">No hay seguimientos comerciales pendientes.</div>'}
        </section>
        <section class="crm-panel" id="agenda-demos">
          <div class="crm-panel-title"><h2><i class="ti ti-calendar-event"></i> Agenda de demos</h2><span class="crm-count">${demos.length}</span></div>
          ${demos.length?demos.map(p=>`<article class="crm-mini-item"><div><strong>${esc(p.nombre_negocio||p.contacto||`Prospecto #${p.id}`)}</strong><div class="crm-meta">${fechaDemo(p.demo_fecha)}</div></div>
            <div class="crm-actions"><a class="btn btn-secondary" href="/prospectos/${Number(p.id)}">Ir a ficha</a>
              ${chatUrl(p.chatwoot_conversation_id)?`<a class="btn btn-secondary" target="_blank" rel="noopener noreferrer" href="${esc(chatUrl(p.chatwoot_conversation_id))}">Chatwoot</a>`:''}</div></article>`).join(''):'<div class="crm-empty">Sin demos coordinadas.</div>'}
        </section>
        <section class="crm-panel" id="por-cerrar">
          <div class="crm-panel-title"><h2><i class="ti ti-target-arrow"></i> Oportunidades por cerrar</h2><span class="crm-count">${cierres.length}</span></div>
          ${cierres.length?cierres.map(p=>`<article class="crm-mini-item"><div><strong>${esc(p.nombre_negocio||p.contacto||`Prospecto #${p.id}`)}</strong><div class="crm-meta">Demostración realizada · definir confirmación, pérdida o próximo paso</div></div>
            <div class="crm-actions"><a class="btn btn-secondary" href="/prospectos/${Number(p.id)}">Ir a ficha</a>
            <a class="btn btn-primary" href="/prospectos/${Number(p.id)}#seguimientos">Dejar seguimiento</a></div></article>`).join(''):'<div class="crm-empty">Sin oportunidades pendientes de cierre.</div>'}
        </section>
      </div>`;
    return res.send(layout('Mi agenda',html,req));
  } catch(err) {
    console.error('[CRM] Error en Mi agenda:',err);
    return res.status(500).send(layout('Error','<div class="alert alert-error">No se pudo cargar la agenda. Revisá los logs de Railway.</div>',req));
  }
});

router.post('/crm/actualizar', requireAuth,requireRol('admin','vendedor','soporte'),async(req,res)=>{
  try {
    const {sincronizarCRM}=require('./sync');
    await sincronizarCRM({ usuarioId:supervisor(req.session.usuario)?null:Number(req.session.usuario.id),limite:40 });
    return res.redirect('/crm');
  } catch(err) {
    console.error('[CRM] Error actualizando Chatwoot:',err);
    return res.status(503).send('No se pudo actualizar Chatwoot. Revisá los logs.');
  }
});

router.post('/crm/conversaciones/:id/descartar',requireAuth,requireRol('admin','vendedor','soporte'),async(req,res)=>{
  const u=req.session.usuario;
  const id=Number(req.params.id);
  const mensaje=String(req.body.mensaje_id||'');
  if (!Number.isSafeInteger(id) || id<1 || !/^[a-zA-Z0-9_:-]{1,60}$/.test(mensaje)) return res.status(400).send('Conversación o mensaje inválido');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const args=supervisor(u)?[id,mensaje,u.id]:[id,mensaje,u.id,u.id];
    const auth=supervisor(u)?'':'AND responsable_id=$4';
    const result=await db.query(`UPDATE crm_chatwoot_estado
      SET descartado_mensaje_id=$2,descartado_en=NOW(),descartado_por=$3,requiere_respuesta=FALSE
      WHERE chatwoot_conversation_id=$1 AND ultimo_mensaje_id=$2 AND requiere_respuesta=TRUE
        AND ultima_revision >= NOW()-interval '30 minutes' ${auth}
      RETURNING chatwoot_conversation_id`,args);
    if (!result.rowCount) {await db.query('ROLLBACK');return res.status(409).send('La conversación cambió o no está asignada a tu usuario. Actualizá Chatwoot e intentá otra vez.');}
    await db.query(`UPDATE crm_tareas SET estado='cancelada',actualizada_en=NOW()
      WHERE clave_automatica=$1 AND estado='pendiente'`,[`respuesta:${id}`]);
    await db.query('COMMIT');
    return res.redirect('/crm?descartado=1#esperando-respuesta');
  } catch(err) {
    await db.query('ROLLBACK').catch(()=>{});
    console.error('[CRM] Error descartando mensaje:',err);
    return res.status(500).send('No se pudo descartar el mensaje');
  } finally {db.release();}
});

module.exports=router;
