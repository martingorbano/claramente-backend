// Endpoints administrativos / de soporte / misceláneos de bajo tráfico.
// Extraído de index.js al dividir en módulos — sin cambios de comportamiento.
const express = require('express');
const { supabase, resend } = require('../lib/clients');

const router = express.Router();

// Activar trial para un profesional (llamado desde Supabase SQL o admin)
router.post('/activar-trial', async (req, res) => {
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
      .update({ trial_hasta: trial_hasta.toISOString(), trial_mail_enviado: false, recordatorio_enviado: false })
      .eq('id', id);
    if (error) throw error;
    res.json({ ok: true, trial_hasta });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Formulario de soporte
router.post('/soporte', async (req, res) => {
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
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Claramente API' });
});

// Detalle extendido de un profesional (bio, enfoques, especializaciones, edades, dias, franjas)
// Se consulta solo cuando el usuario hace click en "Ver más" en una tarjeta
router.get('/profesional/:id/detalle', async (req, res) => {
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

module.exports = router;
