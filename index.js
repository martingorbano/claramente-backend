const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const { MercadoPagoConfig, PreApprovalPlan, PreApproval } = require('mercadopago');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
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
  origin: ['https://claramentepsi.com', 'https://www.claramentepsi.com', 'https://claramente-backend.onrender.com'],
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
    res.sendFile(path.join(__dirname, 'public', `${area}.html`));
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
      "plan": "premium / flex / gratuito",
      "whatsapp": "numero de whatsapp",
      "ciudad": "ciudad donde atiende (copiala del campo ciudad de la base de datos)",
      "localidad": "localidad donde atiende (copiala del campo localidad de la base de datos, puede ser null)",
      "foto_url": "copiá exactamente el campo foto_url de la base de datos, o null si no tiene"
    }
  ]
}

REGLAS:
- Usá SOLO profesionales de la lista que se te provee
- El campo "id" es OBLIGATORIO — copialo exactamente del campo id de la base de datos sin modificarlo
- El campo "plan" es OBLIGATORIO — copialo exactamente del campo plan que figura en los datos que se te proveen (puede ser "premium" o "gratuito"). Si figura "premium", copiá "premium". NUNCA lo cambies ni lo inventes.
- Mostrá SOLO los datos que realmente existen en el perfil — nunca inventes obras sociales, enfoques ni especializaciones que no estén en los datos
- Si el campo obras_sociales está vacío o es null, no muestres ninguna obra social en la tarjeta
- Si obras_sociales contiene solo "Particular", mostrá el tag como "Solo particular"
- Si obras_sociales contiene "Particular" junto a otras obras sociales, mostrá las obras sociales normalmente sin mencionar "Particular"
- Si el campo enfoques está vacío, no muestres enfoques
- Devolvé MÁXIMO 5 profesionales — los más afines a la búsqueda, ordenados por match descendente. Nunca devuelvas más de 5.
- Si no hay profesionales en la base, avisá amablemente que todavía no hay profesionales disponibles para esa búsqueda
- MATCHING ESTRICTO: solo derivá a un profesional si su campo "especializaciones" o "enfoques" tiene una relación directa y clara con lo que busca la persona. NO derivés a alguien solo porque es el único disponible o porque atiende adultos en general. Si ningún profesional de la base tiene la especialización adecuada para lo que busca la persona, respondé con un mensaje cálido avisando que por el momento no contamos con profesionales especializados en esa área, y sugerí que vuelva a intentar con otra búsqueda o que deje sus datos para cuando sumemos más profesionales. En ese caso NO devuelvas JSON con profesionales.
- Orden: premium primero, luego gratuito
- Los profesionales "gratuito" NO tienen whatsapp — poné null en ese campo
- Si TODOS los disponibles son "gratuito", devolvé el JSON igual con "solo_gratuitos": true — NUNCA mezcles texto con el JSON, la respuesta debe ser SOLO el JSON sin nada antes ni después
- color: "sage", "warm" o "purple" según tu criterio
- match: qué tan afín es realmente el profesional a la búsqueda (80-98)
- Si la persona pide explícitamente un psicólogo (masculino) o una psicóloga (femenino), filtrá los resultados priorizando profesionales del género solicitado. Si no hay suficientes, podés completar con otros aclarando que no encontraste más del género pedido. Si la persona no especifica género, mostrá los más afines sin filtrar.

CONSULTAS SOBRE PRECIO / GRATUITO:
- Si la persona pregunta por psicólogos gratuitos, sin costo, o que no cobren, respondé con un mensaje cálido explicando que Claramente es una plataforma de profesionales que cobran por sus servicios y que no contamos con psicólogos gratuitos. Podés mencionar que los honorarios varían y que puede haber opciones accesibles según cada profesional. No devuelvas JSON en este caso, solo texto.

MENSAJES FUERA DE CONTEXTO:
- Mensajes random: respondé brevemente y redirigí a la búsqueda
- Contención directa: reconocé lo que siente, derivá al profesional indicado
- IA genérica: sos el asistente de Claramente, nada más
- Crisis: mencioná el 0800-999-0091 antes que cualquier otra cosa
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
            Con el plan <strong style="color: #1C2B28;">Flex ($32.500/mes)</strong> o <strong style="color: #B8860B;">Premium ($32.500/mes)</strong> los pacientes pueden contactarte directamente — y vos aparecés primero cuando sos el match correcto.
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
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id requerido' });
  try {
    const trial_hasta = new Date();
    trial_hasta.setDate(trial_hasta.getDate() + 30); // 30 días
    const { error } = await supabase
      .from('profesionales')
      .update({ trial_hasta: trial_hasta.toISOString() })
      .eq('id', id);
    if (error) throw error;
    res.json({ ok: true, trial_hasta });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Cron: verificar trials vencidos y mandar mail
async function verificarTrialsVencidos() {
  try {
    const ahora = new Date().toISOString();
    // Buscar profesionales con trial vencido que aún no fueron notificados
    const { data: vencidos } = await supabase
      .from('profesionales')
      .select('id, nombre, email, trial_hasta, busquedas_semana')
      .lt('trial_hasta', ahora)
      .not('trial_hasta', 'is', null)
      .eq('plan', 'gratuito'); // Ya están en gratuito, el trial expiró

    if (!vencidos || vencidos.length === 0) return;

    for (const prof of vencidos) {
      // Verificar que no le hayamos mandado el mail ya (limpiar trial_hasta después de notificar)
      const trialFecha = new Date(prof.trial_hasta);
      const diasVencido = Math.floor((new Date() - trialFecha) / (1000 * 60 * 60 * 24));
      
      // Solo mandar mail el primer día que vence
      if (diasVencido > 1) continue;

      const nombre = prof.nombre?.split(' ')[0] || 'Lic.';
      const mpLink = 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=eefad72a6586412e8a74031b80c9ca0b';

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
// Mantiene el orden premium > gratuito, solo mezcla DENTRO de cada banda de empate.
function rotarPorEmpate(profesionales, rangoEmpate = 10) {
  if (!Array.isArray(profesionales) || profesionales.length <= 1) return profesionales;

  const premium = profesionales.filter(p => p.plan === 'premium');
  const otros = profesionales.filter(p => p.plan !== 'premium');

  // Agrupar premium en bandas: mientras la diferencia de match con el primero de la banda
  // sea <= rangoEmpate, pertenecen a la misma banda.
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

  // Mezclar aleatoriamente dentro de cada banda (Fisher-Yates simple)
  const mezclados = bandas.flatMap(banda => {
    const copia = [...banda];
    for (let i = copia.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copia[i], copia[j]] = [copia[j], copia[i]];
    }
    return copia;
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

  try {
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
      dias: p.dias,
      franjas: p.franjas,
      foto_url: p.foto_url,
      plan: p.plan,
      genero: p.genero,
      bio_resumen: (p.bio || '').slice(0, 150) // recorte corto solo para que Claude entienda el perfil
    }));

    const listaProfesionales = profesionalesLivianos.length > 0
      ? `\n\nPROFESIONALES DISPONIBLES EN LA BASE DE DATOS:\n${JSON.stringify(profesionalesLivianos, null, 2)}`
      : '\n\nNo hay profesionales cargados en la base de datos todavía.';

    // Inyectar lista en el último mensaje
    const messagesConBase = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: m.content + listaProfesionales }
        : m
    );

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: messagesConBase,
    });

    const rawText = response.content?.[0]?.text || '';
    console.log('RAW RESPONSE:', rawText.substring(0, 300));
    
    // Intentar extraer y limpiar JSON del texto
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const jsonStr = firstBrace !== -1 && lastBrace !== -1 ? cleaned.substring(firstBrace, lastBrace + 1) : null;
    const jsonMatch = jsonStr ? [jsonStr] : null;
    
    // Obtener el último mensaje del usuario
    const ultimoMensaje = messages[messages.length - 1]?.content || '';

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.profesionales) {
          // Rotar entre profesionales premium con match cercano (empate de hasta 10 puntos)
          // para no mostrar siempre al mismo cuando varios son igual de afines.
          // Claude devuelve hasta 5 candidatos; acá rotamos y nos quedamos con los 3 finales a mostrar.
          parsed.profesionales = rotarPorEmpate(parsed.profesionales, 10).slice(0, 3);

          // Guardar consulta en Supabase
          supabase.from('consultas').insert({
            mensaje: ultimoMensaje,
            respuesta: parsed.mensaje || null,
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
            supabase.from('consultas').insert({
              mensaje: ultimoMensaje,
              respuesta: parsed2.mensaje || null,
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

    res.json({ content: response.content });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Error al conectar con el agente' });
  }
});

// Registrar aparición en búsqueda
app.post('/vista', async (req, res) => {
  const { psy_id, query_texto, plan } = req.body;
  if (!psy_id) return res.status(400).json({ error: 'psy_id requerido' });
  try {
    await supabase.from('vistas').insert({ psy_id });

    // Si es gratuito, manejar el mail semanal
    if (plan === 'gratuito') {
      const { data: prof } = await supabase
        .from('profesionales')
        .select('email, nombre, id, ultimo_mail_gratuito, busquedas_semana, inicio_semana')
        .eq('id', psy_id)
        .single();
      if (prof) await notificarGratuito({ ...prof }, query_texto);
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
    const { data, error } = await supabase.from('profesionales').insert({
      nombre, matricula, email, whatsapp, password_hash, bio, ciudad, localidad, genero,
      experiencia, honorario, obras_sociales, enfoques, especializaciones,
      modalidades, edades, dias, franjas,
      plan: plan || 'gratuito',
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

    // IDs de los planes en MP
    const planIds = {
      premium: 'eefad72a6586412e8a74031b80c9ca0b'
    };

    const backUrl = `${process.env.APP_URL || 'https://claramente-backend.onrender.com'}/pago-exitoso.html?session_id=${session_id}`;

    // Crear suscripción via API de MP con external_reference
    const preApproval = new PreApproval(mp);
    const subscription = await preApproval.create({
      body: {
        preapproval_plan_id: planIds[plan],
        payer_email: datos.email,
        external_reference: session_id,
        back_url: backUrl,
      }
    });

    res.json({ ok: true, session_id, init_point: subscription.init_point });
  } catch (e) {
    console.error('Error registro pendiente:', e.message);
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
    if (type !== 'preapproval') return res.sendStatus(200);

    const subId = data?.id;
    if (!subId) return res.sendStatus(200);

    const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${subId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    const sub = await mpRes.json();

    if (sub.status !== 'authorized') return res.sendStatus(200);

    const session_id = sub.external_reference;
    if (!session_id) return res.sendStatus(200);

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
