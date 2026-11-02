'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluarConversacion } = require('./actividad');

const ahora = Date.parse('2026-11-02T14:30:00Z');
const entrada = { id: 1, message_type: 0, private: false, content: 'Yuaraima', created_at: Date.parse('2026-10-30T21:37:00Z') / 1000 };
const salidaBot = { id: 2, message_type: 1, private: false, sender: {id: 22, type: 'agent_bot'}, created_at: Date.parse('2026-10-30T21:37:10Z') / 1000 };
const salidaVendedor = { id: 3, message_type: 1, private: false, sender: {id: 11, type: 'user'}, created_at: Date.parse('2026-11-02T14:00:00Z') / 1000 };

test('derivación del bot no cuenta como respuesta humana', () => {
 const evaluado = evaluarConversacion({messages:[entrada,salidaBot]}, {ahora});
 assert.equal(evaluado.ultimoEsDelCliente, false);
 assert.equal(evaluado.requiereRespuesta, true);
 assert.equal(evaluado.ultimoMensajeId, '1');
});

test('respuesta pública posterior de vendedor cancela atención pendiente', () => {
 const evaluado = evaluarConversacion({messages:[entrada,salidaBot,salidaVendedor]}, {ahora});
 assert.equal(evaluado.requiereRespuesta,false);
});

test('nuevo mensaje del cliente después de atención humana vuelve a requerir respuesta', () => {
 const nueva = { ...entrada, id: 4, created_at: Date.parse('2026-11-02T14:20:00Z') / 1000 };
 const evaluado = evaluarConversacion({messages:[entrada,salidaBot,salidaVendedor,nueva]}, {ahora});
 assert.equal(evaluado.requiereRespuesta,true);
 assert.equal(evaluado.ultimoMensajeId,'4');
});

test('sin mensaje de cliente no genera falsa atención', () => {
 assert.equal(evaluarConversacion({messages:[salidaBot]}, {ahora}).requiereRespuesta,false);
});
