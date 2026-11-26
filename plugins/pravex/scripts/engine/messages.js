'use strict';
/** What a person reads when something did not go as planned: what happened, what was done, what to do, and that nothing was lost. */
const M = {
  'plan-ready': { es: ['El plan está listo.', 'No he construido nada todavía.', 'Míralo y dale «Empezar a construir».'], en: ['The plan is ready.', 'Nothing has been built yet.', 'Look at it and start building.'] },
  budget: { es: ['Llegó al tope de costo.', 'Paré limpio; todo lo hecho está guardado.', 'Sube el tope y sigue desde donde iba.'], en: ['It reached the cost limit.', 'It stopped cleanly; everything done is saved.', 'Raise the limit to go on from there.'] },
  time: { es: ['Llegó al tope de tiempo.', 'Paré limpio; todo lo hecho está guardado.', 'Sube el tope y sigue desde donde iba.'], en: ['It reached the time limit.', 'It stopped cleanly; everything done is saved.', 'Raise the limit to go on from there.'] },
  stopped: { es: ['La detuviste.', 'Guardé el último paso terminado.', 'Reanúdala cuando quieras.'], en: ['You stopped it.', 'The last finished step is saved.', 'Resume it whenever you want.'] },
  'claude-limit': { es: ['Se agotó el plan de Claude.', 'Espero a que se reinicie.', 'No tienes que hacer nada.'], en: ["Claude's plan ran out.", 'It waits for the reset.', 'Nothing for you to do.'] },
  'claude-signed-out': { es: ['Claude Code no tiene sesión en esta máquina.', 'Paré antes de gastar; nada se perdió.', 'Ejecuta `claude auth login` y reanuda.'], en: ['Claude Code is not signed in on this machine.', 'It stopped before spending; nothing was lost.', 'Run `claude auth login` and resume.'] },
  'claude-missing': { es: ['No encuentro Claude Code en esta máquina.', 'Paré antes de gastar.', 'Instálalo y reanuda.'], en: ['Claude Code is not on this machine.', 'It stopped before spending.', 'Install it and resume.'] },
  'claude-old': { es: ['Esta versión de Claude Code es muy vieja.', 'Paré antes de gastar.', 'Ejecuta `claude update` y reanuda.'], en: ['This Claude Code is too old.', 'It stopped before spending.', 'Run `claude update` and resume.'] },
  'claude-unavailable': { es: ['El servicio de Claude no responde.', 'Lo intenté 6 veces con esperas cada vez más largas.', 'Reanuda en un rato.'], en: ["Claude's service does not answer.", 'It tried 6 times, waiting longer each time.', 'Resume in a while.'] },
  'sandbox-unavailable': { es: ['No puedo aislar a los agentes en esta máquina.', 'No corro agentes que escriben sin aislamiento.', 'En Linux instala `bubblewrap` y `socat`, y reanuda.'], en: ['Agents cannot be isolated on this machine.', 'Agents that write do not run without isolation.', 'On Linux install `bubblewrap` and `socat`, then resume.'] },
  'install-failed': { es: ['No pude instalar las dependencias.', 'Lo intenté 2 veces.', 'Instálalas a mano una vez para ver el error completo.'], en: ['Dependencies could not be installed.', 'It tried twice.', 'Install them by hand once to see the whole error.'] },
  'tool-missing': { es: ['Falta un programa que este repositorio necesita.', 'Paré antes de gastar.', 'Instálalo y lanza de nuevo.'], en: ['A program this repository needs is missing.', 'It stopped before spending.', 'Install it and start again.'] },
  'disk-full': { es: ['El disco está lleno.', 'Guardé el último paso terminado.', 'Libera espacio y reanuda.'], en: ['The disk is full.', 'The last finished step is saved.', 'Free some space and resume.'] },
  'engine-error': { es: ['Un paso falló dos veces por un problema de Pravex.', 'Lo aparté para no repetirlo sin fin.', 'Envía el diagnóstico a soporte y reanuda.'], en: ['A step failed twice because of a problem in Pravex.', 'It was set aside instead of repeating for ever.', 'Send the diagnostics to support and resume.'] },
  'git-lost': { es: ['La copia de trabajo quedó dañada.', 'Paré sin tocar tu repositorio.', 'Lanza de nuevo; tu copia está intacta.'], en: ['The working copy was damaged.', 'It stopped without touching your repository.', 'Start again; your own copy is intact.'] },
  'engine-stuck': { es: ['Un paso no avanzaba.', 'Lo aparté para no gastar de más.', 'Envía el diagnóstico a soporte.'], en: ['A step was not moving.', 'It was set aside so it would not waste money.', 'Send the diagnostics to support.'] },
  infeasible: { es: ['No se puede hacer aquí.', 'Paré antes de construir.', 'Mira la alternativa que propongo.'], en: ['It cannot be done here.', 'It stopped before building.', 'See the alternative it proposes.'] },
  environment: { es: ['El repositorio no quedó listo para trabajar.', 'Lo intenté 2 veces.', 'Arregla lo que dice abajo y lanza de nuevo.'], en: ['The repository could not be made ready.', 'It tried twice.', 'Fix what is said below and start again.'] },
  'analyze-failed': { es: ['No logré entender el requisito.', 'Lo intenté 3 veces.', 'Escríbelo con más detalle y lanza de nuevo.'], en: ['The requirement could not be understood.', 'It tried 3 times.', 'Write it with more detail and start again.'] },
  'plan-failed': { es: ['No logré un plan válido.', 'Lo intenté 3 veces.', 'Divide el requisito o dale más detalle.'], en: ['No valid plan came out.', 'It tried 3 times.', 'Split the requirement or give more detail.'] },
  // why one part was set aside
  checks: { es: ['Sus comprobaciones no pasaron.', 'Agoté las rondas y un diagnóstico.', 'Su trabajo quedó en una rama aparte.'], en: ['Its checks did not pass.', 'It used its rounds and a diagnosis.', 'Its work is on a branch of its own.'] },
  review: { es: ['La revisión siguió encontrando un problema real.', 'Agoté las rondas.', 'Su trabajo quedó en una rama aparte.'], en: ['The review kept finding a real problem.', 'It used its rounds.', 'Its work is on a branch of its own.'] },
  dependency: { es: ['Dependía de otra parte que no quedó lista.', 'No la empecé.', 'Se retoma cuando la otra esté lista.'], en: ['It stood on a part that was not finished.', 'It was not started.', 'It can go on when the other is ready.'] },
  'no-tests': { es: ['No logré pruebas que demostraran que funciona.', 'Lo intenté 2 veces.', 'Agrega un criterio más concreto.'], en: ['No tests came out that would prove it works.', 'It tried twice.', 'Add a more concrete criterion.'] },
  'job-failed': { es: ['Un agente no dio una respuesta útil.', 'Lo intenté 3 veces.', 'Vuelve a lanzar esta parte.'], en: ['An agent gave no usable answer.', 'It tried 3 times.', 'Start this part again.'] },
  'evidence-lost': { es: ['La evidencia no coincidía al final.', 'No la doy por terminada.', 'Vuelve a lanzar esta parte.'], en: ['The evidence did not match at the end.', 'It is not called done.', 'Start this part again.'] },
  unreachable: { es: ['Quedó esperando a otra parte sin salida.', 'La aparté.', 'Envía el diagnóstico a soporte.'], en: ['It was waiting on another part with no way out.', 'It was set aside.', 'Send the diagnostics to support.'] },
};
const say = (code, locale = 'es') => {
  const m = M[code] || { es: ['Pasó algo que no esperaba.', 'Guardé el trabajo hecho.', 'Envía el diagnóstico a soporte.'], en: ['Something unexpected happened.', 'The work done is saved.', 'Send the diagnostics to support.'] };
  const [what, did, todo] = m[locale === 'en' ? 'en' : 'es'];
  return { code, what, did, todo };
};
module.exports = { MESSAGES: M, say };
