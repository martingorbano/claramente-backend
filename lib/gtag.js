// Snippet de Google Tag inyectado en las páginas HTML servidas por el
// backend. Extraído de index.js al dividir en módulos — sin cambios de
// comportamiento.
const GTAG = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-17918674170"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'AW-17918674170');
  gtag('config', 'G-JBYZ5M5M74');
</script>`;

module.exports = { GTAG };
