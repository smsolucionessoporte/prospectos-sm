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
router.get('/prospectos/:id/demo',requireAuth,async(req,res)=>{
 const {rows}=await pool.query('SELECT * FROM prospectos WHERE id=$1',[req.params.id]);const p=rows[0];if(!p)return res.status(404).send('Prospecto no encontrado');
 if(!await puedeGestionar(p,req.session.usuario))return res.status(403).send('Sin permisos sobre este prospecto');
 if(!['prospecto','sin_respuesta'].includes(p.estado))return res.status(409).send('Este prospecto ya no está pendiente de coordinar demo');
 const content=`<a href="/prospectos/${p.id}">Volver a la ficha</a><h1>Coordinar demostración con Google Meet</h1><p>Prospecto: ${esc(p.contacto||p.nombre_negocio)}. Las demostraciones grupales usan los enlaces fijos de SM Soluciones.</p><form method="post" action="/prospectos/${p.id}/demo"><label>Tipo de reunión<select name="tipo" required><option value="am">Grupal AM · 10:30 a 11:00</option><option value="pm">Grupal PM · 15:30 a 16:00</option><option value="personalizada">Personalizada · crear Google Meet</option></select></label><label>Fecha<input name="fecha" type="date" required></label><label>Hora personalizada (solo si elegís personalizada)<input name="hora" type="time" value="11:00"></label><p class="muted">Para crear Meet personalizado es necesario conectar Google Calendar con permisos de grabación. No se confirma la demo si Google rechaza crearla.</p><button type="submit">Registrar y enviar confirmación</button></form>`;
 return res.send(layout('Coordinar demo en Meet',content,req));
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
