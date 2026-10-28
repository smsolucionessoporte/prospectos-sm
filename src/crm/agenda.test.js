'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seleccionarAgendaHoy } = require('./agenda');
const AHORA = new Date('2026-10-28T17:00:00.000Z').getTime();
const oportunidad = (id, name) => ({prospecto_id:id,chatwoot_conversation_id:id+3000,contacto:name,inbox_id:6});
const tarea = (id, opts={}) => ({id:id+700,prospecto_id:id,chatwoot_conversation_id:id+3000,descripcion:'Volver a llamar',
  vence_en:'2026-10-27T17:00:00.000Z',prioridad:'alta',recordatorio:false,...opts});
const agenda = args => seleccionarAgendaHoy({...args, ahora:AHORA});

test('Eleonora aparece en respuesta y en seguimientos cuando no tiene recordatorio', () => {
  const m={chatwoot_conversation_id:3053,prospecto_id:null,nombre_contacto:'Eleonora Schaab',
    ultima_entrada:'2026-10-28T15:00:00.000Z',inbox_id:6};
  const { total,visibles } = agenda({mensajes:[m]});
  assert.equal(total,1);
  assert.equal(visibles[0].contacto,'Eleonora Schaab');
  assert.equal(visibles[0].requiere_respuesta,true);
  assert.equal(visibles[0].recordatorio_vencido,false);
});

test('Recordatorio futuro permanece en la agenda y tiene prioridad sobre tareas automáticas',()=>{
  const p=oportunidad(5,'Caso 5');
  const pendientes=[tarea(5),tarea(5,{id:800,recordatorio:true,vence_en:'2026-10-29T15:00:00.000Z'})];
  const {total,visibles}=agenda({oportunidades:[p],tareas:pendientes,mensajes:[{...p,ultima_entrada:new Date()}]});
  assert.equal(total,1);
  assert.equal(visibles[0].tarea_id,800);
  assert.equal(visibles[0].recordatorio,true);
  assert.equal(visibles[0].recordatorio_vencido,false);
  assert.equal(visibles[0].requiere_respuesta,true);
});

test('Recordatorio vencido vuelve a aparecer mostrando fecha y prioridad',()=>{
  const p=oportunidad(6,'Caso 6');
  const {visibles}=agenda({oportunidades:[p],tareas:[tarea(6,{recordatorio:true})]});
  assert.equal(visibles.length,1);
  assert.equal(visibles[0].recordatorio,true);
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

test('Muestra todos los casos sin límite de ocho (nueve casos)',()=>{
  const oportunidades=Array.from({length:9},(_,i)=>oportunidad(i+1,`Contacto ${i+1}`));
  const {total,visibles}=agenda({oportunidades});
  assert.equal(total,9);
  assert.equal(visibles.length,9);
});

test('Relaciona la tarea automática creada antes de asociar un chat a una ficha',()=>{
  const p=oportunidad(13,'Eleonora');
  const automatico={...tarea(13),id:991,prospecto_id:null};
  const {visibles}=agenda({oportunidades:[p],tareas:[automatico],mensajes:[{...p,ultima_entrada:new Date()}]});
  assert.equal(visibles.length,1);
  assert.equal(visibles[0].prospecto_id,13);
  assert.equal(visibles[0].tarea_id,991);
});

test('Sin tarea previa, el próximo paso de prospecto es Coordinar demo',()=>{
  const {visibles}=agenda({oportunidades:[{...oportunidad(15,'Juan'),estado:'prospecto'}]});
  assert.equal(visibles[0].descripcion,'Coordinar demo');
  assert.equal(visibles[0].prioridad,'normal');
  assert.equal(visibles[0].vence_en,null);
});

test('Sin respuesta comercial, la próxima acción es Reintentar contacto',()=>{
  const {visibles}=agenda({oportunidades:[{...oportunidad(16,'Laura'),estado:'sin_respuesta'}]});
  assert.equal(visibles[0].descripcion,'Reintentar contacto');
});

test('Demo realizada con tarea automática de cierre conserva fecha y prioridad, pero dice Cerrar cliente',()=>{
  const {visibles}=agenda({oportunidades:[{...oportunidad(17,'Julio'),estado:'demo_realizada'}],tareas:[
    tarea(17,{origen:'demo',descripcion:'Contactar después de la demostración y definir próximo paso'})
  ]});
  assert.equal(visibles[0].descripcion,'Cerrar cliente');
  assert.equal(visibles[0].prioridad,'alta');
  assert.ok(visibles[0].vence_en);
});

test('El seguimiento específico del asesor prevalece sobre la acción genérica de la etapa',()=>{
  const {visibles}=agenda({oportunidades:[{...oportunidad(18,'Agustina'),estado:'demo_realizada'}],tareas:[
    tarea(18,{origen:'manual',descripcion:'Confirmar presupuesto con el cliente',recordatorio:true})
  ]});
  assert.equal(visibles[0].descripcion,'Confirmar presupuesto con el cliente');
});

test('El mensaje entrante sin respuesta mantiene el paso Responder al cliente',()=>{
  const p={...oportunidad(19,'Eleonora'),estado:'prospecto'};
  const {visibles}=agenda({oportunidades:[p],mensajes:[{...p,ultima_entrada:new Date()}],tareas:[
    tarea(19,{origen:'chatwoot',descripcion:'Responder el último mensaje del cliente'})
  ]});
  assert.equal(visibles[0].descripcion,'Responder el último mensaje del cliente');
  assert.equal(visibles[0].requiere_respuesta,true);
});
