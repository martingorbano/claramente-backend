const express = require('express');
const crypto = require('crypto');
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
      "whatsapp": "numero de whatsapp"
    }
  ]
}

REGLAS:
- Usá SOLO profesionales de la lista que se te provee
- El campo "id" es OBLIGATORIO — copialo exactamente del campo id de la base de datos sin modificarlo
- Mostrá SOLO los datos que realmente existen en el perfil — nunca inventes obras sociales, enfoques ni especializaciones que no estén en los datos
- Si el campo obras_sociales está vacío o es null, no muestres ninguna obra social en la tarjeta
- Si obras_sociales contiene solo "Particular", mostrá el tag como "Solo particular"
- Si obras_sociales contiene "Particular" junto a otras obras sociales, mostrá las obras sociales normalmente sin mencionar "Particular"
- Si el campo enfoques está vacío, no muestres enfoques
- Si no hay profesionales en la base, avisá amablemente que todavía no hay profesionales disponibles para esa búsqueda
- Orden: premium primero, luego flex, luego gratuito
- Los profesionales "gratuito" NO tienen whatsapp — poné null en ese campo
- Si TODOS los disponibles son "gratuito", devolvé solo 1 con campo "solo_gratuitos": true en el JSON raíz e invitá a ampliar la búsqueda
- color: "sage", "warm" o "purple" según tu criterio
- match: qué tan afín es realmente el profesional a la búsqueda (80-98)

MENSAJES FUERA DE CONTEXTO:
- Mensajes random: respondé brevemente y redirigí a la búsqueda
- Contención directa: reconocé lo que siente, derivá al profesional indicado
- IA genérica: sos el asistente de Claramente, nada más
- Crisis: mencioná el 0800-999-0091 antes que cualquier otra cosa
- Nunca des consejos terapéuticos ni diagnósticos

Si falta info clave, hacé UNA sola pregunta antes del JSON.`;

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

    res.json({ content: response.content });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Error al conectar con el agente' });
  }
});

// Trackear contacto de WhatsApp
app.post('/contacto', async (req, res) => {
  const { psy_id, query_texto } = req.body;
  if (!psy_id) return res.status(400).json({ error: 'psy_id requerido' });
  try {
    await supabase.from('contactos').insert({ psy_id, query_texto });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error tracking:', error.message);
    res.status(500).json({ error: 'Error al registrar contacto' });
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
    res.json({ contactos, vistas });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Guardar registro pendiente (antes del pago)
app.post('/registro-pendiente', async (req, res) => {
  const { datos, plan } = req.body;
  if (!datos || !plan) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const session_id = crypto.randomUUID();
    const { error } = await supabase
      .from('registros_pendientes')
      .insert({ session_id, datos, plan });
    if (error) throw error;
    res.json({ ok: true, session_id });
  } catch (e) {
    console.error('Error registro pendiente:', e.message);
    res.status(500).json({ error: 'Error al guardar registro' });
  }
});

// Webhook de MercadoPago
app.post('/webhook/mp', async (req, res) => {
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

app.get('/pago-exitoso.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pago-exitoso.html')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Claramente corriendo en puerto ${PORT}`);
});
