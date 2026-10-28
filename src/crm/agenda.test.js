'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seleccionarAgendaHoy } = require('./agenda');
const AHORA = new Date('2026-10-28T17:00:00.000Z').getTime();
const oportunidad = (id, name) => ({prospecto_id:id,chatwoot_conversation_id:id+3000,contacto:name,inbox_id:6});
const tarea = (id, opts={}) => ({id:id+700,prospecto_id:id,chatwoot_conversation_id:id+3000,descripcion:'Volver a llamar',
  vence_en:'2026-10-27T17:00:00.000Z',prioridad:'alta',recordatorio:false,...opts});
const agenda = args => seleccionarAgendaHoy({...args, ahora:AHORA, maximo:20});

test('Eleonora aparece en respuesta y en seguimientos cuando no tiene recordatorio', () => {
  const m={chatwoot_conversation_id:3053,prospecto_id:null,nombre_contacto:'Eleonora Schaab',
    ultima_entrada:'2026-10-28T15:00:00.000Z',inbox_id:6};
  const { total,visibles } = agenda({mensajes:[m]});
  assert.equal(total,1);
  assert.equal(visibles[0].contacto,'Eleonora Schaab');
  assert.equal(visibles[0].requiere_respuesta,true);
  assert.equal(visibles[0].recordatorio_vencido,false);
});

test('Recordatorio futuro oculta el caso aun si hay tarea automática sin recordatorio',()=>{
  const p=oportunidad(5,'Caso 5');
  const pendientes=[tarea(5),tarea(5,{id:800,recordatorio:true,vence_en:'2026-10-29T15:00:00.000Z'})];
  assert.equal(agenda({oportunidades:[p],tareas:pendientes,mensajes:[{...p,ultima_entrada:new Date()}]}).total,0);
});

test('Recordatorio vencido vuelve a aparecer mostrando fecha y prioridad',()=>{
  const p=oportunidad(6,'Caso 6');
  const {visibles}=agenda({oportunidades:[p],tareas:[tarea(6,{recordatorio:true})]});
  assert.equal(visibles.length,1);
  assert.equal(visibles[0].recordatorio_vencido,true);
  assert.equal(visibles[0].vence_en,'2026-10-27T17:00:00.000Z');
  assert.equal(visibles[0].prioridad,'alta');
});

test('Una oportunidad activa sin ninguna tarea aparece como Sin recordatorio',()=>{
  const p=oportunidad(7,'Caso sin seguimiento');
  const {visibles}=agenda({oportunidades:[p]});
  assert.equal(visibles.length,1);
  assert.equal(visibles[0].vence_en,null);
  assert.equal(visibles[0].recordatorio_vencido,false);
});

test('No duplica un prospecto que tiene tarea y mensaje sin responder',()=>{
  const p=oportunidad(9,'Caso duplicado');
  const {visibles}=agenda({oportunidades:[p],tareas:[tarea(9)],mensajes:[{...p,ultima_entrada:new Date()}]});
  assert.equal(visibles.length,1);
  assert.equal(visibles[0].requiere_respuesta,true);
});

test('Recorta la agenda visual pero informa el total para Ver todos',()=>{
  const {total,visibles}=seleccionarAgendaHoy({oportunidades:[oportunidad(1,'A'),oportunidad(2,'B'),oportunidad(3,'C')],ahora:AHORA,maximo:2});
  assert.equal(total,3);
  assert.equal(visibles.length,2);
});

test('Relaciona la tarea automática creada antes de asociar un chat a una ficha',()=>{
  const p=oportunidad(13,'Eleonora');
  const automatico={...tarea(13),id:991,prospecto_id:null};
  const {visibles}=agenda({oportunidades:[p],tareas:[automatico],mensajes:[{...p,ultima_entrada:new Date()}]});
  assert.equal(visibles.length,1);
  assert.equal(visibles[0].prospecto_id,13);
  assert.equal(visibles[0].tarea_id,991);
});
