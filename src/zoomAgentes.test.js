const test = require('node:test');
const assert = require('node:assert/strict');
const { telefonoVendedor, AGENTE_CHATWOOT_ID } = require('./zoomAgentes');

test('los únicos destinatarios comerciales son los tres vendedores actuales', () => {
  assert.equal(AGENTE_CHATWOOT_ID[4], 8);
  assert.equal(AGENTE_CHATWOOT_ID[11], 12);
  assert.equal(AGENTE_CHATWOOT_ID[19], 13);
  assert.equal(telefonoVendedor(7), null); // Daniel ya no recibe derivaciones comerciales.
  assert.equal(telefonoVendedor(6), null); // Las alertas comerciales no se mandan a admins.
  assert.ok(telefonoVendedor(8));
  assert.ok(telefonoVendedor(12));
});

test('Santiago requiere un teléfono configurado; sin teléfono no hay destinatario alternativo', () => {
  const previo = process.env.VENTAS_TELEFONO_SANTIAGO;
  try {
    delete process.env.VENTAS_TELEFONO_SANTIAGO;
    assert.equal(telefonoVendedor(13), null);
    process.env.VENTAS_TELEFONO_SANTIAGO = '+54 9 11 1234-5678';
    assert.equal(telefonoVendedor(13), '+54 9 11 1234-5678');
    process.env.VENTAS_TELEFONO_SANTIAGO = 'grupo@g.us';
    assert.equal(telefonoVendedor(13), null);
  } finally {
    if (previo === undefined) delete process.env.VENTAS_TELEFONO_SANTIAGO;
    else process.env.VENTAS_TELEFONO_SANTIAGO = previo;
  }
});
