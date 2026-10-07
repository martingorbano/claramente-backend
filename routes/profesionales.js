// Alta, edición, estadísticas y flujo de pago de profesionales.
// Extraído de index.js al dividir en módulos — sin cambios de comportamiento.
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { supabase, mp, PreApproval } = require('../lib/clients');
const { PREMIUM_MONTO } = require('../lib/constants');
const {
  normalizarNombre,
  validarSinTelefono,
  validarArraysSinTelefono,
} = require('../lib/texto');
const { limpiarInitPoint, generarLinkUpgrade } = require('../lib/mercadopago');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 } });

const router = express.Router();

// Registrar profesional
router.post('/registro', async (req, res) => {
  const { nombre, matricula, email, whatsapp, password, bio, ciudad, localidad, genero, experiencia,
    honorario, obras_sociales, enfoques, especializaciones, modalidades, edades,
    dias, franjas, plan } = req.body;

  if (!nombre || !email || !password || !whatsapp) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const errorValidacion = validarSinTelefono(nombre, bio) || validarArraysSinTelefono(obras_sociales, enfoques, especializaciones);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

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
      nombre: normalizarNombre(nombre), matricula, email, whatsapp, password_hash, bio, ciudad, localidad, genero,
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

// Upload foto de perfil
router.post('/upload-foto', upload.single('foto'), async (req, res) => {
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
router.get('/profesional/:id', async (req, res) => {
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

router.put('/profesional/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, whatsapp, ciudad, localidad, honorario, bio, enfoques, especializaciones, modalidades, obras_sociales, foto_url, genero } = req.body;

  const errorValidacion = validarSinTelefono(nombre, bio) || validarArraysSinTelefono(obras_sociales, enfoques, especializaciones);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

  try {
    const updateData = { nombre: normalizarNombre(nombre), whatsapp, ciudad, localidad, honorario, bio, enfoques, especializaciones, modalidades, obras_sociales, genero };
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
router.get('/stats/:psy_id', async (req, res) => {
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
router.post('/registro-pendiente', async (req, res) => {
  const { datos, plan } = req.body;
  if (!datos || !plan) return res.status(400).json({ error: 'Faltan datos' });

  const errorValidacion = validarSinTelefono(datos.nombre, datos.bio) || validarArraysSinTelefono(datos.obras_sociales, datos.enfoques, datos.especializaciones);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

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

    res.json({ ok: true, session_id, init_point: limpiarInitPoint(subscription.init_point) });
  } catch (e) {
    console.error('Error registro pendiente:', e.message);
    res.status(500).json({ error: 'Error al generar link de pago: ' + e.message });
  }
});

// Generar link de pago para un profesional YA EXISTENTE que quiere pasar a Premium
// (botón "Actualizar plan" del panel — pestaña Plan). Usar este endpoint en vez de
// linkear directamente al checkout de MP, para que el webhook pueda identificar
// a qué profesional corresponde el pago.
router.post('/generar-link-premium', async (req, res) => {
  const { email, mp_email } = req.body;
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

    const init_point = await generarLinkUpgrade(profesional, mp_email);
    res.json({ ok: true, init_point });
  } catch (e) {
    console.error('Error generando link de upgrade:', e.message);
    res.status(500).json({ error: 'Error al generar link de pago: ' + e.message });
  }
});

module.exports = router;
