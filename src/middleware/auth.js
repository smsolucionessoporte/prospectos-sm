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
<title>${title} — SM Comercial</title>
<meta name="theme-color" content="#17264d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="SM Comercial">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/icons/sm-comercial.svg">
<link rel="apple-touch-icon" href="/icons/sm-comercial-192.png">
<link rel="stylesheet" href="/css/app.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.x/dist/tabler-icons.min.css">
</head>
<body>
${u ? `
<nav class="navbar">
  <div class="nav-brand">
    <span class="nav-logo">SM</span>
    <span class="nav-title">SM Comercial</span>
  </div>
  <div class="nav-links">
    ${u.rol === 'vendedor' ? `<a href="/crm" class="nav-link${req.path.startsWith('/crm') ? ' active' : ''}"><i class="ti ti-layout-dashboard"></i><span>Mi agenda</span></a>` : ''}
    ${u.rol !== 'control' ? `<a href="/panel" class="nav-link${req.path.startsWith('/panel') || req.path.startsWith('/prospectos') ? ' active' : ''}"><i class="ti ti-users"></i><span>Oportunidades</span></a>` : ''}
    ${['admin','vendedor','control'].includes(u.rol) ? `<a href="/control" class="nav-link${req.path.startsWith('/control') ? ' active' : ''}"><i class="ti ti-chart-bar"></i><span>Resultados</span></a>` : ''}
    ${u.rol === 'admin' ? `<a href="/campanias" class="nav-link${req.path.startsWith('/campanias') ? ' active' : ''}"><i class="ti ti-speakerphone"></i><span>Campañas</span></a>` : ''}
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
<script>if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));</script>
</body>
</html>`;
}

module.exports = { requireAuth, requireRol, layout };
