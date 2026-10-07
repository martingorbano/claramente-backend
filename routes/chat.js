// El endpoint principal de matching por IA. Extraído de index.js al dividir
// en módulos — sin cambios de comportamiento.
const express = require('express');
const { anthropic, supabase } = require('../lib/clients');
const { SIN_SENTIDO_LIMITE, BLOQUEO_HORAS } = require('../lib/constants');
const { detectarCrisis, MENSAJE_CRISIS } = require('../lib/crisis');
const { ocultarTelefonos, normalizarTexto } = require('../lib/texto');
const { SYSTEM_PROMPT } = require('../lib/systemPrompt');
const { completarConMismoTag, seleccionarResultadoFinal } = require('../lib/matching');
const { limiterChat } = require('../lib/rateLimiters');

const router = express.Router();

router.post('/chat', limiterChat, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages requerido' });
  }
  if (messages.length > 20) return res.status(400).json({ error: 'Conversación demasiado larga' });
  const lastMsg = messages[messages.length - 1]?.content || '';
  if (typeof lastMsg === 'string' && lastMsg.length > 2000) return res.status(400).json({ error: 'Mensaje demasiado largo' });

  // Chequeo de crisis/riesgo de autolesión: va ANTES que cualquier otra cosa
  // (antes del bloqueo por IP, antes del rate limit de sentido) — nunca debe
  // quedar frenado por otra lógica del sistema. Es determinístico, no depende
  // de que el modelo lo detecte bien.
  const textoUltimoMensaje = typeof lastMsg === 'string'
    ? lastMsg
    : (Array.isArray(lastMsg) ? lastMsg.map(b => b?.text || '').join(' ') : '');

  if (detectarCrisis(textoUltimoMensaje)) {
    console.log('Mensaje de riesgo/crisis detectado, respondiendo con recursos de emergencia');
    return res.json({
      content: [{ type: 'text', text: JSON.stringify({ respuesta: MENSAJE_CRISIS, profesionales: [] }) }]
    });
  }

  const ip = req.ip;

  try {
    // Cortar acá si esta IP ya está bloqueada por mensajes sin sentido reiterados —
    // así no gastamos ni una llamada a Claude con alguien que ya sabemos que es spam.
    const { data: abuso } = await supabase
      .from('chat_abuso')
      .select('strikes, bloqueado_hasta')
      .eq('ip', ip)
      .maybeSingle();

    if (abuso?.bloqueado_hasta && new Date(abuso.bloqueado_hasta) > new Date()) {
      return res.json({
        content: [{ type: 'text', text: JSON.stringify({
          respuesta: 'Este chat quedó temporalmente restringido por mensajes reiterados sin sentido. Si necesitás ayuda para encontrar un psicólogo, escribinos de nuevo más tarde.',
          profesionales: []
        }) }]
      });
    }

    // Traer profesionales activos de Supabase
    const { data: profesionales } = await supabase
      .from('profesionales')
      .select('id, nombre, matricula, whatsapp, bio, ciudad, localidad, experiencia, honorario, obras_sociales, enfoques, especializaciones, modalidades, edades, dias, franjas, foto_url, plan, genero, trial_hasta')
      .eq('activo', true)
      .order('plan', { ascending: false }); // premium > flex > gratuito

    // Verificar trials vencidos y bajarlos a gratuito
    const ahora = new Date();
    const trialsVencidos = profesionales?.filter(p =>
      p.trial_hasta && new Date(p.trial_hasta) < ahora && p.plan === 'gratuito'
    ) || [];

    // No hacemos nada acá — el trial se procesa en el endpoint /verificar-trial

    // Tratar profesionales con trial activo como premium
    if (profesionales) {
      profesionales.forEach(p => {
        if (p.trial_hasta && new Date(p.trial_hasta) > ahora) {
          p.plan = 'premium'; // Trial activo → mostrar como premium
        }
      });
      // Reordenar después de procesar trials: premium primero
      profesionales.sort((a, b) => {
        if (a.plan === b.plan) return 0;
        return a.plan === 'premium' ? -1 : 1;
      });
    }

    // Reducimos los campos que le mandamos a Claude: no necesita bio completa,
    // honorario ni foto_url para decidir el match — eso aligera mucho el prompt.

    // Traer vistas de la última semana por profesional para la rotación equitativa
    const inicioSemana = new Date(ahora);
    inicioSemana.setDate(inicioSemana.getDate() - 7);
    const { data: vistasSemana } = await supabase
      .from('vistas')
      .select('psy_id')
      .gte('created_at', inicioSemana.toISOString());

    // Contar vistas por profesional
    const vistasPorProfesional = {};
    (vistasSemana || []).forEach(v => {
      vistasPorProfesional[v.psy_id] = (vistasPorProfesional[v.psy_id] || 0) + 1;
    });

    // DECISIÓN DE NEGOCIO: los profesionales en plan gratuito (real, sin trial
    // activo) ya no aparecen en ningún resultado del chat, bajo ningún criterio.
    // Se filtran ACÁ, antes de mandarle los datos a Claude — así el modelo ni
    // siquiera los tiene en su contexto, es imposible que los mencione o
    // devuelva por error. p.plan ya viene resuelto más arriba (si el trial
    // está activo, ya se pisó a 'premium'), así que este filtro alcanza solo.
    const profesionalesLivianos = (profesionales || [])
      .filter(p => p.plan === 'premium')
      .map(p => ({
      id: p.id,
      nombre: p.nombre,
      whatsapp: p.whatsapp,
      ciudad: p.ciudad,
      localidad: p.localidad,
      obras_sociales: p.obras_sociales,
      enfoques: p.enfoques,
      especializaciones: p.especializaciones,
      modalidades: p.modalidades,
      edades: p.edades,
      foto_url: p.foto_url,
      plan: p.plan,
      genero: p.genero,
      vistas_semana: vistasPorProfesional[p.id] || 0,
      bio_resumen: (p.bio || '').slice(0, 100)
    }));

    // Mapa id -> edades / especializaciones / plan efectivo (ya resuelto con trial),
    // para poder filtrar de forma determinística la respuesta de Claude más abajo,
    // sin depender 100% de que el modelo respete la regla.
    const edadesPorId = {};
    const especializacionesPorId = {};
    const enfoquesPorId = {};
    const planEfectivoPorId = {};
    const datosCompletosPorId = {};
    // El campo "ciudad" en profesionales es, en realidad, la provincia donde
    // atiende (así está armado el select del formulario de registro) — lo
    // usamos tal cual para el filtro obligatorio de provincia del chat.
    const provinciaPorId = {};
    (profesionales || []).forEach(p => {
      edadesPorId[p.id] = p.edades || [];
      especializacionesPorId[p.id] = p.especializaciones || [];
      enfoquesPorId[p.id] = p.enfoques || [];
      planEfectivoPorId[p.id] = p.plan; // ya viene resuelto con trial activo = premium
      provinciaPorId[p.id] = p.ciudad || '';
      datosCompletosPorId[p.id] = p;
    });

    // Mapea el formato de sesión que puede pedir Claude al tag real de especializaciones
    const FORMATO_A_TAG = {
      'Individual': 'Psicoterapia individual',
      'Pareja': 'Terapia de pareja',
      'Familia': 'Terapia de Familia',
    };

    // Separar premium y gratuitos
    const premiumList = profesionalesLivianos.filter(p => p.plan === 'premium');
    const gratuitoList = profesionalesLivianos.filter(p => p.plan !== 'premium');

    // Rotación equitativa: ordenar por vistas_semana ascendente (el que menos apareció va primero)
    // y mandar solo los primeros 10 de cada grupo para no inflar el prompt.
    // En la siguiente búsqueda, los que aparecieron subirán en el ranking y cederán el lugar.
    const ordenarPorVistas = (lista) => [...lista].sort((a, b) => (a.vistas_semana || 0) - (b.vistas_semana || 0));

    const premiumRotados = ordenarPorVistas(premiumList).slice(0, 10);
    const gratuitosRotados = ordenarPorVistas(gratuitoList).slice(0, 10);
    const listaMezclada = [...premiumRotados, ...gratuitosRotados];

    const listaProfesionales = listaMezclada.length > 0
      ? `\n\nPROFESIONALES DISPONIBLES EN LA BASE DE DATOS:\n${JSON.stringify(listaMezclada.map(({ vistas_semana, ...p }) => p), null, 2)}`
      : '\n\nNo hay profesionales cargados en la base de datos todavía.';

    // Inyectar lista en el último mensaje
    const messagesConBase = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: m.content + listaProfesionales }
        : m
    );

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: messagesConBase,
    });

    const rawText = response.content?.[0]?.text || '';
    console.log('RAW RESPONSE:', rawText.substring(0, 300));

    // Intentar extraer y limpiar JSON del texto
    // Si hay múltiples bloques JSON, tomar el último (Claude a veces genera dos y el segundo es el correcto)
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```js\s*/gi, '').replace(/```/g, '').trim();

    // Buscar todos los bloques JSON y quedarse con el último que tenga profesionales
    let jsonStr = null;
    let searchFrom = 0;
    let lastValidJson = null;
    while (true) {
      const firstBrace = cleaned.indexOf('{', searchFrom);
      if (firstBrace === -1) break;
      // Encontrar el cierre correspondiente
      let depth = 0;
      let end = -1;
      for (let i = firstBrace; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) break;
      const candidate = cleaned.substring(firstBrace, end + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed.respuesta !== undefined) lastValidJson = candidate; // es un JSON de Claramente
      } catch(e) {}
      searchFrom = end + 1;
    }
    const jsonMatch = lastValidJson ? [lastValidJson] : null;

    // Obtener el último mensaje del usuario
    const ultimoMensaje = messages[messages.length - 1]?.content || '';

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.sin_sentido === true) {
          const nuevoStrikes = (abuso?.strikes || 0) + 1;
          const bloquear = nuevoStrikes >= SIN_SENTIDO_LIMITE;

          await supabase.from('chat_abuso').upsert({
            ip,
            strikes: nuevoStrikes,
            bloqueado_hasta: bloquear ? new Date(Date.now() + BLOQUEO_HORAS * 60 * 60 * 1000).toISOString() : null,
            updated_at: new Date().toISOString(),
          });

          supabase.from('consultas').insert({
            mensaje: ultimoMensaje,
            respuesta: 'SIN_SENTIDO: ' + (parsed.respuesta || ''),
            profesionales_devueltos: null
          }).then(() => {}).catch(e => console.error('Error guardando consulta:', e.message));

          const respuestaFinal = bloquear
            ? 'Noté varios mensajes seguidos sin sentido, así que voy a cerrar esta conversación por ahora. Si en algún momento necesitás ayuda real para encontrar un psicólogo, escribinos de nuevo.'
            : (parsed.respuesta || 'No entendí bien tu mensaje. ¿Podés contarme qué estás buscando?');

          return res.json({
            content: [{ type: 'text', text: JSON.stringify({ respuesta: respuestaFinal, profesionales: [] }) }]
          });
        }

        // Mensaje válido: si esta IP tenía strikes previos sin haber llegado a bloquearse, resetear
        if (abuso?.strikes) {
          supabase.from('chat_abuso').update({ strikes: 0, updated_at: new Date().toISOString() }).eq('ip', ip).then(() => {}).catch(() => {});
        }

        if (parsed.profesionales) {
          let vacioPorEdad = false;
          let vacioPorFormato = false;
          let vacioPorProvincia = false;
          let faltaProvincia = false;

          // Filtro determinístico por provincia — el más importante de todos:
          // si Claude no completó provincia_detectada, no mostramos a NADIE
          // (no depende de que el modelo haya respetado la regla de preguntar
          // primero). Si sí la completó, sacamos a cualquiera que haya incluido
          // de otra provincia.
          if (!parsed.provincia_detectada) {
            if (parsed.profesionales.length > 0) {
              console.log('Se bloquearon profesionales porque el modelo no completó provincia_detectada');
              faltaProvincia = true;
            }
            parsed.profesionales = [];
          } else {
            const provinciaNormalizada = normalizarTexto(parsed.provincia_detectada);
            const antesDeFiltrar = parsed.profesionales.length;
            parsed.profesionales = parsed.profesionales.filter(p =>
              normalizarTexto(provinciaPorId[p.id]) === provinciaNormalizada
            );
            if (parsed.profesionales.length < antesDeFiltrar) {
              console.log(`Filtro de provincia (${parsed.provincia_detectada}) sacó ${antesDeFiltrar - parsed.profesionales.length} profesional(es) de otra provincia que el modelo había incluido`);
            }
            if (antesDeFiltrar > 0 && parsed.profesionales.length === 0) vacioPorProvincia = true;
          }

          // Filtro determinístico por edad — no depende de que el modelo lo haya
          // respetado bien en el texto: si Claude marcó una edad requerida,
          // sacamos acá cualquier profesional cuyo campo "edades" real no la incluya.
          if (parsed.edad_requerida) {
            const antesDeFiltrar = parsed.profesionales.length;
            parsed.profesionales = parsed.profesionales.filter(p =>
              (edadesPorId[p.id] || []).includes(parsed.edad_requerida)
            );
            if (parsed.profesionales.length < antesDeFiltrar) {
              console.log(`Filtro de edad (${parsed.edad_requerida}) sacó ${antesDeFiltrar - parsed.profesionales.length} profesional(es) que el modelo había incluido sin cumplir el grupo etario`);
            }
            if (antesDeFiltrar > 0 && parsed.profesionales.length === 0) vacioPorEdad = true;
          }

          // Filtro determinístico por formato de atención (individual/pareja/familia).
          // Chequea el tag correspondiente dentro de especializaciones (Psicoterapia
          // individual / Terapia de pareja / Terapia de Familia).
          if (parsed.formato_requerido && FORMATO_A_TAG[parsed.formato_requerido]) {
            const tagNecesario = FORMATO_A_TAG[parsed.formato_requerido];
            const antesDeFiltrar = parsed.profesionales.length;
            parsed.profesionales = parsed.profesionales.filter(p =>
              (especializacionesPorId[p.id] || []).includes(tagNecesario)
            );
            if (parsed.profesionales.length < antesDeFiltrar) {
              console.log(`Filtro de formato (${parsed.formato_requerido}) sacó ${antesDeFiltrar - parsed.profesionales.length} profesional(es) que el modelo había incluido sin tener "${tagNecesario}"`);
            }
            if (antesDeFiltrar > 0 && parsed.profesionales.length === 0) vacioPorFormato = true;
          }

          // Completar con otros profesionales que comparten el mismo tag_principal
          // pero que Claude no incluyó por su cuenta — no depende de que el modelo
          // haya escaneado bien a todos los que califican.
          if (parsed.tag_principal && !faltaProvincia) {
            const antesDeCompletar = parsed.profesionales.length;
            parsed.profesionales = completarConMismoTag(
              parsed.profesionales, parsed.tag_principal, datosCompletosPorId,
              planEfectivoPorId, especializacionesPorId, enfoquesPorId,
              provinciaPorId, parsed.provincia_detectada
            );
            if (parsed.profesionales.length > antesDeCompletar) {
              console.log(`Completado con tag_principal ("${parsed.tag_principal}"): se sumaron ${parsed.profesionales.length - antesDeCompletar} profesional(es) que el modelo no había incluido`);
              // El texto de Claude puede haber quedado desactualizado (lo escribió
              // pensando en menos candidatos de los que terminamos mostrando) —
              // lo reemplazamos por uno genérico pero numéricamente correcto.
              parsed.respuesta = `Encontré varios profesionales que trabajan con ${parsed.tag_principal} y podrían acompañarte. Te muestro las opciones.`;
            }
          }

          // Enriquecer con vistas_semana para la rotación equitativa.
          // Acá también BLOQUEAMOS contacto directo (whatsapp, foto, y cualquier
          // teléfono metido a mano en nombre/descripción) para cualquiera que no
          // sea premium de verdad (plan efectivo, con trial ya resuelto) — esto
          // es una regla de negocio innegociable, no depende de que el modelo la
          // respete bien en el texto. Un profesional gratuito NUNCA debe filtrar
          // contacto directo, ni por whatsapp ni escondido en otro campo.
          parsed.profesionales = parsed.profesionales.map(p => {
            const esPremiumReal = planEfectivoPorId[p.id] === 'premium';
            return {
              ...p,
              vistas_semana: vistasPorProfesional[p.id] || 0,
              whatsapp: esPremiumReal ? p.whatsapp : null,
              foto_url: esPremiumReal ? p.foto_url : null,
              nombre: esPremiumReal ? p.nombre : ocultarTelefonos(p.nombre),
              descripcion: esPremiumReal ? p.descripcion : ocultarTelefonos(p.descripcion),
            };
          });
          // Selección final: hasta 3 premium (rotando parejo entre ellos si hay
          // varios con %match similar). Los gratuitos ya ni llegan hasta acá —
          // se filtran antes de mandarle los datos a Claude.
          const antesDeSeleccion = parsed.profesionales.length;
          parsed.profesionales = seleccionarResultadoFinal(parsed.profesionales, planEfectivoPorId, 10);
          if (antesDeSeleccion > 0 && parsed.profesionales.length === 0) {
            // Esto no debería poder pasar nunca (seleccionarResultadoFinal no vacía
            // una lista no vacía) — si aparece este log, hay un bug real en esa función.
            console.error(`ALERTA: seleccionarResultadoFinal vació una lista de ${antesDeSeleccion} candidatos — esto es un bug, investigar`);
          }

          // Solo pisamos la respuesta de Claude con nuestro mensaje sintético si el
          // filtro correspondiente fue realmente el que vació la lista — no asumimos
          // por default que fue la edad solo porque el campo esté seteado.
          if (faltaProvincia) {
            parsed.respuesta = '¿En qué provincia estás buscando un profesional?';
          } else if (vacioPorProvincia && parsed.profesionales.length === 0) {
            parsed.respuesta = `Por el momento no tenemos profesionales en ${parsed.provincia_detectada} para esta búsqueda. Probá contándome otra necesidad, o escribinos más adelante.`;
          } else if (vacioPorEdad) {
            parsed.respuesta = `Por el momento no tenemos profesionales disponibles para ese grupo etario (${parsed.edad_requerida}). Probá contándome otra necesidad, o escribinos más adelante.`;
          } else if (vacioPorFormato) {
            parsed.respuesta = `Por el momento no tenemos profesionales que ofrezcan atención en formato ${parsed.formato_requerido.toLowerCase()} para esta consulta. Probá contándome otra necesidad, o escribinos más adelante.`;
          }

          // Guardar consulta en Supabase
          supabase.from('consultas').insert({
            mensaje: ultimoMensaje,
            respuesta: parsed.respuesta || null,
            profesionales_devueltos: parsed.profesionales || []
          }).then(() => {}).catch(e => console.error('Error guardando consulta:', e.message));

          return res.json({
            content: [{ type: 'text', text: JSON.stringify(parsed) }]
          });
        }
      } catch(e) {
        console.error('JSON.parse falló:', e.message);
        console.error('jsonStr problemático:', jsonStr?.substring(0, 500));

        // Reintento: a veces Claude corta el JSON o agrega texto extra al final.
        // Probamos recortar hasta el último "}" válido del array de profesionales.
        try {
          const repairAttempt = jsonStr?.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}');
          const parsed2 = repairAttempt ? JSON.parse(repairAttempt) : null;
          if (parsed2?.profesionales) {
            let faltaProvincia2 = false;
            if (!parsed2.provincia_detectada) {
              faltaProvincia2 = parsed2.profesionales.length > 0;
              parsed2.profesionales = [];
            } else {
              const provinciaNormalizada2 = normalizarTexto(parsed2.provincia_detectada);
              parsed2.profesionales = parsed2.profesionales.filter(p =>
                normalizarTexto(provinciaPorId[p.id]) === provinciaNormalizada2
              );
            }
            if (parsed2.edad_requerida) {
              parsed2.profesionales = parsed2.profesionales.filter(p =>
                (edadesPorId[p.id] || []).includes(parsed2.edad_requerida)
              );
            }
            if (parsed2.formato_requerido && FORMATO_A_TAG[parsed2.formato_requerido]) {
              const tagNecesario = FORMATO_A_TAG[parsed2.formato_requerido];
              parsed2.profesionales = parsed2.profesionales.filter(p =>
                (especializacionesPorId[p.id] || []).includes(tagNecesario)
              );
            }
            if (parsed2.tag_principal && !faltaProvincia2) {
              const antesDeCompletar2 = parsed2.profesionales.length;
              parsed2.profesionales = completarConMismoTag(
                parsed2.profesionales, parsed2.tag_principal, datosCompletosPorId,
                planEfectivoPorId, especializacionesPorId, enfoquesPorId,
                provinciaPorId, parsed2.provincia_detectada
              );
              if (parsed2.profesionales.length > antesDeCompletar2) {
                parsed2.respuesta = `Encontré varios profesionales que trabajan con ${parsed2.tag_principal} y podrían acompañarte. Te muestro las opciones.`;
              }
            }
            if (faltaProvincia2) {
              parsed2.respuesta = '¿En qué provincia estás buscando un profesional?';
            }
            parsed2.profesionales = parsed2.profesionales.map(p => {
              const esPremiumReal = planEfectivoPorId[p.id] === 'premium';
              return {
                ...p,
                vistas_semana: vistasPorProfesional[p.id] || 0,
                whatsapp: esPremiumReal ? p.whatsapp : null,
                foto_url: esPremiumReal ? p.foto_url : null,
                nombre: esPremiumReal ? p.nombre : ocultarTelefonos(p.nombre),
                descripcion: esPremiumReal ? p.descripcion : ocultarTelefonos(p.descripcion),
              };
            });
            // Misma selección final que el camino principal: hasta 3 premium
            // (los gratuitos ya ni llegan a esta instancia, se filtran antes de
            // mandarle los datos a Claude). Este camino de reparación no tenía
            // antes ningún límite ni prioridad de premium.
            parsed2.profesionales = seleccionarResultadoFinal(parsed2.profesionales, planEfectivoPorId, 10);

            supabase.from('consultas').insert({
              mensaje: ultimoMensaje,
              respuesta: parsed2.respuesta || null,
              profesionales_devueltos: parsed2.profesionales || []
            }).then(() => {}).catch(e => console.error('Error guardando consulta:', e.message));

            return res.json({
              content: [{ type: 'text', text: JSON.stringify(parsed2) }]
            });
          }
        } catch (e2) {
          console.error('Reintento de reparación también falló:', e2.message);
        }

        // Si ambos intentos fallan, devolvemos un mensaje de error controlado
        // en vez de mostrar el JSON crudo al usuario.
        supabase.from('consultas').insert({
          mensaje: ultimoMensaje,
          respuesta: 'ERROR_PARSEO: ' + rawText.substring(0, 1000),
          profesionales_devueltos: null
        }).then(() => {}).catch(e => console.error('Error guardando consulta:', e.message));

        return res.json({
          content: [{ type: 'text', text: JSON.stringify({ respuesta: 'Tuve un problema al procesar tu búsqueda. ¿Podés intentarlo de nuevo?', profesionales: [] }) }]
        });
      }
    }

    // Guardar respuesta de texto (sin profesionales)
    supabase.from('consultas').insert({
      mensaje: ultimoMensaje,
      respuesta: rawText,
      profesionales_devueltos: null
    }).then(() => {}).catch(e => console.error('Error guardando consulta:', e.message));

    // Respuesta de texto legítima (ej: "no tenemos especialistas en X área") — resetear strikes previos
    if (abuso?.strikes) {
      supabase.from('chat_abuso').update({ strikes: 0, updated_at: new Date().toISOString() }).eq('ip', ip).then(() => {}).catch(() => {});
    }

    res.json({ content: response.content });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Error al conectar con el agente' });
  }
});

module.exports = router;
