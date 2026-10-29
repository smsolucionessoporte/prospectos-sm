'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Dobles de dependencias externas para probar rutas sin acceder a Railway/PostgreSQL.
const Module = require('node:module');
const cargarReal = Module._load;
function routerFalso() {
  const stack=[];
  const r={stack};
  for(const method of ['get','post']) r[method]=(path,...handlers)=>{
    stack.push({route:{path,methods:{[method]:true},stack:handlers.map(handle=>({handle}))}});
  };
  r.use=(child)=>stack.push({name:'router',handle:child});
  return r;
}
const fakePool={query:async()=>({rows:[]}),connect:async()=>({query:async()=>({rows:[]}),release(){}})};
Module._load=function(name,parent,isMain){
  if(name==='pg') return {Pool:class {constructor(){return fakePool;}}};
  if(name==='express') return {Router:routerFalso};
  if(name==='axios') return {get:async()=>{throw Error('No debe conectar a la red');}};
  return cargarReal.apply(this,arguments);
};
const { pool } = require('../db');
const crm = require('./routes');
const { renderSeguimientosFicha } = require('./seguimientos');
require('./sync');
Module._load=cargarReal;
const handler = (path, method) => crm.stack.find(l => l.route && l.route.path === path && l.route.methods[method]).route.stack.at(-1).handle;
const postDescartar = handler('/crm/conversaciones/:id/descartar','post');
const postSeguimiento = crm.stack.find(l => l.name === 'router').handle.stack.find(l=>l.route?.path === '/prospectos/:id/seguimientos').route.stack.at(-1).handle;
const getAgenda = handler('/crm','get');
const usuario = {id: 4,rol:'vendedor',nombre:'Rafael Altadonna'};
const mockRes = () => ({codigo:200,cuerpo:'',destino:'',status(v){this.codigo=v;return this;},send(v){this.cuerpo=v;return this;},redirect(v){this.destino=v;return this;}});
const backup = {query:pool.query,connect:pool.connect};
test.after(()=>{pool.query=backup.query;pool.connect=backup.connect;});

test('Descartar marca solo el mensaje verificado y cancela su tarea, sin llamar la API de Chatwoot',async()=>{
 const queries=[];
 const db={async query(sql,args){queries.push([sql,args]);return sql.includes('UPDATE crm_chatwoot_estado')?{rowCount:1,rows:[{chatwoot_conversation_id:3080}]}:{rowCount:1,rows:[]};},release(){}};
 pool.connect=async()=>db;
 const req={session:{usuario},params:{id:'3080'},body:{mensaje_id:'155042'}};
 const res=mockRes();await postDescartar(req,res);
 assert.equal(res.destino,'/crm?descartado=1#esperando-respuesta');
 assert.ok(queries.some(([s,a])=>s.includes('descartado_mensaje_id=$2') && a[1]==='155042' && a[3]===4));
 assert.ok(queries.some(([s,a])=>s.includes("estado='cancelada'") && a[0]==='respuesta:3080'));
 assert.ok(queries.some(([s])=>s==='COMMIT'));
});

test('Descartar desactualizado rechaza y no cancela tareas',async()=>{
 const queries=[];
 pool.connect=async()=>({async query(sql){queries.push(sql);return sql.includes('UPDATE crm_chatwoot_estado')?{rowCount:0}:{rowCount:1};},release(){}});
 const res=mockRes();await postDescartar({session:{usuario},params:{id:'3080'},body:{mensaje_id:'155042'}},res);
 assert.equal(res.codigo,409);
 assert.ok(queries.includes('ROLLBACK'));
 assert.equal(queries.some(s=>s.includes('UPDATE crm_tareas')),false);
});

test('Al registrar una gestión se conserva historial y se programa próxima acción de su dueño',async()=>{
 const writes=[];
 pool.query=async sql => sql.includes('FROM prospectos WHERE')
   ? {rows:[{id:186,estado:'demo_realizada',chatwoot_conversation_id:3053,creado_por:5,demo_responsable:5}]}
   : {rows:[{vendedor_id:4}]};
 pool.connect=async()=>({async query(sql,args){writes.push([sql,args]);return sql.includes('INSERT INTO crm_tareas')?{rows:[{id:802}],rowCount:1}:sql.includes('SELECT estado FROM prospectos')?{rows:[{estado:'demo_realizada'}],rowCount:1}:{rows:[],rowCount:1};},release(){}});
 const res=mockRes();await postSeguimiento({session:{usuario},params:{id:'186'},body:{
   gestion_realizada:'Llamé al cliente, revisará el plan',proxima_accion:'Volver a llamar',vence_en:'2026-11-02T11:00',
   prioridad:'alta'}},res);
 assert.equal(res.destino,'/prospectos/186?seguimiento=ok#seguimientos');
 assert.ok(writes.some(([s,a])=>s.includes('INSERT INTO crm_seguimientos')&&a[3].startsWith('Llamé')));
 assert.ok(writes.some(([s,a])=>s.includes('INSERT INTO crm_tareas')&&a[7]===true&&a[8]==='demo_realizada'));
 assert.ok(writes.some(([s,a])=>s.includes('INSERT INTO crm_seguimientos')&&a[7]===true));
});

test('La ficha muestra seguimientos y botón de guardar solo al vendedor asignado',async()=>{
 pool.query=async sql=>sql.includes('SELECT cv.vendedor_id')?{rows:[{vendedor_id:4}]}:{rows:[]};
 const p={id:186,estado:'demo_realizada',chatwoot_conversation_id:3053,creado_por:5,demo_responsable:5};
 const html=await renderSeguimientosFicha(p,usuario,0);
 assert.ok(html.includes('¿Qué se hizo?'));
 assert.match(html,/recordatorio/i);
 assert.equal(html.includes('name="recordatorio"'),false);
 assert.ok(html.includes('Guardar gestión y seguimiento'));
 const otro=await renderSeguimientosFicha(p,{...usuario,id:11,nombre:'Giuliano'},0);
 assert.equal(otro.includes('Guardar gestión y seguimiento'),false);
});

test('Agenda en una columna y sin tareas Hecha o Programar seguimiento',async()=>{
 process.env.CHATWOOT_URL='https://chatwoot.example.com';process.env.CHATWOOT_API_TOKEN='token-para-test';
 const now=new Date();
 pool.query=async sql=>{
   if (sql.includes('MAX(ultima_revision)')) return {rows:[{revisado:now}]};
   if (sql.includes('FROM crm_chatwoot_estado s')) return {rows:[{chatwoot_conversation_id:3080,ultimo_mensaje_id:'155042',ultima_entrada:now,inbox_id:6,nombre_contacto:'Diego Y'}]};
   return {rows:[],rowCount:0};
 };
 const res=mockRes();await getAgenda({session:{usuario},path:'/crm',query:{}},res);
 assert.equal(res.codigo,200);
 assert.ok(res.cuerpo.includes('crm-pila'));
 assert.ok(res.cuerpo.includes('Conversaciones esperando respuesta'));
 assert.ok(res.cuerpo.includes('Agenda de seguimientos de hoy'));
 assert.ok(res.cuerpo.includes('Ver todos'));
 assert.ok(res.cuerpo.includes('Sin recordatorio'));
 assert.equal(res.cuerpo.includes('Mostrando 8 de'),false);
 assert.equal(res.cuerpo.includes('Los que tienen recordatorio futuro aparecerán cuando venza'),false);
 assert.equal(res.cuerpo.includes('Oportunidades por cerrar'), false);
 assert.ok(res.cuerpo.includes('Descartar hasta próximo mensaje'));
 assert.equal(res.cuerpo.includes('Programar seguimiento'),false);
 assert.equal(res.cuerpo.includes('>Hecha'),false);
});

test('Agenda de demos propone Dar demo antes y Cargar relevamiento o reagendar después',async()=>{
  process.env.CHATWOOT_URL='https://chatwoot.example.com';process.env.CHATWOOT_API_TOKEN='token-para-test';
  const now=new Date();
  pool.query=async sql=>{
    if(sql.includes('MAX(ultima_revision)')) return {rows:[{revisado:now}]};
    if(sql.includes('SELECT p.id,p.contacto,p.nombre_negocio,p.demo_fecha,p.chatwoot_conversation_id')) {
      return {rows:[
        {id:401,contacto:'Demo futura',demo_fecha:new Date('2030-10-29T14:30:00Z'),demo_fecha_local:'2030-10-29T14:30:00',chatwoot_conversation_id:30401},
        {id:402,contacto:'Demo vencida',demo_fecha:new Date('2020-10-27T14:30:00Z'),demo_fecha_local:'2020-10-27T14:30:00',chatwoot_conversation_id:30402}
      ]};
    }
    return {rows:[],rowCount:0};
  };
  const res=mockRes();await getAgenda({session:{usuario},path:'/crm',query:{}},res);
  assert.equal(res.codigo,200);
  assert.ok(res.cuerpo.includes('Próxima acción: Dar demo'));
  assert.ok(res.cuerpo.includes('Próxima acción: Cargar relevamiento o reagendar'));
  assert.ok(res.cuerpo.includes('href="/prospectos/402/relevamiento"'));
  assert.ok(!res.cuerpo.includes('href="/prospectos/401/relevamiento"'));
});

test('Agenda comercial muestra Coordinar demo y Activar prueba o cerrar cliente según la etapa',async()=>{
  process.env.CHATWOOT_URL='https://chatwoot.example.com';process.env.CHATWOOT_API_TOKEN='token-para-test';
  const now=new Date();
  pool.query=async sql=>{
    if(sql.includes('MAX(ultima_revision)')) return {rows:[{revisado:now}]};
    if(sql.includes('SELECT p.id AS prospecto_id')) return {rows:[
      {prospecto_id:501,contacto:'En prospección',estado:'prospecto',chatwoot_conversation_id:3501},
      {prospecto_id:502,contacto:'Con demo realizada',estado:'demo_realizada',chatwoot_conversation_id:3502}
    ]};
    return {rows:[],rowCount:0};
  };
  const res=mockRes();await getAgenda({session:{usuario},path:'/crm',query:{}},res);
  assert.equal(res.codigo,200);
  assert.ok(res.cuerpo.includes('Coordinar demo'));
  assert.ok(res.cuerpo.includes('Activar prueba o cerrar cliente'));
  assert.ok(!res.cuerpo.includes('Registrar la próxima gestión comercial'));
});
