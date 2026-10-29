'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { esContactoInterno, tieneAtributoInterno, esGrupoWhatsapp } = require('./internal-contact');
test('checkbox equipo_interno_sm activado excluye y desactivado no', () => {
  for (const x of [true,'true','TRUE',1,'1','sí']) assert.equal(esContactoInterno({equipo_interno_sm:x}),true);
  for (const x of [false,'false',0,null,undefined,'ventas;soporte']) assert.equal(esContactoInterno({equipo_interno_sm:x}),false);
  assert.equal(tieneAtributoInterno({equipo_interno_sm:false}),true);
});
test('conversaciones de grupos siguen excluidas', () => {
  assert.equal(esGrupoWhatsapp('120000@g.us'),true);
  assert.equal(esGrupoWhatsapp(null,'549112345678@s.whatsapp.net'),false);
});
