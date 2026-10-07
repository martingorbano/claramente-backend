// Helpers de armado y rotación de las tarjetas de profesionales que se
// muestran en el chat. Extraído de index.js al dividir en módulos — sin
// cambios de comportamiento.
const { normalizarTexto } = require('./texto');

// Genera iniciales tipo "CP" a partir de un nombre completo, sacando el título
// (Lic./Dr./Dra./Mg.) primero.
function generarIniciales(nombre) {
  if (!nombre) return '??';
  const limpio = nombre.replace(/^(Lic\.|Dr\.|Dra\.|Mg\.)\s*/i, '').trim();
  const partes = limpio.split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '??';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

const COLORES_TARJETA = ['warm', 'sage', 'purple'];

// Completa la lista de profesionales con otros que comparten el mismo
// "tag_principal" que Claude identificó como criterio, pero que el modelo
// no incluyó en su propia respuesta. Busca en TODOS los datos disponibles
// (no solo en lo que Claude ya devolvió) — así no depende de que el modelo
// haya escaneado y enumerado bien a todos los que califican, que es
// justamente donde vimos que fallaba de forma recurrente.
function completarConMismoTag(profesionalesIncluidos, tagPrincipal, datosCompletosPorId, planEfectivoPorId, especializacionesPorId, enfoquesPorId, provinciaPorId, provinciaRequerida) {
  if (!tagPrincipal || !Array.isArray(profesionalesIncluidos)) return profesionalesIncluidos;

  // Si hay una provincia requerida, la búsqueda de "faltantes" respeta ese
  // mismo límite — si no, este completado podía traer de vuelta a alguien
  // de otra provincia que el filtro de provincia ya había sacado.
  const provinciaNormalizada = provinciaRequerida ? normalizarTexto(provinciaRequerida) : null;

  const idsYaIncluidos = new Set(profesionalesIncluidos.map(p => p.id));
  const faltantes = Object.keys(datosCompletosPorId).filter(id =>
    !idsYaIncluidos.has(id) &&
    planEfectivoPorId[id] === 'premium' &&
    (!provinciaNormalizada || normalizarTexto(provinciaPorId?.[id]) === provinciaNormalizada) &&
    ((especializacionesPorId[id] || []).includes(tagPrincipal) || (enfoquesPorId[id] || []).includes(tagPrincipal))
  );

  if (faltantes.length === 0) return profesionalesIncluidos;

  // Match de referencia: el más bajo que ya haya usado Claude, para que no
  // desentonen visualmente los agregados por el backend.
  const matchesExistentes = profesionalesIncluidos.map(p => p.match).filter(m => typeof m === 'number');
  const matchReferencia = matchesExistentes.length > 0 ? Math.min(...matchesExistentes) : 90;

  const nuevos = faltantes.map((id, i) => {
    const p = datosCompletosPorId[id];
    return {
      id: p.id,
      nombre: p.nombre,
      especialidad: tagPrincipal,
      enfoque: (p.enfoques || [])[0] || '',
      modalidad: (p.modalidades || []).join(' y '),
      obras_sociales: p.obras_sociales || [],
      descripcion: `Trabaja con ${tagPrincipal.toLowerCase()}.`,
      match: matchReferencia,
      iniciales: generarIniciales(p.nombre),
      color: COLORES_TARJETA[(profesionalesIncluidos.length + i) % COLORES_TARJETA.length],
      plan: p.plan,
      whatsapp: p.whatsapp,
      ciudad: p.ciudad,
      localidad: p.localidad,
      foto_url: p.foto_url,
    };
  });

  return [...profesionalesIncluidos, ...nuevos];
}

// Rota el orden de profesionales premium cuyo match esté dentro de un rango cercano (empate),
// para no mostrar siempre al mismo cuando varios son igual de afines.
// Mantiene el orden premium > gratuito, y dentro de cada banda de empate
// prioriza al que menos apareció en la última semana (según vistas_semana).
// Rota de forma pareja dentro de un grupo (premium o gratuito por separado):
// agrupa en "bandas" a quienes están dentro de rangoEmpate puntos de %match
// entre sí, y dentro de cada banda ordena por quien menos apareció esta
// semana (vistas_semana) — así no es siempre el mismo el que sale primero
// entre varios con un match similar.
function rotarBanda(lista, rangoEmpate = 10) {
  if (!Array.isArray(lista) || lista.length <= 1) return lista;

  const ordenados = [...lista].sort((a, b) => (b.match || 0) - (a.match || 0));
  const bandas = [];
  let bandaActual = [];

  ordenados.forEach((p) => {
    if (bandaActual.length === 0) {
      bandaActual.push(p);
    } else {
      const referencia = bandaActual[0].match || 0;
      if ((referencia - (p.match || 0)) <= rangoEmpate) {
        bandaActual.push(p);
      } else {
        bandas.push(bandaActual);
        bandaActual = [p];
      }
    }
  });
  if (bandaActual.length) bandas.push(bandaActual);

  return bandas.flatMap(banda =>
    [...banda].sort((a, b) => {
      const vistasA = a.vistas_semana || 0;
      const vistasB = b.vistas_semana || 0;
      if (vistasA !== vistasB) return vistasA - vistasB;
      return Math.random() - 0.5;
    })
  );
}

// Selección final que se muestra en el chat: hasta 3 profesionales PREMIUM
// (real o con trial activo), rotando parejo entre ellos si hay varios con
// %match similar. Los profesionales en plan gratuito NUNCA aparecen — ni
// siquiera si sobra lugar. En la práctica Claude ya ni los ve (se filtran
// antes de mandarle los datos), pero esta función tampoco los agregaría
// aunque se colara alguno por cualquier motivo.
function seleccionarResultadoFinal(profesionales, planEfectivoPorId, rangoEmpate = 10) {
  if (!Array.isArray(profesionales)) return [];

  const premium = profesionales.filter(p => planEfectivoPorId[p.id] === 'premium');
  return rotarBanda(premium, rangoEmpate).slice(0, 3);
}

module.exports = {
  generarIniciales,
  COLORES_TARJETA,
  completarConMismoTag,
  rotarBanda,
  seleccionarResultadoFinal,
};
