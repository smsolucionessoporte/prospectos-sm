'use strict';
const express = require('express');
const {pool}=require('../db');
const {requireAuth,layout}=require('../middleware/auth');
const {enviarMensajePorConversationId,enviarPorChatwoot,enviarAvisoInterno}=require('../zoomChatwoot');
const {AGENTE_TELEFONO}=require('../zoomAgentes');
const {vendedorAsignado,puedeGestionar}=require('../crm/seguimientos');
const {MEET_GRUPAL,checkSlot,parseLocal,crearReunionMeet,cancelarReunionMeet}=require('./calendar');
const {issue,verify}=require('./booking-token');
const {destinatariosDemo}=require('./destinatarios');
const router=express.Router();
const esc=x=>String(x??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const SITE=()=>String(process.env.PUBLIC_BASE_URL||'https://prospectos-sm-production.up.railway.app').replace(/\/$/,'');
function mensajeDemo(p,fecha,link,custom){return `¡Tu demostración de SM Soluciones está coordinada! 🎥\n\n📅 ${new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',weekday:'long',day:'2-digit',month:'long',hour:'2-digit',minute:'2-digit'}).format(new Date(fecha))} (hora de Buenos Aires)\n⏱️ Duración: 30 minutos\n🔗 Google Meet: ${link}\n\n${custom?'Demostración personalizada.':'Es una demostración grupal; podrán participar otros comercios.'}\nTe recomendamos ingresar desde una computadora y conectarte a horario. La reunión se grabará para uso interno.`;}
async function iniciarMeet(){
 await pool.query(`ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS demo_tipo TEXT;
   ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS google_event_id TEXT;
   ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS demo_solicitud TEXT;
   CREATE TABLE IF NOT EXISTS meet_avisos (
     id BIGSERIAL PRIMARY KEY,
     prospecto_id INTEGER NOT NULL REFERENCES prospectos(id) ON DELETE CASCADE,
     clave TEXT NOT NULL,
     destino TEXT NOT NULL,
     destinatario INTEGER,
     telefono TEXT,
     conversacion BIGINT,
     mensaje TEXT NOT NULL,
     estado TEXT NOT NULL DEFAULT 'pendiente',
     intentos INTEGER NOT NULL DEFAULT 0,
     proximo_intento TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(prospecto_id,clave,destino)
   )`);
}
async function guardarAvisos(client,p,clave,mensajeCliente,mensajeInterno){
 const seller=await vendedorAsignado(p);
 const id=Number(p.id), cid=p.chatwoot_conversation_id;
 const destinos=[
   ...(cid||p.telefono?[{destino:'cliente',destinatario:null,telefono:p.telefono,conversacion:cid,mensaje:mensajeCliente}]:[]),
   ...destinatariosDemo(seller, mensajeInterno, {
     6: process.env.DEMO_TELEFONO_MARISOL || AGENTE_TELEFONO[6],
     10: process.env.DEMO_TELEFONO_ROMAN || AGENTE_TELEFONO[10],
   })
 ];
 for(const n of destinos){
  if(!n.mensaje) continue;
  await client.query(`INSERT INTO meet_avisos(prospecto_id,clave,destino,destinatario,telefono,conversacion,mensaje)
  VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(prospecto_id,clave,destino) DO NOTHING`,
  [id,clave,n.destino,n.destinatario,n.telefono,n.conversacion,n.mensaje]);
 }
}
let avisosEnCurso=false;
async function procesarAvisos(){
 if(avisosEnCurso)return;avisosEnCurso=true;
 try{
  // Claim atómico por aviso: evita doble envío entre dos réplicas en Railway.
  const {rows}=await pool.query(`UPDATE meet_avisos SET estado='procesando',intentos=intentos+1,
    proximo_intento=NOW()+interval '5 minutes',actualizado_en=NOW()
   WHERE id IN (SELECT id FROM meet_avisos WHERE estado IN ('pendiente','reintentar','procesando') AND proximo_intento<=NOW()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 15) RETURNING *`);
  for(const n of rows){
   try{
    let ok=false;
    if(n.destino==='cliente'){
      if(n.conversacion){await enviarMensajePorConversationId(n.conversacion,n.mensaje);ok=true;}
      else if(n.telefono)ok=await enviarPorChatwoot(n.telefono,n.mensaje,6);
    }else if(n.destino==='vendedor')ok=await enviarAvisoInterno(n.mensaje,n.destinatario);
    else if(n.telefono)ok=await enviarPorChatwoot(n.telefono,n.mensaje,n.destinatario);
    if(!ok)throw new Error('Chatwoot no confirmó el envío');
    await pool.query("UPDATE meet_avisos SET estado='enviado',actualizado_en=NOW() WHERE id=$1",[n.id]);
   }catch(e){
    console.error('[MEET] Aviso no entregado',n.id,n.destino,e.message);
    await pool.query(`UPDATE meet_avisos SET estado=CASE WHEN intentos>=6 THEN 'fallido' ELSE 'reintentar' END,
      proximo_intento=NOW()+interval '10 minutes',actualizado_en=NOW() WHERE id=$1`,[n.id]);
   }
  }
 }catch(e){console.error('[MEET] Error de cola de avisos',e.message);}
 finally{avisosEnCurso=false;}
}
function iniciarAvisosMeet(){setInterval(()=>procesarAvisos().catch(console.error),60000).unref?.();procesarAvisos().catch(console.error);}
function estadoValido(p){return ['prospecto','sin_respuesta','demo_coordinada'].includes(p.estado);}
function fechaLocal(date){return `${date}T${MEET_GRUPAL.am.hora}`;}
function htmlReserva(token,contenido){return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SM Soluciones | Demostración</title><style>body{font:16px system-ui,sans-serif;background:#f4f6fb;color:#172139;margin:0;padding:24px}.card{max-width:550px;margin:38px auto;background:white;border:1px solid #dde3eb;border-radius:14px;padding:28px;box-shadow:0 7px 30px #1324420a}h1{font-size:24px}p{line-height:1.5}label{display:block;font-weight:600;margin:16px 0 6px}input,select,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #cbd5e1}button{background:#2162e9;color:white;border:0;cursor:pointer;margin-top:20px;font-weight:bold}.muted{color:#58667c;font-size:14px}.error{color:#ba1a1a}a{color:#215bd4}</style></head><body><main class="card"><small>SM SOLUCIONES</small><h1>Coordinar demostración</h1>${contenido}</main></body></html>`;}
router.post('/api/demos/booking-link',express.json(),(req,res)=>{
 if(!process.env.AUTOMATION_API_KEY||req.headers['x-api-key']!==process.env.AUTOMATION_API_KEY)return res.status(401).json({error:'No autorizado'});
 try{const t=issue(req.body?.chatwoot_conversation_id);return res.json({ok:true,url:`${SITE()}/demo/reservar?token=${encodeURIComponent(t)}`});}
 catch(error){return res.status(503).json({error:error.message});}
});
router.get('/demo/reservar',async(req,res)=>{
 let id;try{id=verify(req.query.token);}catch(e){return res.status(400).send(htmlReserva('',`<p class="error">${esc(e.message)}</p>`));}
 const {rows}=await pool.query('SELECT id,estado FROM prospectos WHERE chatwoot_conversation_id=$1 LIMIT 1',[id]);
 if(!rows.length)return res.status(409).send(htmlReserva('',`<p>Tu ficha todavía no está disponible. Escribinos en WhatsApp para que un asesor pueda coordinar la demostración.</p>`));
 if(!estadoValido(rows[0]))return res.status(409).send(htmlReserva('',`<p>Esta oportunidad ya está cerrada. Consultá con tu asesor.</p>`));
 if(rows[0].estado==='demo_coordinada')return res.status(409).send(htmlReserva('',`<p>Ya tenés una demostración coordinada. Para cambiarla, escribile a tu asesor comercial.</p>`));
 const options=[];
 const now=new Date();
 for(let i=0;i<15;i++){const d=new Date(now.getTime()+i*86400000),date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
   for(const slot of ['am','pm']){try{checkSlot(date,slot,now);options.push(`<option value="${date}|${slot}">${esc(new Intl.DateTimeFormat('es-AR',{timeZone:'UTC',weekday:'long',day:'numeric',month:'numeric'}).format(new Date(`${date}T12:00:00Z`)))} — ${MEET_GRUPAL[slot].hora}</option>`);}catch{}}
 }
 const content=`<p>Elegí un día y uno de nuestros dos turnos grupales de <strong>30 minutos</strong>. Pueden participar otros comercios.</p><form method="POST" action="/demo/reservar"><input type="hidden" name="token" value="${esc(req.query.token)}"><label for="turno">Fecha y horario (Buenos Aires)</label><select name="turno" id="turno" required>${options.join('')}</select><label><input type="radio" name="tipo" value="grupal" checked style="width:auto"> Reservar un turno grupal</label><label><input type="radio" name="tipo" value="personalizada" style="width:auto"> Necesito otro horario</label><p class="muted">Si necesitás otro horario, un asesor te contactará para coordinarlo; no se crea una reunión sin confirmación.</p><button type="submit">Confirmar elección</button></form>`;
 return res.send(htmlReserva(req.query.token,content));
});
router.post('/demo/reservar',express.urlencoded({extended:false}),async(req,res)=>{
 let cid;try{cid=verify(req.body.token);}catch(e){return res.status(400).send(htmlReserva('',`<p class="error">${esc(e.message)}</p>`));}
 const personal=req.body.tipo==='personalizada';let slot=null;
 if(!personal){const match=String(req.body.turno||'').match(/^(\d{4}-\d\d-\d\d)\|(am|pm)$/);
   if(!match)return res.status(400).send(htmlReserva('',`<p class="error">Turno inválido.</p>`));
   try{slot=checkSlot(match[1],match[2]);}catch(e){return res.status(400).send(htmlReserva('',`<p class="error">${esc(e.message)}</p>`));}}
 const client=await pool.connect();let p=null,success=false;
 try{
  await client.query('BEGIN');
  const {rows}=await client.query('SELECT * FROM prospectos WHERE chatwoot_conversation_id=$1 FOR UPDATE',[cid]);p=rows[0];
  if(!p||!estadoValido(p)) {await client.query('ROLLBACK');return res.status(409).send(htmlReserva('',`<p>La reserva no está disponible para esta conversación.</p>`));}
  if(p.estado==='demo_coordinada'){await client.query('ROLLBACK');return res.status(409).send(htmlReserva('',`<p>Ya tenés una demostración coordinada. Consultá a tu asesor.</p>`));}
  const seller=await vendedorAsignado(p);
  if(personal){
   if(p.demo_solicitud==='pendiente_personalizada') {await client.query('COMMIT');success=true;}
   else {
   await client.query("UPDATE prospectos SET demo_solicitud='pendiente_personalizada',actualizado_en=NOW() WHERE id=$1",[p.id]);
   await client.query('INSERT INTO historial_estados(prospecto_id,estado_anterior,estado_nuevo,nota) VALUES($1,$2,$2,$3)',[p.id,p.estado,'Solicitó otro horario de demostración desde enlace de reserva']);
   const m=`📅 *SOLICITUD DE DEMO PERSONALIZADA*\n👤 ${p.contacto||p.nombre_negocio||'Prospecto'}\n📞 ${p.telefono||'—'}\n👨‍💼 Vendedor asignado: ${seller||'Sin identificar'}\n🔗 ${SITE()}/prospectos/${p.id}\n\n📣 Coordiná con quien realizará la demostración.`;
   await guardarAvisos(client,p,`personalizada:pendiente`,null,m);
   }
  }else{
   const fecha=`${slot.date}T${slot.time}`;
   const result=await client.query(`UPDATE prospectos SET estado='demo_coordinada',demo_fecha=$2::timestamp,
     demo_tipo=$3,zoom_join_url=$4,demo_responsable=COALESCE(demo_responsable,6),demo_solicitud=NULL,
     recordatorio_enviado=false,recordatorio_relevamiento_enviado=false,actualizado_en=NOW() WHERE id=$1`,[p.id,fecha,`grupal_${slot.slot}`,slot.url]);
   await client.query('INSERT INTO historial_estados(prospecto_id,estado_anterior,estado_nuevo,nota) VALUES($1,$2,$3,$4)',[p.id,p.estado,'demo_coordinada',`Inscripción web: demostración grupal ${slot.slot.toUpperCase()} ${fecha} · Meet ${slot.url}`]);
   const text=mensajeDemo(p,slot.utc,slot.url,false);
   const m=`📅 *NUEVA INSCRIPCIÓN A DEMO GRUPAL*\n👤 ${p.contacto||p.nombre_negocio||'Prospecto'}\n📞 ${p.telefono||'—'}\n🗓️ ${fecha.replace('T',' ')} (Buenos Aires)\n🎥 ${slot.url}\n👨‍💼 Vendedor: ${seller||'Sin identificar'}\n🔗 ${SITE()}/prospectos/${p.id}\n\n📣 Coordiná con quien realizará la demostración.`;
   await guardarAvisos(client,p,`inscripcion:${fecha}`,text,m);
  }
  await client.query('COMMIT');success=true;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('[MEET] Error al reservar',e);return res.status(500).send(htmlReserva('',`<p class="error">No pudimos confirmar la solicitud. Probá de nuevo o escribile a tu asesor.</p>`));}
 finally{client.release();}
 if(success){setImmediate(()=>procesarAvisos().catch(console.error));return res.send(htmlReserva('',personal?'<p>✅ Recibimos tu solicitud. Un asesor te contactará para coordinar un horario personalizado.</p>':'<p>✅ Tu demostración grupal quedó registrada. Recibirás los datos por WhatsApp. Si no llegan, consultá con tu asesor.</p>'));}
});
// Vista interna de coordinación: estilos propios y aislados, sin alterar otras pantallas.
function vistaCoordinarDemo(p){
 const minFecha=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 return `
 <style>
 .meet-page{max-width:930px;margin:0 auto;padding:6px 0 36px;color:#17233c}
 .meet-page *{box-sizing:border-box}
 .meet-back{display:inline-flex;align-items:center;gap:6px;margin-bottom:22px;color:#52627a;font-size:13px;text-decoration:none}
 .meet-back:hover{color:#2563eb}
 .meet-eyebrow{display:flex;align-items:center;gap:7px;color:#2563eb;text-transform:uppercase;letter-spacing:.1em;font-size:11px;font-weight:750;margin-bottom:8px}
 .meet-heading{font-size:28px;line-height:1.18;font-weight:760;letter-spacing:-.035em;margin:0 0 8px;color:#16213b}
 .meet-description{font-size:14px;color:#65728a;line-height:1.6;margin:0 0 24px}
 .meet-card{background:#fff;border:1px solid #dfe5ee;border-radius:16px;box-shadow:0 8px 28px rgba(27,40,72,.045);overflow:hidden}
 .meet-section{padding:24px 28px;border-bottom:1px solid #e9edf4}
 .meet-section:last-child{border-bottom:none}
 .meet-section-title{display:flex;align-items:center;gap:11px;font-size:15px;font-weight:700;margin:0 0 17px;color:#16213b}
 .meet-number{display:inline-grid;place-items:center;width:26px;height:26px;background:#edf3ff;color:#2563eb;border-radius:8px;font-weight:800;font-size:12px}
 .meet-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
 .meet-tile{display:block;margin:0;cursor:pointer;background:#fff;border:1.5px solid #e0e6f0;border-radius:12px;padding:16px;position:relative;min-height:138px;transition:border-color .18s,background .18s,box-shadow .18s}
 .meet-tile:hover{border-color:#92b5f6}
 .meet-tile.selected,.meet-tile:has(input:checked){border-color:#2563eb;background:#f5f9ff;box-shadow:0 0 0 2px rgba(37,99,235,.09)}
 .meet-tile input{position:absolute;right:15px;top:17px;accent-color:#2563eb;width:16px;height:16px;margin:0}
 .meet-tile-icon{display:inline-grid;place-items:center;width:33px;height:33px;border-radius:9px;background:#f1f4f9;color:#526985;font-size:17px;margin-bottom:11px}
 .meet-tile.selected .meet-tile-icon,.meet-tile:has(input:checked) .meet-tile-icon{background:#e2edff;color:#2563eb}
 .meet-tile-name{display:block;color:#17233c;font-size:13px;font-weight:700;padding-right:12px;margin-bottom:4px}
 .meet-tile-sub{display:block;color:#6d798d;font-size:12px;line-height:1.4;font-weight:400}
 .meet-fields{display:grid;grid-template-columns:minmax(0,330px);gap:15px}
 .meet-fields.personalized{grid-template-columns:repeat(2,minmax(0,330px))}
 .meet-field-label{display:block;margin:0 0 7px;color:#394965;font-size:12px;font-weight:650}
 .meet-page input[type=date],.meet-page input[type=time]{display:block;width:100%;height:43px;border:1px solid #cfd8e6;border-radius:9px;background:white;color:#16213b;padding:0 12px;font-size:14px;font-family:inherit}
 .meet-page input:focus-visible{outline:3px solid rgba(37,99,235,.18);border-color:#2563eb}
 .meet-muted{font-size:12px;color:#718096;line-height:1.5;margin:9px 0 0}
 .meet-footer{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:20px 28px;background:#fcfdff}
 .meet-footer-note{display:flex;align-items:center;gap:8px;font-size:12px;color:#718096}
 .meet-footer-note i{font-size:17px;color:#64748b}
 .meet-button{display:inline-flex;align-items:center;justify-content:center;gap:9px;border:0;border-radius:9px;background:#2563eb;color:white;min-height:43px;padding:11px 19px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap}
 .meet-button:hover{background:#1d4ed8}
 .meet-button:disabled{opacity:.65;cursor:wait}
 .meet-error{display:none;margin-top:13px;border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;border-radius:9px;padding:10px 13px;font-size:12px}
 .meet-error.visible{display:block}
 .meet-hidden{display:none}
 @media(max-width:720px){.meet-heading{font-size:23px}.meet-choices{grid-template-columns:1fr}.meet-tile{min-height:unset;padding:14px 16px 14px 60px}.meet-tile-icon{position:absolute;left:14px;top:16px}.meet-tile-name{margin-top:3px}.meet-section{padding:19px 17px}.meet-fields,.meet-fields.personalized{grid-template-columns:1fr}.meet-footer{padding:17px;align-items:stretch;flex-direction:column}.meet-button{width:100%}.meet-footer-note{order:2}}
 </style>
 <div class="meet-page">
  <a class="meet-back" href="/prospectos/${p.id}"><i class="ti ti-arrow-left"></i> Volver a la ficha del prospecto</a>
  <div class="meet-eyebrow"><i class="ti ti-video"></i> SM COMERCIAL · DEMOSTRACIONES</div>
  <h1 class="meet-heading">Coordinar demostración</h1>
  <p class="meet-description">Seleccioná un turno de Google Meet para <strong>${esc(p.contacto||p.nombre_negocio||'el prospecto')}</strong>. La confirmación se enviará por WhatsApp y quedará registrada en la ficha.</p>
  <form id="meet-booking-form" class="meet-card" action="/prospectos/${p.id}/demo" method="post">
   <section class="meet-section">
    <h2 class="meet-section-title"><span class="meet-number">1</span> Elegí la modalidad</h2>
    <div class="meet-choices" role="radiogroup" aria-label="Modalidad de demostración">
     <label class="meet-tile selected" data-meet-tile>
      <input type="radio" name="tipo" value="am" checked>
      <span class="meet-tile-icon"><i class="ti ti-sun"></i></span>
      <span class="meet-tile-name">Turno mañana</span>
      <span class="meet-tile-sub">10:30 a 11:00 · Grupal</span>
     </label>
     <label class="meet-tile" data-meet-tile>
      <input type="radio" name="tipo" value="pm">
      <span class="meet-tile-icon"><i class="ti ti-sunset"></i></span>
      <span class="meet-tile-name">Turno tarde</span>
      <span class="meet-tile-sub">15:30 a 16:00 · Grupal</span>
     </label>
     <label class="meet-tile" data-meet-tile>
      <input type="radio" name="tipo" value="personalizada">
      <span class="meet-tile-icon"><i class="ti ti-calendar-time"></i></span>
      <span class="meet-tile-name">Otro horario</span>
      <span class="meet-tile-sub">Reunión individual · A coordinar</span>
     </label>
    </div>
   </section>
   <section class="meet-section">
    <h2 class="meet-section-title"><span class="meet-number">2</span> Seleccioná la fecha</h2>
    <div class="meet-fields" id="meet-fields">
     <div><label class="meet-field-label" for="meet-date">Fecha de la demostración</label>
      <input id="meet-date" name="fecha" type="date" min="${minFecha}" required>
      <p class="meet-muted" id="meet-date-note">Disponible de lunes a viernes, 10:30 o 15:30 según el turno elegido.</p>
     </div>
     <div id="meet-time-wrap" class="meet-hidden"><label class="meet-field-label" for="meet-time">Horario personalizado (Buenos Aires)</label>
      <input id="meet-time" name="hora" type="time" value="11:00" disabled>
      <p class="meet-muted">Duración máxima de 30 minutos.</p>
     </div>
    </div>
    <p class="meet-error" id="meet-error" role="alert"></p>
   </section>
   <div class="meet-footer">
    <span class="meet-footer-note"><i class="ti ti-shield-check"></i> Se registra en la ficha y se envía una única confirmación.</span>
    <button class="meet-button" id="meet-confirm" type="submit"><i class="ti ti-calendar-check"></i> Confirmar demostración</button>
   </div>
  </form>
 </div>
 <script>
 (()=>{
  const form=document.getElementById('meet-booking-form');
  const date=document.getElementById('meet-date');
  const time=document.getElementById('meet-time');
  const timeWrap=document.getElementById('meet-time-wrap');
  const note=document.getElementById('meet-date-note');
  const fields=document.getElementById('meet-fields');
  const error=document.getElementById('meet-error');
  const submit=document.getElementById('meet-confirm');
  const radios=[...form.querySelectorAll('input[name="tipo"]')];
  function currentType(){return radios.find(r=>r.checked)?.value||'am';}
  function refresh(){
   const type=currentType(),custom=type==='personalizada';
   form.querySelectorAll('[data-meet-tile]').forEach(tile=>tile.classList.toggle('selected',tile.querySelector('input').checked));
   timeWrap.classList.toggle('meet-hidden',!custom);fields.classList.toggle('personalized',custom);time.disabled=!custom;time.required=custom;
   note.textContent=custom?'Elegí la fecha acordada con el prospecto.':'Turnos grupales de lunes a viernes.';
   error.textContent='';error.classList.remove('visible');
  }
  radios.forEach(r=>r.addEventListener('change',refresh));refresh();
  form.addEventListener('submit',event=>{
   const type=currentType(),d=date.value;
   let problem='';
   if(!d)problem='Seleccioná una fecha.';
   else if(type!=='personalizada'){
    const weekday=new Date(d+'T12:00:00Z').getUTCDay();
    if(weekday===0||weekday===6)problem='Los turnos grupales están disponibles de lunes a viernes.';
    else {
     const start=new Date(d+'T'+(type==='am'?'10:30':'15:30')+':00-03:00');
     if(start.getTime()<Date.now()+15*60000)problem='Elegí un turno futuro con al menos 15 minutos de anticipación.';
    }
   }else if(time.value){
    const start=new Date(d+'T'+time.value+':00-03:00');
    if(start.getTime()<=Date.now())problem='Elegí una fecha y hora futuras.';
   }
   if(problem){event.preventDefault();error.textContent=problem;error.classList.add('visible');return;}
   submit.disabled=true;submit.innerHTML='<i class="ti ti-loader-2"></i> Registrando...';
  });
 })();
 </script>`;
}
router.get('/prospectos/:id/demo',requireAuth,async(req,res)=>{
 const {rows}=await pool.query('SELECT * FROM prospectos WHERE id=$1',[req.params.id]);const p=rows[0];if(!p)return res.status(404).send('Prospecto no encontrado');
 if(!await puedeGestionar(p,req.session.usuario))return res.status(403).send('Sin permisos sobre este prospecto');
 if(!['prospecto','sin_respuesta'].includes(p.estado))return res.status(409).send('Este prospecto ya no está pendiente de coordinar demo');
 return res.send(layout('Coordinar demo en Meet',vistaCoordinarDemo(p),req));
});
router.post('/prospectos/:id/demo',requireAuth,express.urlencoded({extended:false}),async(req,res)=>{
 const {rows}=await pool.query('SELECT * FROM prospectos WHERE id=$1',[req.params.id]);const p=rows[0];if(!p)return res.status(404).send('Prospecto no encontrado');
 if(!await puedeGestionar(p,req.session.usuario))return res.status(403).send('Sin permisos sobre este prospecto');
 if(!['prospecto','sin_respuesta'].includes(p.estado))return res.status(409).send('La etapa cambió, actualizá la ficha');
 const custom=req.body.tipo==='personalizada';const date=String(req.body.fecha||'');let slot=null;
 try{
  if(custom){const time=String(req.body.hora||'');const dt=parseLocal(`${date}T${time}`);if(dt.utc<=new Date())throw new Error('Elegí una fecha futura');slot={...dt,url:null,slot:'personalizada'};}
  else slot=checkSlot(date,req.body.tipo);
 }catch(e){return res.status(400).send(`Fecha inválida: ${esc(e.message)}`);}
 let meeting=null;
 if(custom){try{meeting=await crearReunionMeet({title:`SM Soluciones | Demostración personalizada`,localStart:`${date}T${slot.time}`,description:`Demo comercial SM. Prospecto interno #${p.id}`});}
   catch(e){return res.status(503).send(`No se creó la reunión: ${esc(e.message)}. No modificamos la ficha.`);}}
 const url=meeting?.joinUrl||slot.url,fecha=`${date}T${slot.time}`;
 const client=await pool.connect();
 try{
  await client.query('BEGIN');const {rows:actualRows}=await client.query('SELECT * FROM prospectos WHERE id=$1 FOR UPDATE',[p.id]);const actual=actualRows[0];
  if(!['prospecto','sin_respuesta'].includes(actual.estado))throw new Error('La etapa fue modificada por otra gestión');
  await client.query(`UPDATE prospectos SET estado='demo_coordinada',demo_fecha=$2::timestamp,demo_tipo=$3,
    zoom_join_url=$4,google_event_id=$5,demo_responsable=COALESCE(demo_responsable,6),demo_solicitud=NULL,recordatorio_enviado=false,
    recordatorio_relevamiento_enviado=false,actualizado_en=NOW() WHERE id=$1`,[p.id,fecha,custom?'personalizada':`grupal_${slot.slot}`,url,meeting?.eventId||null]);
  await client.query('INSERT INTO historial_estados(prospecto_id,estado_anterior,estado_nuevo,usuario_id,nota) VALUES($1,$2,$3,$4,$5)',[p.id,actual.estado,'demo_coordinada',req.session.usuario.id,`Demostración ${custom?'personalizada':'grupal'} en Google Meet · ${fecha} · ${url}`]);
  const seller=await vendedorAsignado(p),text=mensajeDemo(p,slot.utc,url,custom);
  const intern=`📅 *DEMO COORDINADA*\n👤 ${p.contacto||p.nombre_negocio||'Prospecto'}\n📞 ${p.telefono||'—'}\n🗓️ ${fecha.replace('T',' ')} Buenos Aires\n🎥 ${url}\n👨‍💼 Vendedor: ${seller||'Sin identificar'}\n🔗 ${SITE()}/prospectos/${p.id}\n\n📣 Coordiná con quien realizará la demostración.`;
  await guardarAvisos(client,p,`manual:${fecha}`,text,intern);
  await client.query('COMMIT');setImmediate(()=>procesarAvisos().catch(console.error));
  return res.redirect(`/prospectos/${p.id}`);
 }catch(e){await client.query('ROLLBACK').catch(()=>{});
    if(meeting?.eventId)await cancelarReunionMeet(meeting.eventId).catch(err=>console.error('[MEET] No pudo revertirse el evento',meeting.eventId,err.message));
    console.error('[MEET] No se pudo registrar reunión',e);return res.status(500).send('No se pudo completar la coordinación. Revisá la ficha y el evento de Google Calendar antes de reintentar.');}
 finally{client.release();}
});
module.exports={router,iniciarMeet,iniciarAvisosMeet,procesarAvisos,guardarAvisos};
