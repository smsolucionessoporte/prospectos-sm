'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluarConversacion, sumarMinutosLaborales, requiereAviso } = require('./actividad');
const ts = v => Math.floor(new Date(v).getTime() / 1000);
const ahora = new Date('2026-10-28T16:00:00Z').getTime();
const cliente = (id, time) => ({id,message_type:0,created_at:ts(time),sender:{type:'contact',id:99},private:false});
const asesor = (id,time) => ({id,message_type:1,created_at:ts(time),sender:{type:'user',id:4},private:false});
const bot = (id,time) => ({id,message_type:1,created_at:ts(time),sender:{type:'agent_bot',id:17},private:false});

test('mensaje entrante reciente sin respuesta humana requiere atención aunque Chatwoot diga pending',()=>{
 const r=evaluarConversacion({status:'pending',messages:[asesor(1,'2026-10-27T16:00:00Z'),cliente(2,'2026-10-28T14:00:00Z')]},{ahora});
 assert.equal(r.requiereRespuesta,true);assert.equal(r.ultimoMensajeId,'2');
});
test('la respuesta humana posterior cancela la espera',()=>{
 const r=evaluarConversacion({messages:[cliente(1,'2026-10-28T14:00:00Z'),asesor(2,'2026-10-28T15:00:00Z')]},{ahora});
 assert.equal(r.requiereRespuesta,false);
});
test('si el último mensaje público lo envió el bot, no figura como esperando respuesta',()=>{
 const r=evaluarConversacion({messages:[cliente(1,'2026-10-28T14:00:00Z'),bot(2,'2026-10-28T15:00:00Z')]},{ahora});
 assert.equal(r.requiereRespuesta,false);
});
test('mensaje viejo queda fuera de las urgencias',()=>{
 const r=evaluarConversacion({messages:[cliente(1,'2026-09-05T12:00:00Z')]},{ahora});
 assert.equal(r.requiereRespuesta,false);
});
test('mensajes internos y mensajes de actividad no disparan tareas',()=>{
 const r=evaluarConversacion({messages:[{...cliente(1,'2026-10-28T14:00:00Z'),private:true}, {id:2,message_type:2,created_at:ts('2026-10-28T15:00:00Z')}]},{ahora});
 assert.equal(r.requiereRespuesta,false);
});
test('vencimiento de 1 hora laboral desde martes 16:56 pasa al miércoles 9:56',()=>{
 const d=sumarMinutosLaborales(new Date('2026-10-27T19:56:00Z'),60);
 assert.equal(d.toISOString(),'2026-10-28T12:56:00.000Z');
});
test('la hora laboral no se consume durante el fin de semana',()=>{
 const d=sumarMinutosLaborales(new Date('2026-10-30T19:30:00Z'),60);
 assert.equal(d.toISOString(),'2026-11-02T12:30:00.000Z');
});

test('el último mensaje saliente, aunque provenga de un token técnico, no es un mensaje del cliente',()=>{
 const r=evaluarConversacion({messages:[cliente(1,'2026-10-28T14:00:00Z'),{id:2,message_type:1,created_at:ts('2026-10-28T15:00:00Z'),sender:{type:'user',id:2}}]},{ahora});
 assert.equal(r.requiereRespuesta,false);
});

test('descartar ignora solo el último mensaje del cliente',()=>{
 const previo=evaluarConversacion({messages:[cliente(22,'2026-10-28T14:00:00Z')]},{ahora});
 assert.equal(requiereAviso(previo, '22'),false);
 assert.equal(requiereAviso(previo, null),true);
 const nuevo=evaluarConversacion({messages:[cliente(22,'2026-10-28T14:00:00Z'),cliente(23,'2026-10-28T15:00:00Z')]},{ahora});
 assert.equal(requiereAviso(nuevo, '22'),true);
});
test('el mensaje entrante vuelve a mostrarse cuando es el último del chat',()=>{
 const r=evaluarConversacion({messages:[bot(11,'2026-10-28T13:00:00Z'),cliente(12,'2026-10-28T15:00:00Z')]},{ahora});
 assert.equal(r.requiereRespuesta,true);
 assert.equal(r.ultimoEsDelCliente,true);
});
