// Verificación de email, recuperación/cambio de contraseña y login.
// Extraído de index.js al dividir en módulos — sin cambios de comportamiento.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase, resend } = require('../lib/clients');
const { limiterLogin } = require('../lib/rateLimiters');

const router = express.Router();

// Enviar mail de verificación de email
router.post('/verificar-email', async (req, res) => {
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
router.get('/confirmar-email', async (req, res) => {
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
router.post('/recuperar-password', async (req, res) => {
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
router.post('/reset-password', async (req, res) => {
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
router.post('/cambiar-password', async (req, res) => {
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
router.get('/check-email', async (req, res) => {
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

// Login profesional
router.post('/login', limiterLogin, async (req, res) => {
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

module.exports = router;
