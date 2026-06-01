const express = require('express');
const crypto = require('crypto');
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
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SYSTEM_PROMPT = `Sos el asistente de derivación de Claramente, una plataforma argentina que conecta personas con psicólogos mediante IA.

Tu rol es entender qué necesita la persona y devolverle un JSON con los profesionales más adecuados de la base de datos real que se te provee. Hablás en español rioplatense, tono cálido y profesional. Nunca das consejos terapéuticos.

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
      "ciudad": "ciudad donde atiende (copiala del campo ciudad de la base de datos)"
    }
  ]
}

REGLAS:
- Usá SOLO profesionales de la lista que se te provee
- El campo "id" es OBLIGATORIO — copialo exactamente del campo id de la base de datos sin modificarlo
- El campo "plan" es OBLIGATORIO — copialo exactamente del campo plan de la base de datos (puede ser "premium", "flex" o "gratuito") — NUNCA lo cambies ni lo inventes
- Mostrá SOLO los datos que realmente existen en el perfil — nunca inventes obras sociales, enfoques ni especializaciones que no estén en los datos
- Si el campo obras_sociales está vacío o es null, no muestres ninguna obra social en la tarjeta
- Si obras_sociales contiene solo "Particular", mostrá el tag como "Solo particular"
- Si obras_sociales contiene "Particular" junto a otras obras sociales, mostrá las obras sociales normalmente sin mencionar "Particular"
- Si el campo enfoques está vacío, no muestres enfoques
- Si no hay profesionales en la base, avisá amablemente que todavía no hay profesionales disponibles para esa búsqueda
- Orden: premium primero, luego flex, luego gratuito
- Los profesionales "gratuito" NO tienen whatsapp — poné null en ese campo
- Si TODOS los disponibles son "gratuito", devolvé el JSON igual con "solo_gratuitos": true — NUNCA mezcles texto con el JSON, la respuesta debe ser SOLO el JSON sin nada antes ni después
- color: "sage", "warm" o "purple" según tu criterio
- match: qué tan afín es realmente el profesional a la búsqueda (80-98)

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
            Con el plan <strong style="color: #1C2B28;">Flex ($59.900/mes)</strong> o <strong style="color: #B8860B;">Premium ($79.900/mes)</strong> los pacientes pueden contactarte directamente — y vos aparecés primero cuando sos el match correcto.
          </p>
          <a href="https://claramente-backend.onrender.com/login.html" 
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Claramente API' });
});

// Chat con agente
app.post('/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages requerido' });
  }

  try {
    // Traer profesionales activos de Supabase
    const { data: profesionales } = await supabase
      .from('profesionales')
      .select('id, nombre, matricula, whatsapp, bio, ciudad, experiencia, honorario, obras_sociales, enfoques, especializaciones, modalidades, edades, dias, franjas, foto_url, plan')
      .eq('activo', true)
      .order('plan', { ascending: false }); // premium > flex > gratuito

    const listaProfesionales = profesionales && profesionales.length > 0
      ? `\n\nPROFESIONALES DISPONIBLES EN LA BASE DE DATOS:\n${JSON.stringify(profesionales, null, 2)}`
      : '\n\nNo hay profesionales cargados en la base de datos todavía.';

    // Inyectar lista en el último mensaje
    const messagesConBase = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: m.content + listaProfesionales }
        : m
    );

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
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
    
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.profesionales) {
          // Devolver solo el JSON limpio
          return res.json({ 
            content: [{ type: 'text', text: JSON.stringify(parsed) }] 
          });
        }
      } catch(e) {}
    }

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

    const verifyUrl = `${process.env.APP_URL || 'https://claramente-backend.onrender.com'}/confirmar-email?token=${token}`;

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

    const resetUrl = `${process.env.APP_URL || 'https://claramente-backend.onrender.com'}/reset-password.html?token=${token}`;

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
  const { nombre, matricula, email, whatsapp, password, bio, ciudad, experiencia,
    honorario, obras_sociales, enfoques, especializaciones, modalidades, edades,
    dias, franjas, plan } = req.body;

  if (!nombre || !email || !password || !whatsapp) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('profesionales').insert({
      nombre, matricula, email, whatsapp, password_hash, bio, ciudad,
      experiencia, honorario, obras_sociales, enfoques, especializaciones,
      modalidades, edades, dias, franjas,
      plan: plan || 'gratuito',
      activo: true
    }).select().single();

    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (error) {
    console.error('Error registro:', error.message);
    if (error.message.includes('unique')) {
      return res.status(400).json({ error: 'Ese email ya está registrado' });
    }
    res.status(500).json({ error: 'Error al registrar profesional' });
  }
});

// Login profesional
app.post('/login', async (req, res) => {
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
    res.json({ ok: true, profesional });
  } catch (error) {
    console.error('Error login:', error.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// Actualizar perfil del profesional
app.put('/profesional/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, whatsapp, ciudad, honorario, bio, enfoques, especializaciones, modalidades, obras_sociales } = req.body;
  try {
    const { error } = await supabase
      .from('profesionales')
      .update({ nombre, whatsapp, ciudad, honorario, bio, enfoques, especializaciones, modalidades, obras_sociales })
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
      premium: '7cd85b4484f942e2a500303ce9a4f434',
      flex: '7b2754ae1b744bdc85d1f828c778f6be'
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
    // Si no encuentra el registro pendiente (error de single()), está procesado
    res.json({ ok: true, procesado: true });
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
