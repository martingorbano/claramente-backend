const express = require('express');
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
      "id": "uuid del profesional",
      "nombre": "Lic. Nombre Apellido",
      "especialidad": "Especialidad principal",
      "enfoque": "primer enfoque del profesional",
      "modalidad": "Online / Presencial / Ambas",
      "obras_sociales": ["OSDE"],
      "descripcion": "Una frase breve y cálida (máx 10 palabras)",
      "match": 95,
      "iniciales": "ML",
      "color": "sage",
      "plan": "pro",
      "whatsapp": "numero de whatsapp"
    }
  ]
}

REGLAS:
- Usá SOLO profesionales de la lista que se te provee
- Si no hay profesionales en la base, avisá amablemente que todavía no hay profesionales disponibles para esa búsqueda
- Orden: pro primero, free al final. Si spotlight_free es true: 1 free en posición 1 o 2
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
      .order('plan', { ascending: false }); // pro primero

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
      plan: plan || 'free',
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Claramente corriendo en puerto ${PORT}`);
});
