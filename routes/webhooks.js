// Webhooks de MercadoPago (altas y cancelaciones de suscripción) y el
// endpoint de verificación de pago que consulta el frontend. Extraído de
// index.js al dividir en módulos — sin cambios de comportamiento.
const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../lib/clients');
const { normalizarNombre } = require('../lib/texto');
const { verificarFirmaMP, registrarWebhookLog } = require('../lib/webhookLog');

const router = express.Router();

// Webhook de MercadoPago
router.post('/webhook/mp', async (req, res) => {
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
      nombre: normalizarNombre(d.nombre), matricula: d.matricula, email: d.email,
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
router.post('/webhook/mp-sub', async (req, res) => {
  if (!verificarFirmaMP(req)) return res.sendStatus(401);
  try {
    const { type, data } = req.body;
    const resourceId = data?.id;
    if (!resourceId) return res.sendStatus(200);

    let external_ref = null;
    let esCancelacion = false;
    let fechaFinAcceso = null;

    if (type === 'preapproval') {
      // Suscripciones creadas con preapproval_plan_id (flujo viejo/alternativo)
      const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${resourceId}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const sub = await mpRes.json();
      registrarWebhookLog('preapproval', resourceId, sub.external_reference, sub.status, sub);
      if (sub.status === 'authorized') {
        external_ref = sub.external_reference;
      } else if (sub.status === 'cancelled') {
        // La persona canceló — NO le cortamos el acceso ahora mismo, ya pagó
        // este período. Guardamos hasta cuándo tiene acceso (next_payment_date
        // es la fecha del próximo cobro que YA NO va a pasar, o sea, el límite
        // real de lo que pagó) y un cron se encarga del corte cuando corresponda.
        external_ref = sub.external_reference;
        esCancelacion = true;
        fechaFinAcceso = sub.next_payment_date || null;
      }

    } else if (type === 'payment') {
      // Suscripciones "sin plan asociado" (auto_recurring) — el cobro real avisa
      // por acá, con action payment.created/payment.updated, no por preapproval.
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${resourceId}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const pago = await mpRes.json();
      registrarWebhookLog('payment', resourceId, pago.external_reference, pago.status, pago);
      if (pago.status === 'approved') external_ref = pago.external_reference;

    } else {
      return res.sendStatus(200); // otro tipo de evento, lo ignoramos
    }

    if (!external_ref) return res.sendStatus(200);

    // Caso 0: cancelación de una suscripción existente. NO bajamos el plan acá
    // — guardamos hasta cuándo tiene acceso pagado, y el cron
    // verificarPremiumCancelado() se encarga de bajarlo (y avisarle por mail)
    // recién cuando ese período termine, igual que hacemos con los trials.
    if (esCancelacion && external_ref.startsWith('prof_')) {
      const profesionalId = external_ref.replace('prof_', '');
      const { error: cancelError } = await supabase
        .from('profesionales')
        .update({
          suscripcion_cancelada: true,
          premium_hasta: fechaFinAcceso,
          cancelacion_mail_enviado: false,
        })
        .eq('id', profesionalId);
      if (cancelError) console.error('Error registrando cancelación:', cancelError.message);
      else console.log(`Cancelación registrada para ${profesionalId} — mantiene acceso hasta ${fechaFinAcceso || '(sin fecha, revisar manualmente)'}`);
      return res.sendStatus(200);
    }

    // Caso 1: upgrade de un profesional YA EXISTENTE (link generado por generarLinkUpgrade)
    if (external_ref.startsWith('prof_')) {
      const profesionalId = external_ref.replace('prof_', '');
      const { error: updateError } = await supabase
        .from('profesionales')
        .update({
          plan: 'premium',
          plan_activo_desde: new Date().toISOString(),
          // Si se re-suscribe después de haber cancelado antes, es un ciclo de
          // pago nuevo — reseteamos las banderas de la cancelación anterior.
          suscripcion_cancelada: false,
          premium_hasta: null,
        })
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
      nombre: normalizarNombre(d.nombre), matricula: d.matricula, email: d.email,
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
router.get('/verificar-pago', async (req, res) => {
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

module.exports = router;
