const express = require('express');
const path = require('path');
const cors = require('cors');

const { limiterGeneral } = require('./lib/rateLimiters');
const cronTrials = require('./cron/trials');

const app = express();
app.set('trust proxy', 1); // Render usa proxy

// Redirigir onrender.com a claramentepsi.com
app.use((req, res, next) => {
  if (req.hostname.includes('onrender.com')) {
    return res.redirect(301, 'https://claramentepsi.com' + req.originalUrl);
  }
  next();
});
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['https://claramentepsi.com', 'https://www.claramentepsi.com'],
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '50kb' })); // limitar tamaño de requests

app.use(limiterGeneral);

// Páginas estáticas (incluye el middleware que inyecta GTAG) + sitemap/robots/ayuda/áreas
app.use(require('./routes/paginas'));

app.use(express.static(path.join(__dirname, 'public')));

// Rutas de la API, agrupadas por dominio
app.use(require('./routes/admin'));
app.use(require('./routes/chat'));
app.use(require('./routes/vistaContacto'));
app.use(require('./routes/auth'));
app.use(require('./routes/profesionales'));
app.use(require('./routes/webhooks'));

app.get('/verificar-email.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'verificar-email.html')));
app.get('/recuperar-password.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recuperar-password.html')));
app.get('/reset-password.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/pago-exitoso.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pago-exitoso.html')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Arrancar los crons de trials/cancelaciones (una corrida inicial + cada 12hs)
cronTrials.iniciar();

app.listen(PORT, () => {
  console.log(`Claramente corriendo en puerto ${PORT}`);
});
