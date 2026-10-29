'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');

// Pruebas sin red, PostgreSQL ni Express instalado: se renderiza la ruta GET real.
function cargarRuta(){
  const getHandlers=new Map(),postHandlers=new Map();
  const router={get:(p,...handlers)=>getHandlers.set(p,handlers),post:(p,...handlers)=>postHandlers.set(p,handlers)};
  const express=()=>router;
  express.Router=()=>router;
  express.json=()=>()=>{};
  express.urlencoded=()=>()=>{};
  let prospecto={id:25,estado:'prospecto',contacto:'Carpe Diem',telefono:'5491112345678'};
  const stubs={
    express,
    '../db':{pool:{query:async()=>({rows:[prospecto]})}},
    '../middleware/auth':{requireAuth:()=>{},layout:(t,b)=>`<html><head><title>${t}</title></head><body>${b}</body></html>`},
    '../zoomChatwoot':{enviarMensajePorConversationId:()=>{},enviarPorChatwoot:()=>{},enviarAvisoInterno:()=>{}},
    '../zoomAgentes':{AGENTE_TELEFONO:{}},
    '../crm/seguimientos':{vendedorAsignado:async()=>8,puedeGestionar:async()=>true},
    './calendar':{MEET_GRUPAL:{am:{hora:'10:30'},pm:{hora:'15:30'}},checkSlot:()=>{},parseLocal:()=>{},crearReunionMeet:()=>{},cancelarReunionMeet:()=>{}},
    './booking-token':{issue:()=>'',verify:()=>0},
    './destinatarios':{destinatariosDemo:()=>[]},
  };
  const filename=path.join(__dirname,'routes.js');
  const mod=new Module(filename,module);mod.filename=filename;mod.paths=module.paths;
  mod.require=name=>stubs[name]||require(name);
  mod._compile(fs.readFileSync(filename,'utf8'),filename);
  async function render(p=prospecto){
    prospecto=p;
    let response={statusCode:200};
    const res={status(n){response.statusCode=n;return this;},send(html){response.html=html;return this;}};
    const handlers=getHandlers.get('/prospectos/:id/demo');
    assert.ok(handlers);
    await handlers[handlers.length-1]({params:{id:String(p.id)},session:{usuario:{id:12,rol:'vendedor'}}},res);
    return response;
  }
  return {render};
}
test('Coordinar demo muestra las tres modalidades y la misma ruta de registro',async()=>{
 const {render}=cargarRuta();const r=await render();
 assert.equal(r.statusCode,200);
 for(const text of ['Turno mañana','10:30 a 11:00','Turno tarde','15:30 a 16:00','Otro horario','Confirmar demostración'])assert.ok(r.html.includes(text),text);
 assert.match(r.html,/action="\/prospectos\/25\/demo" method="post"/);
 assert.match(r.html,/name="tipo" value="am" checked/);
 assert.match(r.html,/name="tipo" value="pm"/);
 assert.match(r.html,/name="tipo" value="personalizada"/);
 assert.match(r.html,/id="meet-time" name="hora" type="time" value="11:00" disabled/);
 assert.match(r.html,/name="fecha" type="date" min="\d{4}-\d\d-\d\d" required/);
});
test('La descripción escapa el nombre del prospecto y no ejecuta HTML',async()=>{
 const {render}=cargarRuta();const r=await render({id:49,estado:'prospecto',contacto:'<script>alert(1)</script>'});
 assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
 assert.ok(!r.html.includes('<strong><script>'));
});
test('El formulario valida días hábiles, 15 minutos y estado de botón',async()=>{
 const {render}=cargarRuta();const r=await render();
 assert.match(r.html,/weekday===0\|\|weekday===6/);
 assert.match(r.html,/Date\.now\(\)\+15\*60000/);
 assert.match(r.html,/submit\.disabled=true/);
 assert.match(r.html,/time\.disabled=!custom/);
});

test('Solo el turno personalizado solicita hora y no muestra indicaciones técnicas internas',async()=>{
 const {render}=cargarRuta(); const r=await render();
 assert.match(r.html,/id="meet-time-wrap" class="meet-hidden"/);
 assert.match(r.html,/id="meet-fields"/);
 assert.match(r.html,/fields\.classList\.toggle\('personalized',custom\)/);
 assert.match(r.html,/time\.disabled=!custom;time\.required=custom/);
 assert.ok(!r.html.includes('Para crear Meet personalizado es necesario conectar Google Calendar'));
 assert.ok(!r.html.includes('No se confirma la demo si Google rechaza'));
 assert.ok(!r.html.includes('verificará la grabación antes de confirmar'));
});
