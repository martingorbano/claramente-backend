// Páginas estáticas y el middleware que inyecta Google Tag en el HTML
// servido. Extraído de index.js al dividir en módulos — sin cambios de
// comportamiento ni de orden relativo (este router se monta antes de
// express.static en index.js, igual que en el archivo original).
const express = require('express');
const path = require('path');
const fs = require('fs');
const { GTAG } = require('../lib/gtag');

const router = express.Router();

// Middleware que inyecta GTAG en páginas HTML antes de servirlas
router.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    const filePath = req.path === '/'
      ? path.join(__dirname, '..', 'public', 'index.html')
      : path.join(__dirname, '..', 'public', req.path);
    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, 'utf8');
      html = html.replace('</head>', GTAG + '\n</head>');
      return res.send(html);
    }
  }
  next();
});

// Sitemap y robots
router.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(__dirname, '..', 'public', 'sitemap.xml'));
});
router.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, '..', 'public', 'robots.txt'));
});

// Ruta de ayuda
router.get('/ayuda', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ayuda.html'));
});

// Rutas de áreas de atención
const areas = ['ansiedad', 'pareja', 'ninos', 'adicciones', 'evaluaciones', 'neuropsicologia', 'judicial', 'vocacional'];
areas.forEach(area => {
  router.get(`/${area}`, (req, res) => {
    const filePath = path.join(__dirname, '..', 'public', `${area}.html`);
    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, 'utf8');
      html = html.replace('</head>', GTAG + '\n</head>');
      return res.send(html);
    }
    res.status(404).send('Not found');
  });
});

module.exports = router;
