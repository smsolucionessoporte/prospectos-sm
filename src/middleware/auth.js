function requireAuth(req, res, next) {
  if (!req.session?.usuario) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireRol(...roles) {
  return (req, res, next) => {
    if (!req.session?.usuario) {
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.usuario.rol)) {
      return res.status(403).send(layout('Acceso denegado', '<div class="alert alert-error">No tenés permiso para ver esta página.</div>', req));
    }
    next();
  };
}

// Helper para incrustar el usuario en todas las vistas
function layout(title, body, req) {
  const u = req?.session?.usuario;
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — SM Prospectos</title>
<link rel="stylesheet" href="/css/app.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.x/dist/tabler-icons.min.css">
</head>
<body>
${u ? `
<nav class="navbar">
  <div class="nav-brand">
    <span class="nav-logo">SM</span>
    <span class="nav-title">SM Soluciones</span>
  </div>
  <div class="nav-links">
    <a href="/panel" class="nav-link${req.path === '/panel' ? ' active' : ''}"><i class="ti ti-layout-dashboard"></i> Panel</a>
    <a href="/prospectos/nuevo" class="nav-link${req.path.startsWith('/prospectos/nuevo') ? ' active' : ''}"><i class="ti ti-user-plus"></i> Nuevo</a>
  </div>
  <div class="nav-user">
    <span class="nav-rol badge-rol-${u.rol}">${u.nombre}</span>
    <a href="/logout" class="nav-logout"><i class="ti ti-logout"></i></a>
  </div>
</nav>
` : ''}
<main class="main-content">
  <div class="page-inner">
    ${body}
  </div>
</main>
</body>
</html>`;
}

module.exports = { requireAuth, requireRol, layout };
