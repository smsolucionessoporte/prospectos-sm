const test = require('node:test');
const assert = require('node:assert/strict');
const { layout } = require('../middleware/auth');
const routes = require('./panel');

function session(rol) {
  return { path: '/', session: {usuario:{id:1,nombre:'Prueba',rol}} };
}

test('vendedor no ve el enlace Resultados y conserva Mi agenda y Oportunidades', () => {
  const html = layout('Inicio','',session('vendedor'));
  assert.doesNotMatch(html, /href="\/control"/);
  assert.match(html, /href="\/crm"/);
  assert.match(html, /href="\/panel"/);
});

test('administrador conserva Resultados sin mostrar Mi agenda', () => {
  const html = layout('Inicio','',session('admin'));
  assert.match(html, /href="\/control"/);
  assert.doesNotMatch(html, /href="\/crm"/);
});

test('vendedor recibe 403 si intenta /control directamente', () => {
  const route = routes.stack.find(layer => layer.route?.path === '/control' && layer.route.methods.get)?.route;
  assert.ok(route, 'ruta /control existente');
  const roleGuard = route.stack[1].handle;
  let status = 0;
  let response = '';
  const res = {status(value){status=value;return this;},send(body){response=body;return this;}};
  let allowed = false;
  roleGuard(session('vendedor'),res,()=>{allowed=true;});
  assert.equal(status,403);
  assert.equal(allowed,false);
  assert.match(response,/No tenés permiso/);
  let adminAllowed = false;
  roleGuard(session('admin'),res,()=>{adminAllowed=true;});
  assert.equal(adminAllowed,true);
});
