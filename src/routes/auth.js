const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool } = require('../db');
const { layout } = require('../middleware/auth');

router.get('/login', (req, res) => {
  if (req.session?.usuario) return res.redirect('/panel');
  const next = req.query.next || '/panel';
  const error = req.query.error;
  res.send(layout('Iniciar sesión', `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-header">
          <div class="login-logo">SM</div>
          <h1 class="login-title">SM Soluciones</h1>
          <p class="login-sub">Gestión de prospectos SM</p>
        </div>
        ${error ? `<div class="alert alert-error"><i class="ti ti-alert-circle"></i> ${error}</div>` : ''}
        <form method="POST" action="/login">
          <input type="hidden" name="next" value="${next}">
          <div class="field">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required autofocus placeholder="tu@email.com">
          </div>
          <div class="field">
            <label for="password">Contraseña</label>
            <input type="password" id="password" name="password" required placeholder="••••••••">
          </div>
          <button type="submit" class="btn btn-primary btn-block">
            <i class="ti ti-login"></i> Ingresar
          </button>
        </form>
      </div>
    </div>
  `, null));
});

router.post('/login', async (req, res) => {
  const { email, password, next } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1 AND activo = true', [email]
    );
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.redirect('/login?error=Email+o+contraseña+incorrectos');
    }
req.session.usuario = { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol };
const destino = (next && next.startsWith('/')) ? next : '/panel';
req.session.save(() => res.redirect(destino));
  } catch (err) {
    console.error(err);
    res.redirect('/login?error=Error+interno,+intentá+de+nuevo');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
