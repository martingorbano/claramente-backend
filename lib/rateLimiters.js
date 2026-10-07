// Configuración de rate limiting. Extraído de index.js al dividir en
// módulos — sin cambios de comportamiento.
const rateLimit = require('express-rate-limit');

// Rate limiting general
const limiterGeneral = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: { error: 'Demasiadas solicitudes. Intentá en unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting estricto para el chat (IA)
const limiterChat = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,
  message: { error: 'Demasiadas consultas al asistente. Esperá un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting para login (anti brute force)
const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,
  message: { error: 'Demasiados intentos de login. Intentá en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { limiterGeneral, limiterChat, limiterLogin };
