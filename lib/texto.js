// Helpers de validación y normalización de texto. Extraído de index.js al
// dividir en módulos — sin cambios de comportamiento.

// Oculta secuencias que parecen números de teléfono dentro de texto libre
// (nombre, descripción) — para que un profesional gratuito no pueda esquivar
// el bloqueo de contacto directo metiendo su whatsapp a mano en otro campo.
function ocultarTelefonos(texto) {
  if (!texto || typeof texto !== 'string') return texto;
  return texto.replace(/(\+?\d[\d\s\-.()]{5,}\d)/g, '[contacto oculto]');
}

// Valida nombre y bio al registrarse o editar perfil, para que nadie pueda
// meter un teléfono (u otro número largo) ahí desde el origen. En "nombre"
// no tiene sentido ningún dígito. En "bio" sí puede haber números cortos
// legítimos ("15 años de experiencia"), así que solo bloqueamos patrones
// que parecen teléfono, no cualquier dígito.
const PATRON_TELEFONO = /\+?\d[\d\s\-.()]{5,}\d/;
// Normaliza el nombre a Formato Título, sin importar cómo lo haya tipeado
// el profesional (todo mayúsculas, todo minúsculas, mezclado). Maneja acentos
// y apóstrofes (ej: "dell'oglio" -> "Dell'Oglio").
// Normaliza texto para comparar provincias (y similares) sin que mayúsculas
// o acentos rompan la comparación — ej: "cordoba" vs "Córdoba", "CABA" vs "caba".
function normalizarTexto(texto) {
  return (texto || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function normalizarNombre(nombre) {
  if (!nombre || typeof nombre !== 'string') return nombre;
  return nombre
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(palabra =>
      palabra
        .split("'")
        .map(parte => parte.charAt(0).toLocaleUpperCase('es') + parte.slice(1).toLocaleLowerCase('es'))
        .join("'")
    )
    .join(' ');
}

function validarSinTelefono(nombre, bio) {
  if (nombre && /\d/.test(nombre)) {
    return 'El nombre no puede contener números.';
  }
  if (bio && PATRON_TELEFONO.test(bio)) {
    return 'La bio no puede contener números de teléfono ni contacto directo — eso va únicamente en el campo de WhatsApp.';
  }
  return null;
}

// Mismo chequeo, pero para arrays de tags con texto libre (enfoques,
// especializaciones, obras_sociales admiten "+ Otra/Otro" con texto a mano).
function validarArraysSinTelefono(...arrays) {
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === 'string' && PATRON_TELEFONO.test(item)) {
        return 'Uno de los campos personalizados (enfoques, especializaciones u obras sociales) contiene un número de teléfono — sacalo, el contacto va únicamente en el campo de WhatsApp.';
      }
    }
  }
  return null;
}

module.exports = {
  ocultarTelefonos,
  PATRON_TELEFONO,
  normalizarTexto,
  normalizarNombre,
  validarSinTelefono,
  validarArraysSinTelefono,
};
