// Constantes de negocio compartidas entre módulos. Extraídas de index.js
// al dividir en módulos — mismos valores, sin cambios de comportamiento.
const PREMIUM_MONTO = 32500; // ARS/mes — plan Premium
const SIN_SENTIDO_LIMITE = 2; // mensajes sin sentido antes de bloquear la IP
const BLOQUEO_HORAS = 24; // duración del bloqueo

// Cuántos días esperar después del mail de "tu trial terminó" antes de mandar
// el recordatorio — le da tiempo a la persona a reaccionar sola, sin ser invasivos.
const DIAS_PARA_RECORDATORIO = 5;

module.exports = { PREMIUM_MONTO, SIN_SENTIDO_LIMITE, BLOQUEO_HORAS, DIAS_PARA_RECORDATORIO };
