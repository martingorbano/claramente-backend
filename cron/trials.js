// Trabajos periódicos relacionados a trials y cancelaciones de suscripción.
// Extraído de index.js al dividir en módulos — sin cambios de comportamiento.
const { supabase, resend } = require('../lib/clients');
const { DIAS_PARA_RECORDATORIO } = require('../lib/constants');

// Cron: verificar trials vencidos y mandar mail
async function verificarTrialsVencidos() {
  try {
    const ahora = new Date().toISOString();
    // Buscar profesionales con trial vencido que aún NO fueron notificados
    const { data: vencidos } = await supabase
      .from('profesionales')
      .select('id, nombre, email, trial_hasta, busquedas_semana')
      .lt('trial_hasta', ahora)
      .not('trial_hasta', 'is', null)
      .eq('plan', 'gratuito') // Ya están en gratuito, el trial expiró
      .eq('trial_mail_enviado', false) // Clave: solo los que no recibieron el mail todavía
      .eq('activo', true); // No molestar a cuentas desactivadas

    if (!vencidos || vencidos.length === 0) return;

    for (const prof of vencidos) {
      const nombre = prof.nombre?.split(' ')[0] || 'Lic.';
      const linkPanel = `${process.env.APP_URL || 'https://claramentepsi.com'}/panel.html?activar=premium`;

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
              <a href="${linkPanel}" style="display:block;text-align:center;background:#4A7C6F;color:white;padding:14px 28px;border-radius:24px;text-decoration:none;font-size:14px;font-weight:500;margin-bottom:16px">
                Activar Plan Premium →
              </a>
              <p style="font-size:12px;color:#9AAFAA;text-align:center;line-height:1.6">
                Te vamos a pedir que confirmes el mail de tu cuenta de MercadoPago antes de generar el link de pago — así evitamos errores si usás un mail distinto ahí que acá.
              </p>
              <p style="font-size:12px;color:#9AAFAA;text-align:center;line-height:1.6">
                Si no activás el plan, tu perfil sigue apareciendo en los resultados sin foto ni contacto directo.<br>
                Podés activar Premium desde tu panel cuando quieras.
              </p>
            </div>
          </div>
        `
      });

      // Marcar como notificado para que el próximo cron no lo vuelva a mandar
      await supabase
        .from('profesionales')
        .update({ trial_mail_enviado: true })
        .eq('id', prof.id);

      console.log(`Mail de trial vencido enviado a ${prof.email}`);
    }
  } catch(e) {
    console.error('Error verificando trials:', e.message);
  }
}

// Cron: segundo mail, más adelante, para quienes ya vieron que su trial terminó
// pero todavía no activaron Premium — se manda una sola vez por trial, igual que
// el primero.
async function verificarRecordatorioTrial() {
  try {
    const limite = new Date();
    limite.setDate(limite.getDate() - DIAS_PARA_RECORDATORIO);

    const { data: pendientes } = await supabase
      .from('profesionales')
      .select('id, nombre, email, plan, trial_hasta')
      .eq('plan', 'gratuito')
      .eq('trial_mail_enviado', true) // ya le llegó el primer mail
      .eq('recordatorio_enviado', false) // todavía no el recordatorio
      .eq('activo', true) // No molestar a cuentas desactivadas
      .lt('trial_hasta', limite.toISOString()); // pasaron los días de margen

    if (!pendientes || pendientes.length === 0) return;

    // Segunda capa de seguridad, redundante a propósito: no confiamos en una
    // sola condición para algo tan sensible como "no molestar a quien paga".
    // Sin importar lo que haya devuelto la query, volvemos a chequear acá:
    // plan realmente gratuito, y trial realmente vencido (no activo).
    const ahoraCheck = new Date();
    const aEnviar = pendientes.filter(p => {
      const esGratuito = p.plan === 'gratuito';
      const trialVencido = p.trial_hasta && new Date(p.trial_hasta) < ahoraCheck;
      return esGratuito && trialVencido;
    });

    for (const prof of aEnviar) {
      const nombre = prof.nombre?.split(' ')[0] || 'Lic.';
      const linkPanel = `${process.env.APP_URL || 'https://claramentepsi.com'}/panel.html?activar=premium`;

      await resend.emails.send({
        from: 'Claramente <hola@claramentepsi.com>',
        to: prof.email,
        subject: '¿Seguís interesado/a en aparecer con Premium en Claramente?',
        html: `
          <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;background:#F7F3EE;padding:32px 20px">
            <div style="background:white;border-radius:16px;padding:36px;border:1px solid #D8E8E4">
              <div style="font-family:Georgia,serif;font-size:22px;color:#1C2B28;margin-bottom:20px">
                clara<span style="color:#4A7C6F;font-style:italic">mente</span>
              </div>
              <p style="font-size:16px;color:#1C2B28;margin-bottom:8px">Hola, ${nombre}.</p>
              <p style="font-size:14px;color:#6B847E;line-height:1.7;margin-bottom:24px">
                Hace unos días te avisamos que tu período de prueba en Claramente terminó. Todavía podés activar el plan Premium y volver a aparecer con foto y contacto directo por WhatsApp cuando alguien te busque.
              </p>
              <div style="background:#F7F3EE;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center">
                <p style="font-size:13px;color:#6B847E;margin-bottom:4px">Plan Premium</p>
                <p style="font-size:22px;font-weight:600;color:#B8860B;margin:0">$32.500/mes</p>
                <p style="font-size:11px;color:#B8860B;font-style:italic;margin-top:4px">Precio promocional de lanzamiento</p>
              </div>
              <a href="${linkPanel}" style="display:block;text-align:center;background:#4A7C6F;color:white;padding:14px 28px;border-radius:24px;text-decoration:none;font-size:14px;font-weight:500;margin-bottom:16px">
                Activar Plan Premium →
              </a>
              <p style="font-size:12px;color:#9AAFAA;text-align:center;line-height:1.6">
                Si ya no te interesa, no hace falta que hagas nada — tu perfil sigue publicado en el plan gratuito, sin foto ni contacto directo, y no te vamos a volver a escribir por esto.
              </p>
            </div>
          </div>
        `
      });

      await supabase
        .from('profesionales')
        .update({ recordatorio_enviado: true })
        .eq('id', prof.id);

      console.log(`Mail de recordatorio de trial enviado a ${prof.email}`);
    }
  } catch(e) {
    console.error('Error verificando recordatorios de trial:', e.message);
  }
}

// Cron: baja a gratuito a quienes cancelaron su suscripción Premium y ya se
// les terminó el período que habían pagado (premium_hasta) — no se les corta
// antes de tiempo, mismo criterio que con los trials. Se manda un mail
// dedicado a esto, distinto al de "tu trial terminó" — esto es alguien que
// pagó de verdad y canceló, no alguien que nunca pagó.
async function verificarPremiumCancelado() {
  try {
    const ahora = new Date().toISOString();
    const { data: vencidos } = await supabase
      .from('profesionales')
      .select('id, nombre, email, premium_hasta')
      .eq('suscripcion_cancelada', true)
      .eq('plan', 'premium') // todavía no lo bajamos
      .eq('activo', true)
      .not('premium_hasta', 'is', null)
      .lt('premium_hasta', ahora);

    if (!vencidos || vencidos.length === 0) return;

    for (const prof of vencidos) {
      const { error } = await supabase
        .from('profesionales')
        .update({ plan: 'gratuito' })
        .eq('id', prof.id);

      if (error) {
        console.error(`Error bajando a gratuito a ${prof.email}:`, error.message);
        continue; // no marcamos el mail como enviado si ni siquiera pudimos bajar el plan
      }

      const nombre = prof.nombre?.split(' ')[0] || 'Lic.';
      const linkPanel = `${process.env.APP_URL || 'https://claramentepsi.com'}/panel.html?activar=premium`;

      try {
        await resend.emails.send({
          from: 'Claramente <hola@claramentepsi.com>',
          to: prof.email,
          subject: 'Tu suscripción Premium en Claramente terminó',
          html: `
            <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;background:#F7F3EE;padding:32px 20px">
              <div style="background:white;border-radius:16px;padding:36px;border:1px solid #D8E8E4">
                <div style="font-family:Georgia,serif;font-size:22px;color:#1C2B28;margin-bottom:20px">
                  clara<span style="color:#4A7C6F;font-style:italic">mente</span>
                </div>
                <p style="font-size:16px;color:#1C2B28;margin-bottom:8px">Hola, ${nombre}.</p>
                <p style="font-size:14px;color:#6B847E;line-height:1.7;margin-bottom:24px">
                  Tu suscripción Premium en Claramente terminó — como cancelaste, ya no se renovó, y tu perfil dejó de mostrar foto y contacto directo por WhatsApp.
                </p>
                <div style="background:#F7F3EE;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center">
                  <p style="font-size:13px;color:#6B847E;margin-bottom:4px">Si en algún momento querés volver a activarlo</p>
                  <p style="font-size:22px;font-weight:600;color:#B8860B;margin:0">$32.500/mes</p>
                </div>
                <a href="${linkPanel}" style="display:block;text-align:center;background:#4A7C6F;color:white;padding:14px 28px;border-radius:24px;text-decoration:none;font-size:14px;font-weight:500;margin-bottom:16px">
                  Reactivar Plan Premium →
                </a>
                <p style="font-size:12px;color:#9AAFAA;text-align:center;line-height:1.6">
                  Tu perfil sigue publicado en el plan gratuito. Si cancelaste por error o tenés alguna duda, escribinos.
                </p>
              </div>
            </div>
          `
        });
        console.log(`Mail de fin de suscripción (cancelada) enviado a ${prof.email}`);
      } catch (mailError) {
        console.error(`Error mandando mail de fin de suscripción a ${prof.email}:`, mailError.message);
      }

      await supabase
        .from('profesionales')
        .update({ cancelacion_mail_enviado: true })
        .eq('id', prof.id);
    }
  } catch(e) {
    console.error('Error verificando premium cancelado:', e.message);
  }
}

// Arranca los tres crons: los ejecuta una vez de entrada (por ejemplo, justo
// después de un deploy) — sin esto, setInterval solo dispara recién a las
// 12hs de iniciado, dejando a cualquiera que venció el trial en el medio
// esperando sin motivo — y después los deja corriendo cada 12 horas.
function iniciar() {
  verificarTrialsVencidos();
  verificarRecordatorioTrial();
  verificarPremiumCancelado();
  setInterval(verificarTrialsVencidos, 12 * 60 * 60 * 1000);
  setInterval(verificarRecordatorioTrial, 12 * 60 * 60 * 1000);
  setInterval(verificarPremiumCancelado, 12 * 60 * 60 * 1000);
}

module.exports = {
  verificarTrialsVencidos,
  verificarRecordatorioTrial,
  verificarPremiumCancelado,
  iniciar,
};
