'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sincronizarResponsableChatwoot } = require('./responsables');

test('reasigna Santiago en la transacción, sincronizando nombre y sin tocar creador o demo', async () => {
  const consultas = [];
  const pool = { async connect() { return {
    async query(sql, args) {
      consultas.push([sql, args]);
      if (sql.startsWith('SELECT nombre')) return { rows: [{ nombre: 'Santiago Fontanet' }] };
      return { rowCount: 1, rows: [{ vendedor_id: 13, vendedor_nombre: 'Santiago Fontanet' }] };
    },
    release() {},
  }; } };
  const resultado = await sincronizarResponsableChatwoot(pool, 2860, 19);
  assert.deepEqual(resultado, { usuario_id: 13, vendedor_nombre: 'Santiago Fontanet' });
  const upsert = consultas.find(([sql]) => sql.includes('INSERT INTO control_ventas'));
  assert.deepEqual(upsert[1], [2860, 13, 'Santiago Fontanet']);
  assert.match(upsert[0], /vendedor_nombre=EXCLUDED.vendedor_nombre/);
  assert.match(upsert[0], /fecha_derivacion=COALESCE/);
  assert.match(upsert[0], /derivado=TRUE/);
  assert.equal(consultas.some(([sql]) => /UPDATE prospectos\b/.test(sql)), false);
  assert.ok(consultas.some(([sql]) => sql.includes("origen='chatwoot'")));
  assert.equal(consultas.at(-1)[0], 'COMMIT');
});

test('no restaura Daniel ni asigna usuario fuera de ventas', async () => {
  await assert.rejects(sincronizarResponsableChatwoot({}, 2860, 8), /inválido/);
  await assert.rejects(sincronizarResponsableChatwoot({}, 2860, 2), /inválido/);
});

test('si el control fue clasificado como consulta errónea revierte todo', async () => {
  const consultas = [];
  const pool = { async connect() { return {
    async query(sql) {
      consultas.push(sql);
      if (sql.startsWith('SELECT nombre')) return { rows: [{ nombre: 'Rafael Altadonna' }] };
      if (sql.includes('INSERT INTO control_ventas')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    }, release() {},
  }; } };
  await assert.rejects(sincronizarResponsableChatwoot(pool, 3080, 4), /no comercial/);
  assert.ok(consultas.includes('ROLLBACK'));
  assert.ok(!consultas.includes('COMMIT'));
});
