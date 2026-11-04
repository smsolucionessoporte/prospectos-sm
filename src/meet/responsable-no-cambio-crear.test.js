'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'routes.js'), 'utf8');

test('crear demo desde enlace o formulario no altera demo_responsable', () => {
  // Las dos rutas de coordinación actualizan estado, fecha y enlace, pero no titularidad.
  const updateStatements = [...source.matchAll(/UPDATE prospectos SET estado='demo_coordinada'[\s\S]*?WHERE id=\$1/g)].map(m => m[0]);
  assert.equal(updateStatements.length, 2, 'esperamos los dos caminos de coordinación');
  for (const sql of updateStatements) {
    assert.doesNotMatch(sql, /demo_responsable\s*=/i, 'no debe poner un responsable predeterminado');
    assert.match(sql, /demo_fecha=/);
    assert.match(sql, /zoom_join_url=/);
  }
  assert.doesNotMatch(source, /COALESCE\s*\(\s*demo_responsable\s*,\s*6\s*\)/i);
});
