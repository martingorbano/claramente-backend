// Tracking de apariciones y contactos de profesionales. Extraído de
// index.js al dividir en módulos — sin cambios de comportamiento.
const express = require('express');
const { supabase } = require('../lib/clients');
const { notificarGratuito } = require('../lib/notificaciones');

const router = express.Router();

// Registrar aparición en búsqueda
router.post('/vista', async (req, res) => {
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
router.post('/contacto', async (req, res) => {
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

module.exports = router;
