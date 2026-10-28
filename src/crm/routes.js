'use strict';
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRol, layout } = require('../middleware/auth');
const { router: seguimientosRouter } = require('./seguimientos');
const { seleccionarAgendaHoy } = require('./agenda');
const { pasoPorEstado } = require('./pasos');
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
  const limite = t.vence_en ? new Date(t.vence_en).getTime() : null;
  const overdue = limite !== null && limite < Date.now();
  const url = chatUrl(t.chatwoot_conversation_id, t.inbox_id || 6);
  const p = Number(t.prospecto_id);
  const nombre = esc(t.nombre_negocio || t.contacto || `Conversación #${t.chatwoot_conversation_id}`);
  const descripcion = esc(t.descripcion || 'Registrar la próxima gestión comercial');
  const detalleFecha = t.recordatorio
    ? `⏰ Recordatorio ${t.recordatorio_vencido?'vencido':'programado'}: ${fechaAR(t.vence_en)}`
    : t.vence_en ? `Vencimiento: ${fechaAR(t.vence_en)}` : 'Vencimiento: sin definir';
  return `<article class="crm-item ${overdue?'crm-late':''}">
    <div class="crm-item-main">
      <div class="crm-item-top">
        <span class="${t.prioridad === 'alta'?'crm-high':'crm-normal'}">${t.prioridad === 'alta'?'Prioridad alta':'Prioridad normal'}</span>
        ${t.recordatorio
          ? `<span class="crm-reminder" title="${t.recordatorio_vencido?'Recordatorio vencido':'Recordatorio programado'}">⏰ ${t.recordatorio_vencido?'Recordatorio vencido':'Recordatorio programado'}</span>`
          : '<span class="crm-no-reminder">Sin recordatorio</span>'}
        ${overdue && !t.recordatorio_vencido ? '<span class="crm-overdue">Vencido</span>' : ''}
        ${t.requiere_respuesta ? '<span class="crm-kind">Mensaje sin responder</span>' : ''}
      </div>
      <strong>${nombre}</strong>
      <div class="crm-followup-detail">${descripcion}</div>
      <div class="crm-meta">${detalleFecha}${supervisor(usuario)?' · '+esc(t.responsable_nombre):''}</div>
    </div>
    <div class="crm-actions">
      ${p>0?`<a class="btn btn-secondary" href="/prospectos/${p}">Ir a ficha</a>`:''}
      ${url?`<a class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Contactar vía Chatwoot</a>`:''}
      ${p>0?`<a class="btn btn-primary" href="/prospectos/${p}${t.tarea_id?'?tarea='+Number(t.tarea_id):''}#seguimientos">Dejar seguimiento</a>`:''}
    </div>
  </article>`;
}

router.get('/crm', requireAuth, requireRol('admin','vendedor','soporte'), async (req,res) => {
  const usuario = req.session.usuario;
  try {
    const params = [];
    const owner = filtro(usuario,'s.responsable_id',params);
    const {rows: mensajes} = await pool.query(`
      SELECT s.*,u.nombre AS responsable_nombre,p.id AS prospecto_id,p.contacto,p.nombre_negocio,p.estado,
        to_char(p.demo_fecha, 'YYYY-MM-DD"T"HH24:MI:SS') AS demo_fecha_local
      FROM crm_chatwoot_estado s
      LEFT JOIN usuarios u ON u.id=s.responsable_id
      LEFT JOIN LATERAL (
        SELECT p.id,p.contacto,p.nombre_negocio,p.estado,p.demo_fecha FROM prospectos p
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
      SELECT t.*,p.nombre_negocio,p.contacto,p.estado,
        to_char(p.demo_fecha, 'YYYY-MM-DD"T"HH24:MI:SS') AS demo_fecha_local,
        u.nombre AS responsable_nombre,s.inbox_id
      FROM crm_tareas t
      LEFT JOIN prospectos p ON p.id=t.prospecto_id
      LEFT JOIN usuarios u ON u.id=t.responsable_id
      LEFT JOIN crm_chatwoot_estado s ON s.chatwoot_conversation_id=t.chatwoot_conversation_id
      WHERE t.estado='pendiente' AND ${condT}
        AND (t.origen <> 'chatwoot' OR (s.requiere_respuesta=TRUE AND s.ultima_revision>=NOW()-interval '30 minutes'))
      ORDER BY t.vence_en ASC LIMIT 2000`,pt);

    // Oportunidades activas, incluidas las que ya tienen un recordatorio futuro: nunca ocultar sus seguimientos.
    const po=[];
    const condO=filtro(usuario,'COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)',po);
    const {rows:oportunidades}=await pool.query(`
      SELECT p.id AS prospecto_id,COALESCE(cv.chatwoot_conversation_id,p.chatwoot_conversation_id) AS chatwoot_conversation_id,p.nombre_negocio,p.contacto,
        p.estado,to_char(p.demo_fecha, 'YYYY-MM-DD"T"HH24:MI:SS') AS demo_fecha_local,
        u.nombre AS responsable_nombre,s.nombre_contacto,s.inbox_id,s.ultima_entrada
      FROM prospectos p
      LEFT JOIN LATERAL (
        SELECT cv.vendedor_id,cv.chatwoot_conversation_id
        FROM control_ventas cv
        WHERE cv.chatwoot_conversation_id=p.chatwoot_conversation_id
           OR EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones v
                      WHERE v.prospecto_id=p.id AND v.chatwoot_conversation_id=cv.chatwoot_conversation_id)
        ORDER BY cv.actualizado_en DESC NULLS LAST LIMIT 1
      ) cv ON TRUE
      LEFT JOIN crm_chatwoot_estado s
        ON s.chatwoot_conversation_id=COALESCE(cv.chatwoot_conversation_id,p.chatwoot_conversation_id)
      LEFT JOIN usuarios u ON u.id=COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)
      WHERE p.estado NOT IN ('confirmado','perdido','demo_coordinada') AND ${condO}
        AND (p.actualizado_en >= NOW()-interval '45 days'
             OR s.ultima_entrada >= NOW()-interval '45 days')
      ORDER BY p.actualizado_en DESC LIMIT 400`,po);
    const agendaHoy=seleccionarAgendaHoy({oportunidades,tareas,mensajes});

    const pd=[];
    const condD=filtro(usuario,'COALESCE(cv.vendedor_id,p.demo_responsable,p.creado_por)',pd);
    const {rows:demos}=await pool.query(`
      SELECT p.id,p.contacto,p.nombre_negocio,p.demo_fecha,p.chatwoot_conversation_id,
        to_char(p.demo_fecha, 'YYYY-MM-DD"T"HH24:MI:SS') AS demo_fecha_local
      FROM prospectos p LEFT JOIN control_ventas cv ON cv.chatwoot_conversation_id=p.chatwoot_conversation_id
      WHERE p.estado='demo_coordinada' AND p.demo_fecha IS NOT NULL AND ${condD}
      ORDER BY p.demo_fecha ASC LIMIT 50`,pd);

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
          <div class="crm-panel-title"><h2><i class="ti ti-calendar-time"></i> Agenda de seguimientos de hoy</h2>
            <div class="crm-panel-title-actions"><span class="crm-count">${agendaHoy.total}</span>
              <a class="btn btn-secondary" href="/panel">Ver todos</a></div></div>
          <p class="crm-help">Todos los seguimientos abiertos, incluidos los recordatorios programados y vencidos. Sin límite de casos. Los mensajes sin responder también requieren atención.</p>
          ${agendaHoy.visibles.length?agendaHoy.visibles.map(t=>filaSeguimiento(t,usuario)).join(''):'<div class="crm-empty">No hay seguimientos pendientes.</div>'}
        </section>
        <section class="crm-panel" id="agenda-demos">
          <div class="crm-panel-title"><h2><i class="ti ti-calendar-event"></i> Agenda de demos</h2><span class="crm-count">${demos.length}</span></div>
          ${demos.length?demos.map(p=>{
            const paso=pasoPorEstado('demo_coordinada',p.demo_fecha_local);
            const vencida=paso.demoVencida === true;
            const nombre=esc(p.nombre_negocio||p.contacto||`Prospecto #${p.id}`);
            return `<article class="crm-mini-item ${vencida?'crm-late':''}">
              <div class="crm-item-main"><div class="crm-item-top"><span class="${vencida?'crm-high':'crm-normal'}">${vencida?'Prioridad alta · Demo vencida':'Prioridad normal'}</span></div>
                <strong>${nombre}</strong><div class="crm-followup-detail">Próxima acción: ${esc(paso.accion)}</div>
                <div class="crm-meta">Demo: ${esc(fechaDemo(p.demo_fecha))}</div>
              </div>
              <div class="crm-actions"><a class="btn btn-secondary" href="/prospectos/${Number(p.id)}">Ir a ficha</a>
                ${vencida ? `<a class="btn btn-primary" href="/prospectos/${Number(p.id)}/relevamiento">Cargar relevamiento</a>` : ''}
                ${chatUrl(p.chatwoot_conversation_id)?`<a class="btn btn-secondary" target="_blank" rel="noopener noreferrer" href="${esc(chatUrl(p.chatwoot_conversation_id))}">Contactar vía Chatwoot</a>`:''}
              </div></article>`;
          }).join(''):'<div class="crm-empty">Sin demos coordinadas.</div>'}
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
