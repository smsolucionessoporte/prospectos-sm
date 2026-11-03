'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
function obtenerHandlers(crearReunionMeet){
 const postHandlers=new Map();
 const router={get:()=>{},post:(p,...a)=>postHandlers.set(p,a)};
 const express={Router:()=>router,json:()=>()=>{},urlencoded:()=>()=>{}};
 const prospecto={id:25,estado:'prospecto',contacto:'Cliente de prueba',telefono:'5491112345678',chatwoot_conversation_id:4321};
 const queries=[];
 const sqlReply=async(sql,values=[])=>{
  queries.push({sql:String(sql),values});
  if(String(sql).startsWith('SELECT * FROM prospectos'))return {rows:[{...prospecto}]};
  if(String(sql).includes('SELECT email FROM usuarios'))return {rows:[{email:'rafael@gmail.com'}]};
  return {rows:[],rowCount:1};
 };
 const fakePool={query:sqlReply,connect:async()=>({query:sqlReply,release:()=>{}})};
 let callCount=0;
 const stubs={
  express,
  '../db':{pool:fakePool},
  '../middleware/auth':{requireAuth:()=>{},layout:(_title,body)=>body},
  '../zoomChatwoot':{enviarMensajePorConversationId:async()=>true,enviarPorChatwoot:async()=>true,enviarAvisoInterno:async()=>true},
  '../zoomAgentes':{AGENTE_TELEFONO:{}},
  '../crm/seguimientos':{vendedorAsignado:async()=>8,puedeGestionar:async()=>true},
  './calendar':{
   MEET_GRUPAL:{am:{hora:'10:30'},pm:{hora:'15:30'}},checkSlot:()=>{},
   parseLocal:(v)=>({date:v.slice(0,10),time:v.slice(11),utc:new Date(v+':00-03:00')}),
   crearReunionMeet:async args=>{callCount++;return crearReunionMeet(args,callCount);},
   cancelarReunionMeet:async()=>{}
  },
  './booking-token':{issue:()=>'',verify:()=>0},
  './destinatarios':{destinatariosDemo:(_id,message)=>[{destino:'vendedor',destinatario:8,telefono:null,conversacion:null,mensaje:message}]},
 };
 const filename=path.join(__dirname,'routes.js');
 const mod=new Module(filename,module);mod.filename=filename;mod.paths=module.paths;
 mod.require=name=>Object.hasOwn(stubs,name)?stubs[name]:require(name);
 mod._compile(fs.readFileSync(filename,'utf8'),filename);
 const handlers=postHandlers.get('/prospectos/:id/demo');
 const fecha=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+7*86400000));
 const session={usuario:{id:2}};
 return {
  fecha,queries,session, getCount:()=>callCount,
  async post(meet_accion){
   const req={params:{id:'25'},body:{tipo:'personalizada',fecha,hora:'11:00',...(meet_accion?{meet_accion}:{})},session};
   const response={status:200,body:''};
   const res={status(n){response.status=n;return this;},send(v){response.body=v;return this;},redirect(v){response.redirect=v;return this;}};
   await handlers.at(-1)(req,res);
   return response;
  }
 };
}
test('cuando Meet falla ofrece Reintentar / Continuar y no registra ni envía antes de decidir',async()=>{
 const fixture=obtenerHandlers(async()=>{throw new Error('Google no respondió (HTTP 503)');});
 const r=await fixture.post();
 assert.equal(r.status,200);
 assert.match(r.body,/Volver a intentar crear Meet/);
 assert.match(r.body,/Continuar sin enlace/);
 assert.match(r.body,/Google no respondió/);
 assert.equal(fixture.queries.some(x=>x.sql.includes("estado='demo_coordinada'")),false);
 assert.equal(fixture.queries.some(x=>x.sql.includes('INSERT INTO meet_avisos')),false);
 assert.equal(fixture.getCount(),1);
});
test('si elige Continuar no vuelve a llamar a Google y guarda demo con WhatsApp sin enlace',async()=>{
 const fixture=obtenerHandlers(async()=>{throw new Error('Meet no disponible');});
 await fixture.post();
 const r=await fixture.post('continuar');
 assert.equal(fixture.getCount(),1);
 assert.match(r.body,/demostración quedó registrada/);
 const update=fixture.queries.find(x=>x.sql.includes("estado='demo_coordinada'"));
 assert.ok(update);
 assert.equal(update.values[3],null);
 const avisos=fixture.queries.filter(x=>x.sql.includes('INSERT INTO meet_avisos'));
 assert.ok(avisos.some(x=>x.values[2]==='cliente' && x.values[6].includes('Te enviaremos el enlace') && !x.values[6].includes('🔗 Google Meet:')));
 assert.ok(avisos.some(x=>x.values[2]==='vendedor' && x.values[6].includes('CREACIÓN MANUAL')));
});
test('reintentar tras error crea Meet, usa el enlace y no duplica mensajes',async()=>{
 const fixture=obtenerHandlers(async(_args,attempt)=>{
  if(attempt===1)throw new Error('falló la primera vez');
  return {joinUrl:'https://meet.google.com/abc-defg-hij',eventId:'event123',recordingEnabled:false,recordingWarning:'No compatible'};
 });
 await fixture.post();
 const r=await fixture.post('reintentar');
 assert.equal(fixture.getCount(),2);
 assert.match(r.body,/Reunión de Google Meet creada/);
 assert.match(r.body,/No se pudo activar la grabación automática/);
 const avisos=fixture.queries.filter(x=>x.sql.includes('INSERT INTO meet_avisos'));
 assert.equal(avisos.filter(x=>x.values[2]==='cliente').length,1);
 assert.ok(avisos.find(x=>x.values[2]==='cliente').values[6].includes('https://meet.google.com/abc-defg-hij'));
 assert.ok(!avisos.find(x=>x.values[2]==='cliente').values[6].includes('La reunión se grabará'));
});
test('continuar sin haber intentado crear Meet queda bloqueado',async()=>{
 const fixture=obtenerHandlers(async()=>{throw new Error('No');});
 const r=await fixture.post('continuar');
 assert.equal(r.status,409);
 assert.equal(fixture.getCount(),0);
});


test('envía el correo del vendedor asignado al crear el Meet personalizado',async()=>{
 let value=null;
 const fixture=obtenerHandlers(async(args)=>{value=args;return {joinUrl:'https://meet.google.com/abc-defg-hij',eventId:'evt1',recordingEnabled:true,cohostEnabled:true};});
 await fixture.post();
 assert.equal(value.vendedorEmail,'rafael@gmail.com');
 assert.match(value.idempotencyKey,/sm-prospectos:25:/);
});
