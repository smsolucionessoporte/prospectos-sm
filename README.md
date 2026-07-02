# vPlus Prospectos — SM Soluciones

Sistema de gestión de prospectos para el proceso comercial de SM Soluciones / vPlus.

## Flujo de estados

```
[Prospecto] → [Demo coordinada] → [Demo realizada] → [Propuesta enviada] → [Confirmado ✓]
                                                                          ↘ [Perdido]
```

| Estado | Responsable | Acción |
|---|---|---|
| Prospecto | Administrativa | Da de alta el contacto inicial |
| Demo coordinada | Soporte | Agenda fecha y responsable |
| Demo realizada | Soporte | Completa el formulario de relevamiento |
| Propuesta enviada | Administrativa | Marca que se envió la propuesta |
| Confirmado | Administrativa | Cliente pasa a SM Admin |
| Perdido | Cualquiera | No avanzó |

## Deploy en Railway

### 1. Crear el proyecto

```bash
# Inicializá un repositorio Git
git init
git add .
git commit -m "initial commit"
```

### 2. En Railway

1. Crear nuevo proyecto → **Deploy from GitHub repo** (o conectar el repo)
2. Agregar plugin **PostgreSQL** al proyecto
3. Railway setea `DATABASE_URL` automáticamente

### 3. Variables de entorno (Railway → Variables)

```
SESSION_SECRET=<cadena aleatoria larga>
ADMIN_EMAIL=tu@email.com
ADMIN_PASSWORD=<contraseña segura>
NODE_ENV=production
```

Para generar `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Primer arranque

Al iniciarse por primera vez, el sistema:
- Crea automáticamente las tablas en PostgreSQL
- Crea el usuario admin con las credenciales de las variables de entorno

### 5. Crear usuarios

Entrá como admin y creá los usuarios de cada área desde la consola de Railway o con este SQL:

```sql
-- Reemplazá el hash con bcrypt de la contraseña
INSERT INTO usuarios (nombre, email, password_hash, rol)
VALUES ('María García', 'maria@smsoluciones.com', '<hash>', 'administrativa');

INSERT INTO usuarios (nombre, email, password_hash, rol)
VALUES ('Carlos Pérez', 'carlos@smsoluciones.com', '<hash>', 'soporte');
```

Para generar el hash desde Node:
```js
const bcrypt = require('bcryptjs');
bcrypt.hash('contraseña', 10).then(console.log);
```

## Roles

| Rol | Acceso |
|---|---|
| `administrativa` | Panel, nuevo prospecto, cambios de estado finales |
| `soporte` | Panel, coordinar demo, cargar relevamiento |
| `admin` | Todo lo anterior |

## Estructura del proyecto

```
vplus-prospectos/
├── src/
│   ├── index.js              # Entry point Express
│   ├── db.js                 # Conexión PostgreSQL
│   ├── middleware/
│   │   └── auth.js           # Autenticación + layout HTML
│   └── routes/
│       ├── auth.js           # Login / logout
│       ├── panel.js          # Dashboard con filtros
│       └── prospectos.js     # CRUD prospectos + relevamiento
├── public/
│   └── css/app.css           # Estilos
├── migrations/
│   └── 001_init.sql          # Schema de base de datos
├── package.json
└── .env.example
```
