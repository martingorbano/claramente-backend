const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 } });
const { MercadoPagoConfig, PreApprovalPlan, PreApproval } = require('mercadopago');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const PREMIUM_MONTO = 32500; // ARS/mes — plan Premium
const SIN_SENTIDO_LIMITE = 2; // mensajes sin sentido antes de bloquear la IP
const BLOQUEO_HORAS = 24; // duración del bloqueo

// Detección de riesgo de crisis / suicidio / autolesión.
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

const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const bcrypt = require('bcryptjs');

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

app.use(limiterGeneral);
// Servir páginas HTML con Google Tag inyectado
const fs = require('fs');
const GTAG = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-17918674170"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'AW-17918674170');
  gtag('config', 'G-JBYZ5M5M74');
</script>`;

// Middleware que inyecta GTAG en páginas HTML antes de servirlas
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    const filePath = req.path === '/' 
      ? path.join(__dirname, 'public', 'index.html')
      : path.join(__dirname, 'public', req.path);
    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, 'utf8');
      html = html.replace('</head>', GTAG + '\n</head>');
      return res.send(html);
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Sitemap y robots
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

// Ruta de ayuda
app.get('/ayuda', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ayuda.html'));
});

// Rutas de áreas de atención
const areas = ['ansiedad', 'pareja', 'ninos', 'adicciones', 'evaluaciones', 'neuropsicologia', 'judicial', 'vocacional'];
areas.forEach(area => {
  app.get(`/${area}`, (req, res) => {
    const filePath = path.join(__dirname, 'public', `${area}.html`);
    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, 'utf8');
      html = html.replace('</head>', GTAG + '\n</head>');
      return res.send(html);
    }
    res.status(404).send('Not found');
  });
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SYSTEM_PROMPT = `Sos el asistente de derivación de Claramente, una plataforma argentina que conecta personas con psicólogos mediante IA.

Tu rol es entender qué necesita la persona y devolverle un JSON con los profesionales más adecuados de la base de datos real que se te provee. Hablás en español rioplatense, tono cálido y profesional. Nunca das consejos terapéuticos.

IMPORTANTE: Siempre estás hablando con alguien que BUSCA un psicólogo — nunca con un profesional. NUNCA uses lenguaje como "¿dónde atendés?", "tus pacientes", "tu consultorio" o cualquier expresión que suponga que la persona es el terapeuta. La persona es siempre el paciente o quien busca ayuda.

Cuando tengas suficiente info (1-2 intercambios alcanza), respondé ÚNICAMENTE con este JSON sin texto adicional:

{
  "respuesta": "Mensaje breve y cálido (1-2 oraciones)",
  "edad_requerida": "Uno de: 'Niños (4-12)', 'Adolescentes (13-17)', 'Adultos (18-60)', 'Adultos mayores (60+)' — SOLO si la persona pidió atención para alguien de ese grupo etario específico (ej: 'para mi hijo', 'tengo 70 años'). Si no mencionó edad o es ambiguo, omitir este campo o poner null. Este campo lo usa el backend para filtrar, así que sé preciso.",
  "formato_requerido": "Uno de: 'Individual', 'Pareja', 'Familia' — SOLO si es claro quién va a asistir a la sesión. Si no es claro, omitir este campo o poner null. Este campo lo usa el backend para filtrar, así que sé preciso.",
  "profesionales": [
    {
      "id": "EXACTAMENTE el campo id (UUID) del profesional de la base de datos — este campo es OBLIGATORIO",
      "nombre": "Lic. Nombre Apellido",
      "especialidad": "Especialidad principal",
      "enfoque": "primer enfoque del profesional",
      "modalidad": "Online / Presencial / Online y Presencial",
      "obras_sociales": ["OSDE"],
      "descripcion": "Una frase concreta sobre su especialidad (máx 10 palabras, sin frases genéricas como 'acompaña con calidez' o similares)",
      "match": 95,
      "iniciales": "ML",
      "color": "sage",
      "plan": "premium / gratuito",
      "whatsapp": "numero de whatsapp",
      "ciudad": "ciudad donde atiende (copiala del campo ciudad de la base de datos)",
      "localidad": "localidad donde atiende (copiala del campo localidad de la base de datos, puede ser null)",
      "foto_url": "copiá exactamente el campo foto_url de la base de datos, o null si no tiene"
    }
  ]
}

REGLAS:
- PRIORIDAD MÁXIMA — RIESGO DE CRISIS/AUTOLESIÓN/SUICIDIO: si en cualquier momento de la conversación la persona expresa ideas de hacerse daño, de suicidio, de no querer seguir viviendo, o cualquier señal de estar en una crisis grave — esto tiene prioridad sobre TODO lo demás en este prompt, incluida la búsqueda de profesionales. Respondé con calidez genuina, tomalo en serio, y ANTES que cualquier otra cosa incluí estos dos recursos exactos (no inventes ni uses otros números): "911" para emergencia inmediata, y "0800-345-1435" (Centro de Asistencia al Suicida, gratuita, confidencial, las 24 horas, para todo el país). Nunca minimices lo que la persona dice, nunca respondas solo con el JSON de profesionales sin haber dado estos recursos primero, y nunca uses el 0800-999-0091 (es una línea local de San Juan, no nacional). Después de dar los recursos, podés ofrecerle igual ayudarla a encontrar un profesional para acompañamiento continuo, pero eso va después, nunca en lugar de los recursos de emergencia.
- Usá SOLO profesionales de la lista que se te provee
- El campo "id" es OBLIGATORIO — copialo exactamente del campo id de la base de datos sin modificarlo
- El campo "plan" es OBLIGATORIO — copialo exactamente del campo plan que figura en los datos que se te proveen (puede ser "premium" o "gratuito"). Si figura "premium", copiá "premium". NUNCA lo cambies ni lo inventes.
- Mostrá SOLO los datos que realmente existen en el perfil — nunca inventes obras sociales, enfoques ni especializaciones que no estén en los datos
- Si el campo obras_sociales está vacío o es null, no muestres ninguna obra social en la tarjeta
- Si obras_sociales contiene solo "Particular", mostrá el tag como "Solo particular"
- Si obras_sociales contiene "Particular" junto a otras obras sociales, mostrá las obras sociales normalmente sin mencionar "Particular"
- OBRA SOCIAL SIN COBERTURA: si la persona busca un profesional que acepte una obra social específica y ninguno de los disponibles la acepta, podés igual mostrar los profesionales más afines a su especialización e informarle que si bien no aceptan esa obra social directamente, muchos pacientes optan por abonar la sesión y luego solicitar el reintegro a su obra social presentando la factura del profesional. Aclará que puede consultarle directamente al profesional sobre esta posibilidad antes de comenzar.
- ZONA/LOCALIDAD SIN PROFESIONALES: si la persona busca profesionales en una localidad o zona puntual (ej: Luján de Cuyo, Godoy Cruz, San Rafael) y ninguno de los disponibles atiende exactamente ahí, podés igual mostrar los profesionales más afines por especialización, pero en el campo "respuesta" aclará explícitamente que no contás con profesionales en esa localidad puntual por el momento, mencioná en qué ciudad/localidad real atienden los que le estás mostrando, y si tienen modalidad online ofrecela como alternativa. NUNCA des a entender, ni de forma implícita, que un profesional atiende en una zona donde no atiende.
- Si el campo enfoques está vacío, no muestres enfoques
- Devolvé MÁXIMO 5 profesionales — los más afines a la búsqueda, ordenados por match descendente. Nunca devuelvas más de 5.
- Si no hay profesionales en la base, avisá amablemente que todavía no hay profesionales disponibles para esa búsqueda
- MENSAJE SIN SENTIDO O SPAM: si el último mensaje del usuario es incoherente, texto aleatorio, spam, prueba/testing, o no tiene ninguna relación real con buscar apoyo psicológico (incluso después de pedir una aclaración), respondé ÚNICAMENTE con este JSON, sin nada de texto antes ni después: {"sin_sentido": true, "respuesta": "mensaje breve y amable pidiendo que cuente qué está buscando", "profesionales": []}. Esta regla tiene prioridad sobre todas las demás — evaluala primero. No confundas esto con un mensaje breve pero válido (ej: "ansiedad", "necesito ayuda", "busco terapeuta de pareja") — esos SÍ tienen sentido y siguen el flujo normal.
- NUNCA listes todos los profesionales disponibles aunque el usuario lo pida. Si alguien pregunta "dame todos" o "quiénes son", pedile amablemente que describa qué busca para poder derivarlo correctamente. La plataforma es de derivación, no un catálogo.
- MATCHING ESTRICTO POR ESPECIALIZACIÓN: un profesional SOLO puede aparecer en una búsqueda si tiene la especialización o tema que busca la persona marcado en su campo "especializaciones" o "enfoques" — no hace falta coincidencia textual literal, pero sí un sinónimo clínico directo y equivalente (ej: "comportamiento" = "conducta"; "ansiedad" = "trastornos de ansiedad"; "problemas para dormir" = "trastornos del sueño"). NO vale generalizar de más ni inferir por cercanía temática (ej: "ansiedad" NO habilita a alguien especializado solo en "duelo", "conducta" NO habilita a alguien especializado solo en "vínculos familiares" si no trata conducta puntualmente). Ante la duda entre incluir o no, no incluyas. Esta regla aplica para TODAS las búsquedas sin excepción. NO importa el porcentaje de match ni la experiencia general — si ni el término ni un sinónimo directo figura en sus campos, NO lo incluyas. Si ningún profesional cumple este criterio, respondé solo con texto amable avisando que no contamos con profesionales especializados en esa área por el momento, sin devolver JSON.
- EXCEPCIÓN — MOTIVOS DE CONSULTA GENERALES EN NIÑOS/ADOLESCENTES: la mayoría de los pedidos para niños/adolescentes son motivos comunes y generales (ej: "problemas de comportamiento en la escuela", "no quiere ir al colegio", "rabietas", "se pelea con los hermanos", "bajo rendimiento escolar", "adaptación a un cambio", "celos", "miedos"), no un diagnóstico específico. Para estos casos generales, el ÚNICO requisito es que el profesional tenga el grupo etario correcto marcado en "edades" — NO exijas ninguna especialización puntual, ni siquiera "Infancia y Adolescentes" en especializaciones: atender esa franja etaria ya es suficiente. Reservá el matching estricto por especialización puntual para pedidos técnicos y específicos: evaluaciones/psicodiagnósticos, TDAH, TEA, fobias específicas, duelo, trastornos alimentarios, adicciones, y similares — ahí sí hace falta la especialización concreta.
- MATCHING ESTRICTO POR EDAD/POBLACIÓN: si la persona busca atención para un niño (o menciona "mi hijo", "mi hija", "nene", "nena", etc.), adolescente, adulto mayor, o menciona la edad del paciente, el profesional SOLO puede incluirse si tiene ese grupo etario EXPLÍCITAMENTE marcado en su campo "edades" (valores posibles: "Niños (4-12)", "Adolescentes (13-17)", "Adultos (18-60)", "Adultos mayores (60+)"). El campo "edades" es la ÚNICA fuente de verdad para esto — NUNCA lo deduzcas de las especializaciones/enfoques. En particular: "Infancia y Adolescentes" como especialización NO significa que el profesional atienda pacientes niños — casi siempre significa que trabaja temas de la infancia (apego, historia, desarrollo) CON PACIENTES ADULTOS. Mismo cuidado con "Familia" o "Vínculos tempranos": son enfoques de trabajo, no garantía de que acepten pacientes niños. Un profesional que solo tiene "Adultos (18-60)" en "edades" NUNCA debe aparecer en una búsqueda para niños o adolescentes, sin importar qué palabras tenga en sus especializaciones ni qué tan alto sea el % de match — la edad del paciente es un filtro duro sobre el campo "edades", no un factor de afinidad textual. Si nadie cumple especialización Y grupo etario a la vez, respondé solo con texto amable avisando que no contamos con profesionales para esa combinación por el momento, sin devolver JSON.
- MATCHING ESTRICTO POR FORMATO DE ATENCIÓN: distinguí quién va a asistir físicamente a la sesión, que es DISTINTO del tema de la consulta. Si la persona busca ayuda PARA SÍ MISMA sobre un tema de pareja, separación o familia (ej: "quiero terapia individual, tengo problemas con mi pareja", "necesito ayuda para procesar mi separación", "quiero ir sola/solo a terapia por temas familiares"), el formato requerido es "Individual" y el profesional debe tener "Psicoterapia individual" en especializaciones. Si busca terapia donde va a asistir junto con su pareja (ej: "queremos hacer terapia de pareja"), el formato es "Pareja" y el profesional debe tener "Terapia de pareja". Si busca terapia familiar conjunta (ej: "buscamos terapia familiar los tres"), el formato es "Familia" y el profesional debe tener "Terapia de Familia". Un profesional que tiene "Terapia de pareja" y/o "Terapia de Familia" pero NO tiene "Psicoterapia individual" en especializaciones NO debe aparecer para un pedido de terapia individual, aunque el tema de la consulta (separación, conflicto de pareja, etc.) coincida — el tema y el formato de sesión son cosas distintas.
- EVALUACIONES Y TESTS: cuando la persona busca un test, evaluación, psicodiagnóstico, apto psicológico, o evaluación de TDAH/TEA/aprendizaje/neuropsicológica, SOLO podés incluir profesionales que tengan explícitamente "Psicodiagnósticos", "Evaluaciones", "Aptos psicológicos", "Neuropsicología" o similar en sus especializaciones. Que un profesional trate o atienda TDAH no significa que haga evaluaciones — son cosas distintas. NO los mezcles.
- EVALUACIÓN MUY ESPECÍFICA SIN ESPECIALISTA EXACTO (ej: evaluación ADOS para autismo, evaluación vocacional puntual, etc.): esta es una EXCEPCIÓN al matching estricto de especialización (no a la de edad/población, que sigue aplicando siempre). Si buscan una evaluación puntual y ningún profesional la tiene marcada textualmente, pero SÍ hay profesionales con "Neuropsicología", "Evaluaciones" o "Psicodiagnósticos" en sus especializaciones Y que atienden el grupo etario correspondiente, mostralos igual — no dejes la búsqueda sin resultados. En el campo "respuesta" aclará que no contás con un especialista puntual en esa evaluación específica por el momento, que estos profesionales realizan evaluaciones neurocognitivas/psicodiagnósticas en general, y recomendá que la persona consulte directamente si abordan ese tipo de evaluación en particular antes de agendar.
- Orden: premium primero, luego gratuito
- Los profesionales "gratuito" NO tienen whatsapp — poné null en ese campo
- Si TODOS los disponibles son "gratuito", devolvé el JSON igual con "solo_gratuitos": true
- NUNCA mezcles texto con el JSON, la respuesta debe ser SOLO el JSON sin nada antes ni después
- NUNCA generes dos JSONs separados en la misma respuesta. Si necesitás corregirte, borrá mentalmente el anterior y generá uno solo al final. Un único bloque JSON, nada más.
- NUNCA escribas frases como "Espera", "Permíteme", "Déjame" seguidas de otro JSON — si vas a mostrar profesionales, hacelo en un solo JSON desde el principio
- color: "sage", "warm" o "purple" según tu criterio
- match: qué tan afín es realmente el profesional a la búsqueda (80-98). El porcentaje debe basarse ÚNICAMENTE en la relevancia de sus especializaciones y enfoques con lo que busca la persona — NO en la cantidad de especializaciones que tiene. Un profesional con pocas especializaciones pero exactas debe recibir igual o más match que uno con muchas especializaciones genéricas.
- Si la persona pide explícitamente un psicólogo (masculino) o una psicóloga (femenino), filtrá los resultados priorizando profesionales del género solicitado. Si no hay suficientes, podés completar con otros aclarando que no encontraste más del género pedido. Si la persona no especifica género, mostrá los más afines sin filtrar.

CONSULTAS SOBRE PRECIO / GRATUITO:
- Si la persona pregunta por psicólogos gratuitos, sin costo, o que no cobren, respondé con un mensaje cálido explicando que Claramente es una plataforma de profesionales que cobran por sus servicios y que no contamos con psicólogos gratuitos. Podés mencionar que los honorarios varían y que puede haber opciones accesibles según cada profesional. No devuelvas JSON en este caso, solo texto.

MENSAJES FUERA DE CONTEXTO:
- Mensajes random: respondé brevemente y redirigí a la búsqueda
- Contención directa: reconocé lo que siente, derivá al profesional indicado
- IA genérica: sos el asistente de Claramente, nada más
- Nunca des consejos terapéuticos ni diagnósticos

Si falta info clave, hacé UNA sola pregunta antes del JSON.`;

// Función para mandar mail al profesional gratuito
async function notificarGratuito(profesional, queryTexto) {
  try {
    // Traer datos actuales del profesional
    const { data: prof } = await supabase
      .from('profesionales')
      .select('ultimo_mail_gratuito, busquedas_semana, inicio_semana')
      .eq('id', profesional.id)
      .single();

    if (!prof) return;

    const ahora = new Date();
    const inicioSemana = prof.inicio_semana ? new Date(prof.inicio_semana) : new Date();
    const diasDesdeInicio = (ahora.getTime() - inicioSemana.getTime()) / (1000 * 60 * 60 * 24);
    const esMismaSemana = diasDesdeInicio < 7;

    if (esMismaSemana) {
      // Sumar al contador de la semana sin mandar mail
      await supabase.from('profesionales')
        .update({ busquedas_semana: (prof.busquedas_semana || 0) + 1 })
        .eq('id', profesional.id);
      console.log(`Búsqueda acumulada para ${profesional.email} — total semana: ${(prof.busquedas_semana || 0) + 1}`);
      return;
    }

    // Pasó una semana — mandar mail con el resumen y resetear contador
    const busquedasAcumuladas = (prof.busquedas_semana || 0) + 1;

    const result = await resend.emails.send({
      from: 'Claramente <soporte@claramentepsi.com>',
      reply_to: 'claramentepsisoporte@gmail.com',
      to: profesional.email,
      subject: `Esta semana apareciste en ${busquedasAcumuladas} búsqueda${busquedasAcumuladas > 1 ? 's' : ''} pero no pudiste ser contactado`,
      html: `
        <div style="font-family: 'DM Sans', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1C2B28;">
          <div style="font-family: Georgia, serif; font-size: 22px; color: #1C2B28; margin-bottom: 24px;">
            clara<span style="color: #4A7C6F; font-style: italic;">mente</span>
          </div>
          <h2 style="font-size: 20px; font-weight: 400; margin-bottom: 12px; font-family: Georgia, serif;">
            Hola ${profesional.nombre},
          </h2>
          <p style="font-size: 15px; line-height: 1.7; color: #6B847E; margin-bottom: 16px;">
            Esta semana apareciste en <strong style="color: #1C2B28;">` + busquedasAcumuladas + ` búsqueda` + (busquedasAcumuladas > 1 ? 's' : '') + `</strong> en Claramente como una de las opciones más afines. La última fue:
          </p>
          <div style="background: #E8F2EF; border-radius: 12px; padding: 16px 20px; margin-bottom: 20px; font-size: 15px; color: #2C5048; font-style: italic;">
            "${queryTexto}"
          </div>
          <p style="font-size: 15px; line-height: 1.7; color: #6B847E; margin-bottom: 24px;">
            Sin embargo, <strong style="color: #1C2B28;">no pudieron contactarte</strong> porque tu perfil está en el plan gratuito y no muestra tu número de WhatsApp.
          </p>
          <p style="font-size: 15px; line-height: 1.7; color: #6B847E; margin-bottom: 28px;">
            Con el plan <strong style="color: #B8860B;">Premium ($32.500/mes)</strong> los pacientes pueden contactarte directamente — y vos aparecés primero cuando sos el match correcto.
          </p>
          <a href="https://claramentepsi.com/login.html" 
             style="display: inline-block; background: #4A7C6F; color: white; padding: 12px 28px; border-radius: 24px; text-decoration: none; font-size: 14px; font-weight: 500;">
            Activar mi plan →
          </a>
          <p style="font-size: 12px; color: #9AAFAA; margin-top: 32px; line-height: 1.6;">
            Claramente · La red de psicólogos de Argentina<br>
            <a href="mailto:claramentepsisoporte@gmail.com" style="color: #9AAFAA;">claramentepsisoporte@gmail.com</a>
          </p>
        </div>
      `
    });
    console.log('Mail enviado a gratuito:', profesional.email, 'result:', JSON.stringify(result));
    // Resetear contador y actualizar timestamp
    await supabase.from('profesionales').update({ 
      ultimo_mail_gratuito: new Date().toISOString(),
      busquedas_semana: 0,
      inicio_semana: new Date().toISOString()
    }).eq('id', profesional.id);
  } catch(e) {
    console.error('Error enviando mail:', e.message, e);
  }
}

// ============================================================
// TRIALS
// ============================================================

// Activar trial para un profesional (llamado desde Supabase SQL o admin)
app.post('/activar-trial', async (req, res) => {
  // Endpoint de uso manual/admin (activar trial a mano para un profesional puntual) —
  // nunca debe ser llamable públicamente, porque de otra forma cualquiera con el id
  // de un profesional (que es público, aparece en las respuestas del chat) podría
  // reactivarse el trial indefinidamente sin pagar.
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id requerido' });
  try {
    const trial_hasta = new Date();
    trial_hasta.setDate(trial_hasta.getDate() + 30); // 30 días
    const { error } = await supabase
      .from('profesionales')
      .update({ trial_hasta: trial_hasta.toISOString(), trial_mail_enviado: false })
      .eq('id', id);
    if (error) throw error;
    res.json({ ok: true, trial_hasta });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Genera un link de pago de MP personalizado para un profesional EXISTENTE
// (a diferencia de /registro-pendiente, que es para altas nuevas).
// Usa el id del profesional como external_reference para que el webhook
// pueda identificarlo y actualizar su plan directamente.
//
// IMPORTANTE: se crea SIN preapproval_plan_id. Usar preapproval_plan_id acá
// requiere pasar un card_token_id ya tokenizado (o sea, vos mismo capturando
// la tarjeta en tu frontend con el SDK de MP) — si no lo tenés, la API tira
// "card_token_id is required". Mandando auto_recurring completo en cambio,
// MP crea una suscripción "sin plan asociado" con status pendiente y devuelve
// un init_point para que el usuario complete el pago en el checkout hosteado.
async function generarLinkUpgrade(profesional) {
  const backUrl = `${process.env.APP_URL || 'https://claramentepsi.com'}/panel.html?upgrade=ok`;

  const preApproval = new PreApproval(mp);
  const subscription = await preApproval.create({
    body: {
      reason: 'Plan Premium - claramentepsi',
      payer_email: profesional.email,
      external_reference: `prof_${profesional.id}`,
      back_url: backUrl,
      status: 'pending',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: PREMIUM_MONTO,
        currency_id: 'ARS',
      },
    }
  });
  console.log(`Suscripción creada (upgrade existente) — email: ${profesional.email}, prof_id: ${profesional.id}, init_point: ${subscription.init_point}, mp_id: ${subscription.id}`);
  return subscription.init_point;
}

// Cron: verificar trials vencidos y mandar mail
async function verificarTrialsVencidos() {
  try {
    const ahora = new Date().toISOString();
    // Buscar profesionales con trial vencido que aún NO fueron notificados
    const { data: vencidos } = await supabase
      .from('profesionales')
      .select('id, nombre, email, trial_hasta, busquedas_semana')
      .lt('trial_hasta', ahora)
      .not('trial_hasta', 'is', null)
      .eq('plan', 'gratuito') // Ya están en gratuito, el trial expiró
      .eq('trial_mail_enviado', false); // Clave: solo los que no recibieron el mail todavía

    if (!vencidos || vencidos.length === 0) return;

    for (const prof of vencidos) {
      const nombre = prof.nombre?.split(' ')[0] || 'Lic.';
      let mpLink = 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=eefad72a6586412e8a74031b80c9ca0b';
      try {
        mpLink = await generarLinkUpgrade(prof); // link personalizado con external_reference
      } catch (e) {
        console.error(`No se pudo generar link personalizado para ${prof.email}, usando link genérico:`, e.message);
      }

      await resend.emails.send({
        from: 'Claramente <hola@claramentepsi.com>',
        to: prof.email,
        subject: 'Tu período de prueba en Claramente terminó',
        html: `
          <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;background:#F7F3EE;padding:32px 20px">
            <div style="background:white;border-radius:16px;padding:36px;border:1px solid #D8E8E4">
              <div style="font-family:Georgia,serif;font-size:22px;color:#1C2B28;margin-bottom:20px">
                clara<span style="color:#4A7C6F;font-style:italic">mente</span>
              </div>
              <p style="font-size:16px;color:#1C2B28;margin-bottom:8px">Hola, ${nombre}.</p>
              <p style="font-size:14px;color:#6B847E;line-height:1.7;margin-bottom:24px">
                Tu mes de prueba en Claramente terminó. Esperamos que hayas podido ver cómo funciona la plataforma y recibido algunas consultas.
              </p>
              <div style="background:#F7F3EE;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center">
                <p style="font-size:13px;color:#6B847E;margin-bottom:4px">Para seguir apareciendo con foto y contacto directo</p>
                <p style="font-size:22px;font-weight:600;color:#B8860B;margin:0">$32.500/mes</p>
                <p style="font-size:11px;color:#B8860B;font-style:italic;margin-top:4px">Precio promocional de lanzamiento</p>
              </div>
              <a href="${mpLink}" style="display:block;text-align:center;background:#4A7C6F;color:white;padding:14px 28px;border-radius:24px;text-decoration:none;font-size:14px;font-weight:500;margin-bottom:16px">
                Activar Plan Premium →
              </a>
              <p style="font-size:12px;color:#9AAFAA;text-align:center;line-height:1.6">
                Si no activás el plan, tu perfil sigue apareciendo en los resultados sin foto ni contacto directo.<br>
                Podés activar Premium desde tu panel cuando quieras.
              </p>
            </div>
          </div>
        `
      });

      // Marcar como notificado para que el próximo cron no lo vuelva a mandar
      await supabase
        .from('profesionales')
        .update({ trial_mail_enviado: true })
        .eq('id', prof.id);

      console.log(`Mail de trial vencido enviado a ${prof.email}`);
    }
  } catch(e) {
    console.error('Error verificando trials:', e.message);
  }
}

// Ejecutar verificación de trials cada 12 horas
setInterval(verificarTrialsVencidos, 12 * 60 * 60 * 1000);

// Formulario de soporte
app.post('/soporte', async (req, res) => {
  const { nombre, email, tipo, mensaje } = req.body;
  if (!nombre || !email || !mensaje) return res.status(400).json({ error: 'Faltan campos requeridos' });
  try {
    await resend.emails.send({
      from: 'Claramente <soporte@claramentepsi.com>',
      to: 'claramentepsisoporte@gmail.com',
      reply_to: email,
      subject: `Consulta de soporte — ${tipo || 'General'} · ${nombre}`,
      html: `
        <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;background:#F7F3EE;padding:32px 20px">
          <div style="background:white;border-radius:16px;padding:36px;border:1px solid #D8E8E4">
            <div style="font-family:Georgia,serif;font-size:22px;color:#1C2B28;margin-bottom:20px">
              clara<span style="color:#4A7C6F;font-style:italic">mente</span> · Soporte
            </div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
              <tr><td style="font-size:12px;color:#9AAFAA;padding:8px 0 2px;text-transform:uppercase;letter-spacing:0.05em">Nombre</td></tr>
              <tr><td style="font-size:14px;color:#1C2B28;padding-bottom:12px;border-bottom:1px solid #D8E8E4">${nombre}</td></tr>
              <tr><td style="font-size:12px;color:#9AAFAA;padding:12px 0 2px;text-transform:uppercase;letter-spacing:0.05em">Email</td></tr>
              <tr><td style="font-size:14px;color:#1C2B28;padding-bottom:12px;border-bottom:1px solid #D8E8E4">${email}</td></tr>
              <tr><td style="font-size:12px;color:#9AAFAA;padding:12px 0 2px;text-transform:uppercase;letter-spacing:0.05em">Tipo de consulta</td></tr>
              <tr><td style="font-size:14px;color:#1C2B28;padding-bottom:12px;border-bottom:1px solid #D8E8E4">${tipo || 'General'}</td></tr>
              <tr><td style="font-size:12px;color:#9AAFAA;padding:12px 0 2px;text-transform:uppercase;letter-spacing:0.05em">Mensaje</td></tr>
              <tr><td style="font-size:14px;color:#1C2B28;line-height:1.6;white-space:pre-wrap">${mensaje}</td></tr>
            </table>
            <p style="font-size:12px;color:#9AAFAA">Podés responder directamente a este mail para contactar a ${nombre}.</p>
          </div>
        </div>
      `
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('Error soporte:', e.message);
    res.status(500).json({ error: 'Error al enviar el mensaje' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Claramente API' });
});

// Detalle extendido de un profesional (bio, enfoques, especializaciones, edades, dias, franjas)
// Se consulta solo cuando el usuario hace click en "Ver más" en una tarjeta
app.get('/profesional/:id/detalle', async (req, res) => {
  const { id } = req.params;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: 'id inválido' });
  }

  try {
    const { data, error } = await supabase
      .from('profesionales')
      .select('id, bio, enfoques, especializaciones, edades, dias, franjas')
      .eq('id', id)
      .eq('activo', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Profesional no encontrado' });
    }

    res.json(data);
  } catch (err) {
    console.error('Error en /profesional/:id:', err.message);
    res.status(500).json({ error: 'Error al obtener detalle' });
  }
});

// Rota el orden de profesionales premium cuyo match esté dentro de un rango cercano (empate),
// para no mostrar siempre al mismo cuando varios son igual de afines.
// Mantiene el orden premium > gratuito, y dentro de cada banda de empate
// prioriza al que menos apareció en la última semana (según vistas_semana).
function rotarPorEmpate(profesionales, rangoEmpate = 10) {
  if (!Array.isArray(profesionales) || profesionales.length <= 1) return profesionales;

  const premium = profesionales.filter(p => p.plan === 'premium');
  const otros = profesionales.filter(p => p.plan !== 'premium');

  const ordenadosPorMatch = [...premium].sort((a, b) => (b.match || 0) - (a.match || 0));
  const bandas = [];
  let bandaActual = [];

  ordenadosPorMatch.forEach((p) => {
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

  // Dentro de cada banda: menos vistas esta semana = aparece primero
  // Si hay empate exacto en vistas, mezclar aleatoriamente
  const mezclados = bandas.flatMap(banda => {
    return [...banda].sort((a, b) => {
      const vistasA = a.vistas_semana || 0;
      const vistasB = b.vistas_semana || 0;
      if (vistasA !== vistasB) return vistasA - vistasB;
      return Math.random() - 0.5;
    });
  });

  return [...mezclados, ...otros];
}


app.post('/chat', limiterChat, async (req, res) => {
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

    const profesionalesLivianos = (profesionales || []).map(p => ({
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

    // Mapa id -> edades / especializaciones, para poder filtrar de forma determinística
    // la respuesta de Claude más abajo, sin depender 100% de que el modelo respete la regla.
    const edadesPorId = {};
    const especializacionesPorId = {};
    (profesionales || []).forEach(p => {
      edadesPorId[p.id] = p.edades || [];
      especializacionesPorId[p.id] = p.especializaciones || [];
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
          const cantidadOriginal = parsed.profesionales.length; // antes de nuestros filtros

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
          }

          // Enriquecer con vistas_semana para la rotación equitativa
          parsed.profesionales = parsed.profesionales.map(p => ({
            ...p,
            vistas_semana: vistasPorProfesional[p.id] || 0
          }));
          // Rotar entre profesionales premium con match cercano (empate de hasta 10 puntos)
          // priorizando al que menos apareció esta semana. Recortar a 3.
          parsed.profesionales = rotarPorEmpate(parsed.profesionales, 10).slice(0, 3);

          // Solo pisamos la respuesta de Claude con nuestro mensaje sintético si HABÍA
          // candidatos reales antes de nuestros filtros y quedaron en cero por su culpa.
          // Si el array ya venía vacío de Claude (ej: está haciendo una pregunta
          // aclaratoria), dejamos su propio texto — no inventamos un motivo que no fue.
          if (cantidadOriginal > 0 && parsed.profesionales.length === 0) {
            if (parsed.edad_requerida) {
              parsed.respuesta = `Por el momento no tenemos profesionales disponibles para ese grupo etario (${parsed.edad_requerida}). Probá contándome otra necesidad, o escribinos más adelante.`;
            } else if (parsed.formato_requerido) {
              parsed.respuesta = `Por el momento no tenemos profesionales que ofrezcan atención en formato ${parsed.formato_requerido.toLowerCase()} para esta consulta. Probá contándome otra necesidad, o escribinos más adelante.`;
            }
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

// Registrar aparición en búsqueda
app.post('/vista', async (req, res) => {
  const { psy_id, query_texto } = req.body;
  if (!psy_id) return res.status(400).json({ error: 'psy_id requerido' });
  try {
    await supabase.from('vistas').insert({ psy_id });

    // IMPORTANTE: nunca confiar en un plan mandado por el frontend para decidir
    // si se manda el mail de "estás en el plan gratuito" — se verifica siempre
    // contra la base de datos, igual que hace /chat (plan real + trial activo).
    const { data: prof } = await supabase
      .from('profesionales')
      .select('email, nombre, id, plan, trial_hasta, ultimo_mail_gratuito, busquedas_semana, inicio_semana')
      .eq('id', psy_id)
      .single();

    if (prof) {
      const enTrialActivo = prof.trial_hasta && new Date(prof.trial_hasta) > new Date();
      const esRealmenteGratuito = prof.plan === 'gratuito' && !enTrialActivo;
      if (esRealmenteGratuito) {
        await notificarGratuito({ ...prof }, query_texto);
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error vista:', error.message);
    res.status(500).json({ error: 'Error al registrar vista' });
  }
});

// Trackear contacto de WhatsApp
app.post('/contacto', async (req, res) => {
  const { psy_id, query_texto, plan } = req.body;
  if (!psy_id) return res.status(400).json({ error: 'psy_id requerido' });
  try {
    await supabase.from('contactos').insert({ psy_id, query_texto });

    // El mail al gratuito se maneja desde /vista

    res.json({ ok: true });
  } catch (error) {
    console.error('Error tracking:', error.message);
    res.status(500).json({ error: 'Error al registrar contacto' });
  }
});

// Enviar mail de verificación de email
app.post('/verificar-email', async (req, res) => {
  const { email, datos } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  try {
    // Verificar que no esté ya registrado
    const { data: existe } = await supabase
      .from('profesionales')
      .select('id')
      .eq('email', email)
      .single();
    if (existe) return res.status(400).json({ error: 'Este email ya está registrado.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 horas

    // Guardar o actualizar verificación pendiente
    await supabase.from('email_verifications').upsert({ email, token, datos, verified: false, expires_at }, { onConflict: 'email' });

    const verifyUrl = `${process.env.APP_URL || 'https://claramentepsi.com'}/confirmar-email?token=${token}`;

    await resend.emails.send({
      from: 'Claramente <soporte@claramentepsi.com>',
      reply_to: 'claramentepsisoporte@gmail.com',
      to: email,
      subject: 'Confirmá tu email para unirte a Claramente',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1C2B28;">
          <div style="font-family: Georgia, serif; font-size: 22px; margin-bottom: 24px;">
            clara<span style="color: #4A7C6F; font-style: italic;">mente</span>
          </div>
          <h2 style="font-size: 20px; font-weight: 400; margin-bottom: 12px; font-family: Georgia, serif;">
            Confirma tu email
          </h2>
          <p style="font-size: 15px; line-height: 1.7; color: #6B847E; margin-bottom: 24px;">
            Hacé click en el botón para confirmar tu email y continuar con el registro en Claramente.
          </p>
          <a href="${verifyUrl}" style="display:inline-block;background:#4A7C6F;color:white;padding:12px 28px;border-radius:24px;text-decoration:none;font-size:14px;font-weight:500;">
            Confirmar email →
          </a>
          <p style="font-size:13px;color:#9AAFAA;margin-top:24px;">
            Este link expira en 24 horas. Si no creaste una cuenta en Claramente, ignorá este mail.
          </p>
        </div>
      `
    });

    res.json({ ok: true });
  } catch(e) {
    console.error('Error verificar email:', e.message);
    res.status(500).json({ error: 'Error al enviar verificación' });
  }
});

// Confirmar email y retomar registro
app.get('/confirmar-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/claramentepsi-registro-profesional.html');
  try {
    const { data: ver } = await supabase
      .from('email_verifications')
      .select('*')
      .eq('token', token)
      .single();

    if (!ver) return res.redirect('/claramentepsi-registro-profesional.html?error=token-invalido');
    if (new Date(ver.expires_at) < new Date()) return res.redirect('/claramentepsi-registro-profesional.html?error=token-expirado');

    await supabase.from('email_verifications').update({ verified: true }).eq('token', token);

    // Redirigir al registro con los datos del paso 1 encoded
    const datos = encodeURIComponent(JSON.stringify(ver.datos));
    res.redirect(`/claramentepsi-registro-profesional.html?verified=true&datos=${datos}`);
  } catch(e) {
    console.error('Error confirmar email:', e.message);
    res.redirect('/claramentepsi-registro-profesional.html?error=error');
  }
});

// Solicitar recuperación de contraseña
app.post('/recuperar-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  try {
    const { data: prof } = await supabase
      .from('profesionales')
      .select('id, nombre, email')
      .eq('email', email)
      .single();

    // Siempre respondemos ok para no revelar si el email existe
    if (!prof) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora

    await supabase.from('password_resets').insert({ email, token, expires_at });

    const resetUrl = `${process.env.APP_URL || 'https://claramentepsi.com'}/reset-password.html?token=${token}`;

    await resend.emails.send({
      from: 'Claramente <soporte@claramentepsi.com>',
      reply_to: 'claramentepsisoporte@gmail.com',
      to: email,
      subject: 'Recuperá tu contraseña de Claramente',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; color: #1C2B28;">
          <div style="font-family: Georgia, serif; font-size: 22px; color: #1C2B28; margin-bottom: 24px;">
            clara<span style="color: #4A7C6F; font-style: italic;">mente</span>
          </div>
          <h2 style="font-size: 20px; font-weight: 400; margin-bottom: 12px; font-family: Georgia, serif;">
            Hola ${prof.nombre},
          </h2>
          <p style="font-size: 15px; line-height: 1.7; color: #6B847E; margin-bottom: 24px;">
            Recibimos una solicitud para recuperar tu contraseña. Hacé click en el botón para crear una nueva.
          </p>
          <a href="${resetUrl}" 
             style="display: inline-block; background: #4A7C6F; color: white; padding: 12px 28px; border-radius: 24px; text-decoration: none; font-size: 14px; font-weight: 500;">
            Crear nueva contraseña →
          </a>
          <p style="font-size: 13px; color: #9AAFAA; margin-top: 24px; line-height: 1.6;">
            Este link expira en 1 hora. Si no solicitaste esto, ignorá este mail.
          </p>
          <p style="font-size: 12px; color: #9AAFAA; margin-top: 16px;">
            Claramente · <a href="mailto:claramentepsisoporte@gmail.com" style="color: #9AAFAA;">claramentepsisoporte@gmail.com</a>
          </p>
        </div>
      `
    });

    res.json({ ok: true });
  } catch(e) {
    console.error('Error recuperar password:', e.message);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
});

// Resetear contraseña con token
app.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token y contraseña requeridos' });
  try {
    const { data: reset } = await supabase
      .from('password_resets')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (!reset) return res.status(400).json({ error: 'Token inválido o expirado' });
    if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ error: 'El link expiró. Solicitá uno nuevo.' });

    const password_hash = await bcrypt.hash(password, 10);
    await supabase.from('profesionales').update({ password_hash }).eq('email', reset.email);
    await supabase.from('password_resets').update({ used: true }).eq('token', token);

    res.json({ ok: true });
  } catch(e) {
    console.error('Error reset password:', e.message);
    res.status(500).json({ error: 'Error al actualizar la contraseña' });
  }
});

// Cambiar contraseña desde el panel (requiere contraseña actual)
app.post('/cambiar-password', async (req, res) => {
  const { email, passwordActual, passwordNueva } = req.body;
  if (!email || !passwordActual || !passwordNueva) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }
  if (passwordNueva.length < 8) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  }
  try {
    const { data, error } = await supabase
      .from('profesionales')
      .select('password_hash')
      .eq('email', email)
      .eq('activo', true)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Profesional no encontrado' });

    const ok = await bcrypt.compare(passwordActual, data.password_hash);
    if (!ok) return res.status(401).json({ error: 'La contraseña actual es incorrecta' });

    const password_hash = await bcrypt.hash(passwordNueva, 10);
    await supabase.from('profesionales').update({ password_hash }).eq('email', email);

    res.json({ ok: true });
  } catch (e) {
    console.error('Error cambiar-password:', e.message);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
});

// Verificar si email ya existe
app.get('/check-email', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ exists: false });
  try {
    const { data } = await supabase
      .from('profesionales')
      .select('id')
      .eq('email', email)
      .single();
    res.json({ exists: !!data });
  } catch(e) {
    res.json({ exists: false });
  }
});

// Registrar profesional
app.post('/registro', async (req, res) => {
  const { nombre, matricula, email, whatsapp, password, bio, ciudad, localidad, genero, experiencia,
    honorario, obras_sociales, enfoques, especializaciones, modalidades, edades,
    dias, franjas, plan } = req.body;

  if (!nombre || !email || !password || !whatsapp) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    const password_hash = await bcrypt.hash(password, 10);

    // Todo profesional nuevo arranca con 30 días de trial Premium gratis,
    // sin importar que haya elegido "gratuito" en el form — es la forma en la
    // que ofrecemos la prueba. El cron de verificarTrialsVencidos ya sabe
    // avisar por mail cuando este trial expira y volver a tratarlo como
    // gratuito real a partir de ahí.
    const trial_hasta = new Date();
    trial_hasta.setDate(trial_hasta.getDate() + 30);

    const { data, error } = await supabase.from('profesionales').insert({
      nombre, matricula, email, whatsapp, password_hash, bio, ciudad, localidad, genero,
      experiencia, honorario, obras_sociales, enfoques, especializaciones,
      modalidades, edades, dias, franjas,
      plan: plan || 'gratuito',
      trial_hasta: trial_hasta.toISOString(),
      activo: true
    }).select().single();

    if (error) throw error;
    const { password_hash: _ph, ...profesional } = data;
    res.json({ ok: true, profesional });
  } catch (error) {
    console.error('Error registro:', error.message);
    if (error.message.includes('unique')) {
      return res.status(400).json({ error: 'Ese email ya está registrado' });
    }
    res.status(500).json({ error: 'Error al registrar profesional' });
  }
});

// Login profesional
app.post('/login', limiterLogin, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  try {
    const { data, error } = await supabase
      .from('profesionales')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !data) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    const ok = await bcrypt.compare(password, data.password_hash);
    if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    const { password_hash, ...profesional } = data;
    
    // Si tiene trial activo, devolver plan como premium
    if (profesional.trial_hasta && new Date(profesional.trial_hasta) > new Date()) {
      profesional.plan = 'premium';
      profesional.es_trial = true;
    }
    
    res.json({ ok: true, profesional });
  } catch (error) {
    console.error('Error login:', error.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// Upload foto de perfil
app.post('/upload-foto', upload.single('foto'), async (req, res) => {
  const { psy_id } = req.body;
  console.log('upload-foto: psy_id=', psy_id, 'file=', req.file?.originalname, 'size=', req.file?.size);
  if (!req.file || !psy_id) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const ext = req.file.mimetype.split('/')[1] || 'jpg';
    const filename = `fotos/${psy_id}.${ext}`;
    console.log('upload-foto: subiendo a storage como', filename);
    
    const { error: uploadError } = await supabase.storage
      .from('claramente')
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });
    
    if (uploadError) {
      console.error('upload-foto: error en storage:', JSON.stringify(uploadError));
      throw uploadError;
    }

    const { data: { publicUrl } } = supabase.storage
      .from('claramente')
      .getPublicUrl(filename);

    console.log('upload-foto: publicUrl=', publicUrl);

    const { error: updateError } = await supabase
      .from('profesionales')
      .update({ foto_url: publicUrl })
      .eq('id', psy_id);

    if (updateError) {
      console.error('upload-foto: error actualizando profesional:', JSON.stringify(updateError));
      throw updateError;
    }

    console.log('upload-foto: OK, foto guardada');
    res.json({ ok: true, foto_url: publicUrl });
  } catch(e) {
    console.error('Error upload foto:', e.message, JSON.stringify(e));
    res.status(500).json({ error: 'Error al subir foto', detalle: e.message });
  }
});

// Actualizar perfil del profesional
app.get('/profesional/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('profesionales')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'No encontrado' });
    const { password_hash, ...profesional } = data;
    // Si tiene trial activo, devolver plan como premium
    if (profesional.trial_hasta && new Date(profesional.trial_hasta) > new Date()) {
      profesional.plan = 'premium';
      profesional.es_trial = true;
    }
    res.json(profesional);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/profesional/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, whatsapp, ciudad, localidad, honorario, bio, enfoques, especializaciones, modalidades, obras_sociales, foto_url, genero } = req.body;
  try {
    const updateData = { nombre, whatsapp, ciudad, localidad, honorario, bio, enfoques, especializaciones, modalidades, obras_sociales, genero };
    if (foto_url !== undefined) updateData.foto_url = foto_url;
    const { error } = await supabase
      .from('profesionales')
      .update(updateData)
      .eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error('Error update:', error.message);
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// Estadísticas del profesional
app.get('/stats/:psy_id', async (req, res) => {
  const { psy_id } = req.params;
  try {
    const [{ count: contactos }, { count: vistas }] = await Promise.all([
      supabase.from('contactos').select('*', { count: 'exact', head: true }).eq('psy_id', psy_id),
      supabase.from('vistas').select('*', { count: 'exact', head: true }).eq('psy_id', psy_id)
    ]);

    // Datos semanales para gráficos (últimas 8 semanas)
    const hace8semanas = new Date();
    hace8semanas.setDate(hace8semanas.getDate() - 56);

    const [{ data: contactosSemana }, { data: vistasSemana }] = await Promise.all([
      supabase.from('contactos').select('created_at').eq('psy_id', psy_id).gte('created_at', hace8semanas.toISOString()),
      supabase.from('vistas').select('created_at').eq('psy_id', psy_id).gte('created_at', hace8semanas.toISOString())
    ]);

    // Agrupar por semana
    const agruparPorSemana = (registros) => {
      const semanas = {};
      (registros || []).forEach(r => {
        const fecha = new Date(r.created_at);
        const inicioSemana = new Date(fecha);
        inicioSemana.setDate(fecha.getDate() - fecha.getDay());
        const key = inicioSemana.toISOString().split('T')[0];
        semanas[key] = (semanas[key] || 0) + 1;
      });
      return semanas;
    };

    res.json({
      contactos,
      vistas,
      grafico: {
        contactos: agruparPorSemana(contactosSemana),
        vistas: agruparPorSemana(vistasSemana)
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Guardar registro pendiente y generar link de pago via API de MP
app.post('/registro-pendiente', async (req, res) => {
  const { datos, plan } = req.body;
  if (!datos || !plan) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const session_id = crypto.randomUUID();

    // Guardar en Supabase
    const { error } = await supabase
      .from('registros_pendientes')
      .insert({ session_id, datos, plan });
    if (error) throw error;

    const backUrl = `${process.env.APP_URL || 'https://claramentepsi.com'}/pago-exitoso.html?session_id=${session_id}`;

    // Crear suscripción via API de MP con external_reference.
    // Sin preapproval_plan_id (ver nota en generarLinkUpgrade): con auto_recurring
    // completo, MP devuelve un init_point de checkout hosteado sin necesitar
    // un card_token_id tokenizado de antemano.
    const preApproval = new PreApproval(mp);
    const subscription = await preApproval.create({
      body: {
        reason: 'Plan Premium - claramentepsi',
        payer_email: datos.email,
        external_reference: session_id,
        back_url: backUrl,
        status: 'pending',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: PREMIUM_MONTO,
          currency_id: 'ARS',
        },
      }
    });

    console.log(`Suscripción creada (alta nueva) — email: ${datos.email}, session_id: ${session_id}, init_point: ${subscription.init_point}, mp_id: ${subscription.id}`);

    res.json({ ok: true, session_id, init_point: subscription.init_point });
  } catch (e) {
    console.error('Error registro pendiente:', e.message);
    res.status(500).json({ error: 'Error al generar link de pago: ' + e.message });
  }
});

// Generar link de pago para un profesional YA EXISTENTE que quiere pasar a Premium
// (botón "Actualizar plan" del panel — pestaña Plan). Usar este endpoint en vez de
// linkear directamente al checkout de MP, para que el webhook pueda identificar
// a qué profesional corresponde el pago.
app.post('/generar-link-premium', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email requerido' });
  try {
    const { data: profesional, error } = await supabase
      .from('profesionales')
      .select('id, email, plan')
      .eq('email', email)
      .eq('activo', true)
      .single();

    if (error || !profesional) return res.status(404).json({ error: 'Profesional no encontrado' });
    if (profesional.plan === 'premium') return res.status(400).json({ error: 'Ya tenés el plan Premium activo' });

    const init_point = await generarLinkUpgrade(profesional);
    res.json({ ok: true, init_point });
  } catch (e) {
    console.error('Error generando link de upgrade:', e.message);
    res.status(500).json({ error: 'Error al generar link de pago: ' + e.message });
  }
});

// Verificar firma del webhook de MP
function verificarFirmaMP(req) {
  try {
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) return true; // Si no hay secret configurado, dejar pasar
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    if (!xSignature) return false;
    const parts = xSignature.split(',');
    let ts, hash;
    parts.forEach(part => {
      const [key, val] = part.trim().split('=');
      if (key === 'ts') ts = val;
      if (key === 'v1') hash = val;
    });
    const dataId = req.query?.['data.id'] || req.body?.data?.id || '';
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expectedHash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    return hash === expectedHash;
  } catch(e) {
    return true; // En caso de error, dejar pasar
  }
}

// Webhook de MercadoPago
app.post('/webhook/mp', async (req, res) => {
  if (!verificarFirmaMP(req)) return res.sendStatus(401);
  try {
    const { type, data } = req.body;
    if (type !== 'payment' && type !== 'preapproval') return res.sendStatus(200);

    const paymentId = data?.id;
    if (!paymentId) return res.sendStatus(200);

    // Verificar el pago con la API de MP
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    const payment = await mpRes.json();

    if (payment.status !== 'approved') return res.sendStatus(200);

    const session_id = payment.external_reference;
    if (!session_id) return res.sendStatus(200);

    // Buscar el registro pendiente
    const { data: pendiente } = await supabase
      .from('registros_pendientes')
      .select('*')
      .eq('session_id', session_id)
      .single();

    if (!pendiente) return res.sendStatus(200);

    // Crear el profesional
    const d = pendiente.datos;
    const password_hash = await bcrypt.hash(d.password, 10);
    await supabase.from('profesionales').insert({
      nombre: d.nombre, matricula: d.matricula, email: d.email,
      whatsapp: d.whatsapp, password_hash, bio: d.bio || '',
      ciudad: d.ciudad || '', experiencia: d.experiencia || null,
      honorario: d.honorario || null, obras_sociales: d.obras_sociales || [],
      enfoques: d.enfoques || [], especializaciones: d.especializaciones || [],
      modalidades: d.modalidades || [], edades: d.edades || [],
      dias: d.dias || [], franjas: d.franjas || [],
      plan: pendiente.plan, activo: true,
      plan_activo_desde: new Date().toISOString()
    });

    // Borrar el registro pendiente
    await supabase.from('registros_pendientes').delete().eq('session_id', session_id);

    res.sendStatus(200);
  } catch (e) {
    console.error('Error webhook MP:', e.message);
    res.sendStatus(500);
  }
});

// Webhook de suscripciones de MP (preapproval)
app.post('/webhook/mp-sub', async (req, res) => {
  if (!verificarFirmaMP(req)) return res.sendStatus(401);
  try {
    const { type, data } = req.body;
    const resourceId = data?.id;
    if (!resourceId) return res.sendStatus(200);

    let external_ref = null;

    if (type === 'preapproval') {
      // Suscripciones creadas con preapproval_plan_id (flujo viejo/alternativo)
      const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${resourceId}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const sub = await mpRes.json();
      if (sub.status === 'authorized') external_ref = sub.external_reference;

    } else if (type === 'payment') {
      // Suscripciones "sin plan asociado" (auto_recurring) — el cobro real avisa
      // por acá, con action payment.created/payment.updated, no por preapproval.
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${resourceId}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const pago = await mpRes.json();
      if (pago.status === 'approved') external_ref = pago.external_reference;

    } else {
      return res.sendStatus(200); // otro tipo de evento, lo ignoramos
    }

    if (!external_ref) return res.sendStatus(200);

    // Caso 1: upgrade de un profesional YA EXISTENTE (link generado por generarLinkUpgrade)
    if (external_ref.startsWith('prof_')) {
      const profesionalId = external_ref.replace('prof_', '');
      const { error: updateError } = await supabase
        .from('profesionales')
        .update({ plan: 'premium', plan_activo_desde: new Date().toISOString() })
        .eq('id', profesionalId);
      if (updateError) console.error('Error actualizando plan de profesional existente:', updateError.message);
      else console.log(`Plan actualizado a premium para profesional existente (${type}): ${profesionalId}`);
      return res.sendStatus(200);
    }

    // Caso 2: alta nueva (viene de /registro-pendiente)
    const session_id = external_ref;

    const { data: pendiente } = await supabase
      .from('registros_pendientes')
      .select('*')
      .eq('session_id', session_id)
      .single();

    if (!pendiente) return res.sendStatus(200);

    const d = pendiente.datos;
    const password_hash = await bcrypt.hash(d.password, 10);
    await supabase.from('profesionales').insert({
      nombre: d.nombre, matricula: d.matricula, email: d.email,
      whatsapp: d.whatsapp, password_hash, bio: d.bio || '',
      ciudad: d.ciudad || '', experiencia: d.experiencia || null,
      honorario: d.honorario || null, obras_sociales: d.obras_sociales || [],
      enfoques: d.enfoques || [], especializaciones: d.especializaciones || [],
      modalidades: d.modalidades || [], edades: d.edades || [],
      dias: d.dias || [], franjas: d.franjas || [],
      plan: pendiente.plan, activo: true,
      plan_activo_desde: new Date().toISOString()
    });

    await supabase.from('registros_pendientes').delete().eq('session_id', session_id);
    res.sendStatus(200);
  } catch (e) {
    console.error('Error webhook MP sub:', e.message);
    res.sendStatus(500);
  }
});

// Verificar estado del pago (el frontend consulta esto después del redirect)
app.get('/verificar-pago', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id requerido' });
  try {
    // Si el registro pendiente ya no existe, el pago fue procesado
    const { data: pendiente } = await supabase
      .from('registros_pendientes')
      .select('id')
      .eq('session_id', session_id)
      .single();

    if (!pendiente) {
      // Buscar el profesional recién creado por email no es posible sin el email
      // Devolvemos ok: true y el frontend redirige al login
      return res.json({ ok: true, procesado: true });
    }
    res.json({ ok: true, procesado: false });
  } catch(e) {
    // Error real — devolver no procesado para que el frontend siga esperando
    console.error('Error verificar-pago:', e.message);
    res.json({ ok: true, procesado: false });
  }
});

app.get('/verificar-email.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'verificar-email.html')));
app.get('/recuperar-password.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recuperar-password.html')));
app.get('/reset-password.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/pago-exitoso.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pago-exitoso.html')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Claramente corriendo en puerto ${PORT}`);
});
