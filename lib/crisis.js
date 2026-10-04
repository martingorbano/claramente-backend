// Detección de riesgo de crisis / suicidio / autolesión, y el mensaje de
// contención que se devuelve en esos casos. Extraído de index.js al dividir
// en módulos — sin cambios de comportamiento.
//
// Es determinística (no depende de que el modelo lo detecte bien) porque acá
// el costo de un falso negativo es demasiado alto — mejor pecar de sensible.
// Números verificados: 911 es la línea de emergencia nacional; 0800-345-1435
// es la línea del Centro de Asistencia al Suicida, gratuita y para todo el país
// (NO usar 0800-999-0091, que es una línea local de San Juan, no nacional).
const SEÑALES_CRISIS = [
  /me quiero matar/i, /quiero matarme/i,
  /me quiero suicidar/i, /quiero suicidarme/i, /suicidarme/i, /suicidio/i,
  /no quiero vivir/i, /no quiero seguir viviendo/i, /no aguanto más vivir/i,
  /quiero morir/i, /me quiero morir/i, /ganas de morir/i,
  /quitarme la vida/i, /terminar con mi vida/i, /terminar con todo esto/i,
  /hacerme daño/i, /lastimarme/i, /cortarme/i, /autolesion/i,
  /no vale la pena (vivir|seguir viviendo)/i,
];

function detectarCrisis(texto) {
  if (!texto || typeof texto !== 'string') return false;
  return SEÑALES_CRISIS.some(regex => regex.test(texto));
}

const MENSAJE_CRISIS = 'Lo que me contás suena realmente doloroso, y quiero que sepas que no estás solo/a con esto.\n\nSi estás pensando en hacerte daño o en quitarte la vida, por favor buscá ayuda ahora mismo:\n\n📞 **911** — si es una emergencia inmediata\n📞 **0800-345-1435** — Centro de Asistencia al Suicida, línea gratuita, confidencial y las 24 horas, para todo el país\n\nHablar con alguien ahora puede ayudar. Y si querés, cuando estés listo/a también podemos ayudarte a encontrar un psicólogo para acompañarte de forma continua — contame y te ayudo a buscar.';

module.exports = { SEÑALES_CRISIS, detectarCrisis, MENSAJE_CRISIS };
