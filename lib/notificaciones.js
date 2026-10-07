// Mails relacionados a profesionales en plan gratuito. Extraído de index.js
// al dividir en módulos — sin cambios de comportamiento.
const { supabase, resend } = require('./clients');

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
            Con el plan <strong style="color: #B8860B;">Premium ($32.500/mes)</strong> los pacientes pueden contactarte directamente — y vos aparecés primero cuando sos el match correcto.
          </p>
          <a href="https://claramentepsi.com/login.html"
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

module.exports = { notificarGratuito };
