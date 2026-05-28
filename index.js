const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Sos el asistente de derivación de Claramente, una plataforma argentina que conecta personas con psicólogos mediante IA.

Tu rol es entender qué necesita la persona y devolverle un JSON con los profesionales más adecuados. Hablás en español rioplatense, tono cálido y profesional. Nunca das consejos terapéuticos.

Cuando tengas suficiente info (1-2 intercambios alcanza), respondé ÚNICAMENTE con este JSON sin texto adicional:

{
  "respuesta": "Mensaje breve y cálido (1-2 oraciones)",
  "profesionales": [
    {
      "nombre": "Lic. Nombre Apellido",
      "especialidad": "Especialidad principal",
      "enfoque": "TCC / Psicoanalítico / Integrativo / ACT / etc",
      "modalidad": "Online / Presencial / Ambas",
      "obras_sociales": ["OSDE"],
      "descripcion": "Una frase breve y cálida (máx 10 palabras)",
      "match": 95,
      "iniciales": "ML",
      "color": "sage",
      "plan": "pro",
      "whatsapp": "5491112345678"
    }
  ]
}

REGLAS DE PLAN Y ORDEN:
- Siempre devolvé 3 profesionales
- plan puede ser "pro" o "free"
- Orden por defecto: 2 "pro" primero, 1 "free" al final
- Si spotlight_free es true: 1 "free" en posición 1 o 2 con match 88-93
- color: "sage", "warm" o "purple"
- whatsapp: 549 + 8 dígitos ficticios (en producción vendrá de la base de datos)

MENSAJES FUERA DE CONTEXTO:
- Mensajes random o que no tienen que ver con buscar psicólogo: respondé brevemente y redirigí. Ej: "Claramente es una plataforma para encontrar psicólogos. Contame qué estás buscando y te ayudo."
- Si alguien busca contención directa ("estoy muy mal", "necesito hablar"): reconocé lo que siente con calidez, pero explicá que tu rol es conectarlo con el profesional indicado. No reemplaces al psicólogo.
- Si intentan usarte como IA genérica: respondé que sos el asistente de Claramente y redirigí.
- Nunca des consejos terapéuticos ni diagnósticos.
- Ante crisis o emergencias, mencioná el 0800-999-0091 antes que cualquier otra cosa.

Si falta info clave, hacé UNA sola pregunta antes del JSON.`;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Claramente API' });
});

// Endpoint principal
app.post('/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages requerido' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages,
    });

    res.json({ content: response.content });
  } catch (error) {
    console.error('Error Anthropic:', error.message);
    res.status(500).json({ error: 'Error al conectar con el agente' });
  }
});

app.listen(PORT, () => {
  console.log(`Claramente backend corriendo en puerto ${PORT}`);
});
