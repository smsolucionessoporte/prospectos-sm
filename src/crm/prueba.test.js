'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {pool}=require('../db');
const {estadoPrueba,construirMensaje,activarPrueba}=require('./prueba');
const v0 = new Date('2026-10-29T14:00:00Z');
const v7 = new Date('2026-11-05T14:00:00Z');

test('Prueba vigente y vencida según vencimiento; no cambia por sí sola de estado',()=>{
 assert.equal(estadoPrueba('prueba',v7,v0.getTime()),'Prueba vigente');
 assert.equal(estadoPrueba('prueba',v7,v7.getTime()),'Prueba vencida');
 assert.equal(estadoPrueba('confirmado',v7,v7.getTime()),null);
});
test('Mensajes iniciales: cliente y vendedor reciben 7 días, fecha y datos de contacto',()=>{
 const p={id:82,contacto:'Juan',nombre_negocio:'Dietética',telefono:'+5491130000000',prueba_inicio:v0,prueba_vence:v7};
 const cliente=construirMensaje('activacion_cliente',p);
 const vendedor=construirMensaje('activacion_responsable',p);
 assert.match(cliente,/7 días corridos/);
 assert.match(cliente,/05\/11\/2026/);
 assert.match(cliente,/2287-3021/);
 assert.match(vendedor,/Dietética/);
 assert.match(vendedor,/05\/11\/2026/);
 assert.match(vendedor,/prospectos\/82/);
});
test('Mensajes al vencimiento son distintos para cliente y responsable',()=>{
 const p={id:91,contacto:'Luz',prueba_inicio:v0,prueba_vence:v7};
 assert.match(construirMensaje('vencimiento_cliente',p),/se cumple el plazo de 7 días/);
 assert.match(construirMensaje('vencimiento_responsable',p),/Prueba vencida/);
});
test('Activa solo después de la demo, con transacción, tarea y avisos únicos',async()=>{
 const orig=pool.connect;const calls=[];
 pool.connect=async()=>({query:async(sql,args=[])=>{
  calls.push([sql,args]);
  if(sql.includes('SELECT id,estado,prueba_inicio'))return {rows:[{id:82,estado:'demo_realizada',prueba_inicio:null}]};
  if(sql.includes("UPDATE prospectos SET estado='prueba'"))return {rows:[{prueba_inicio:v0,prueba_vence:v7}]};
  return {rows:[],rowCount:1};
 },release(){}});
 try {
  const out=await activarPrueba({prospectoId:82,usuarioId:8,responsableId:8});
  assert.equal(out.ok,true);
  assert.equal(calls[0][0],'BEGIN');
  assert.equal(calls.at(-1)[0],'COMMIT');
  assert.ok(calls.some(([sql])=>sql.includes("INTERVAL '7 days'")));
  assert.ok(calls.some(([sql])=>sql.includes('INSERT INTO historial_estados')));
  assert.ok(calls.some(([sql])=>sql.includes('INSERT INTO crm_tareas')));
  const aviso=calls.find(([sql])=>sql.includes('INSERT INTO crm_prueba_avisos'));
  assert.match(aviso[0],/activacion_cliente/);assert.match(aviso[0],/activacion_responsable/);
  assert.match(aviso[0],/vencimiento_cliente/);assert.match(aviso[0],/vencimiento_responsable/);
  assert.match(aviso[0],/ON CONFLICT/);
 }finally{pool.connect=orig;}
});
test('Impide segunda activación y no registra mensajes duplicados',async()=>{
 const orig=pool.connect;const calls=[];
 pool.connect=async()=>({query:async(sql)=>{
  calls.push(sql);
  if(sql.includes('SELECT id,estado,prueba_inicio'))return {rows:[{id:82,estado:'prueba',prueba_inicio:v0}]};
  return {rows:[]};
 },release(){}});
 try {
  const out=await activarPrueba({prospectoId:82,usuarioId:8,responsableId:8});
  assert.equal(out.ok,false);
  assert.equal(calls.at(-1),'ROLLBACK');
  assert.equal(calls.some(s=>s.includes('INSERT INTO crm_prueba_avisos')),false);
 }finally{pool.connect=orig;}
});
