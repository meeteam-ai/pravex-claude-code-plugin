'use strict';
/** What a run leaves for people: a report in plain words and the evidence behind it. Built from the state alone. */
const { say } = require('./messages');
const readiness = require('./readiness');

const L = {
  es: { prepWhat: 'Preparé solo para las pruebas', prepHow: { generated: 'generado', example: 'del ejemplo', placeholder: 'de relleno' }, prepServices: 'Levanté', prepNote: 'Valores de prueba en el archivo de esta máquina; nunca secretos reales y nunca se envían a Pravex.', envWhat: 'Qué falta', envCmd: 'Comando', envSaid: 'Dijo', envVar: 'Variable', envHow: 'Cómo arreglarlo', envHow1: (v, f) => `Pon ${v ? `\`${v}\`` : 'lo que falta'} en \`${f}\` (una línea \`NOMBRE=valor\`; solo lo leen las comprobaciones, nunca un agente) y reanuda.`, envHow2: 'Si hace falta cambiar el repositorio, lanza este requisito como un flujo aparte y reanuda cuando se fusione:', done: 'Listo', partial: 'Listo en parte', cancelled: 'Cancelada', failed: 'No quedó listo', infeasible: 'No se puede', paused: 'En pausa', asked: 'Lo que se pidió', result: 'Resultado', criteria: 'Criterios', proof: 'Prueba', parts: 'Partes', rounds: 'rondas', decided: 'Decisiones que tomé', undo: 'se puede revertir', noundo: 'no se puede revertir', objApplied: 'objetada y replanteada', objFailed: 'objetada, NO se pudo aplicar', missing: 'Falta que alguien lo entregue', until: 'mientras tanto', alt: 'Lo que sí puedo hacer', trust: 'Qué lo demuestra', cost: 'Costo a precio de lista', pend: 'Construido, pendiente de verificar', notes: 'Notas para quien revise', saved: 'Nada se perdió', red: 'las pruebas fallaban antes de construir', nored: 'OJO: las pruebas ya pasaban antes de construir', flaky: 'comprobaciones inestables', base: 'ya fallaban antes de empezar', branch: 'Rama', time: 'Tiempo de trabajo', yes: 'cumplido', no: 'sin cumplir' },
  en: { prepWhat: 'Prepared by itself for the tests', prepHow: { generated: 'generated', example: 'from the example', placeholder: 'a stand-in' }, prepServices: 'Started', prepNote: "Test values in this machine's file; never real secrets, and never sent to Pravex.", envWhat: 'What is missing', envCmd: 'Command', envSaid: 'It said', envVar: 'Variable', envHow: 'How to fix it', envHow1: (v, f) => `Put ${v ? `\`${v}\`` : 'what is missing'} in \`${f}\` (a \`NAME=value\` line; only the checks read it, never an agent) and resume.`, envHow2: 'If the repository has to change, start this requirement as a flow of its own and resume once it is merged:', done: 'Done', partial: 'Partly done', cancelled: 'Cancelled', failed: 'Not done', infeasible: 'It cannot be done', paused: 'Paused', asked: 'What was asked', result: 'Result', criteria: 'Criteria', proof: 'Proof', parts: 'Parts', rounds: 'rounds', decided: 'Decisions made', undo: 'can be undone', noundo: 'cannot be undone', objApplied: 'objected and replanned', objFailed: 'objected, could NOT be applied', missing: 'Needed from someone', until: 'meanwhile', alt: 'What can be done', trust: 'What proves it', cost: 'Cost at list price', pend: 'Built, not verified yet', notes: 'Notes for the reviewer', saved: 'Nothing was lost', red: 'the tests failed before the work', nored: 'NOTE: the tests already passed before the work', flaky: 'unstable checks', base: 'already failing before', branch: 'Branch', time: 'Working time', yes: 'met', no: 'not met' },
};

/** The criteria, each with whether something proves it: a task that proves it is done, and its tests failed first. */
function proven(s) {
  return ((s.feasibility && s.feasibility.criteria) || []).map((c) => {
    const tasks = s.tasks.filter((t) => t.criteria.includes(c.id));
    const ok = tasks.length > 0 && tasks.every((t) => t.phase === 'done') && (!s.integrate || s.integrate.ok);
    return { id: c.id, text: c.text, ok, tests: tasks.flatMap((t) => (t.covers || []).filter((x) => x.criterion === c.id).map((x) => x.test)), redBefore: tasks.length > 0 && tasks.every((t) => t.redBefore === true) };
  });
}

function explain(s) {
  const locale = s.req ? s.req.locale : 'es';
  if (s.paused) return say(s.paused, locale);
  if (s.reason) return { ...say(s.reason, locale), ...(s.reason === 'environment' && s.prepareError ? { detail: `${say(s.prepareError.code, locale).what} ${s.prepareError.detail}` } : {}) };
  const set = s.tasks.find((t) => t.blocked);
  if (set && s.final && s.final !== 'done') return say(set.blocked.reason, locale);
  return null;
}

/** The last stop for checks that cannot run, with where its fix goes: what `snapshot` sends and the report shows. */
function envStop(s) {
  const b = s.envBlocks && s.envBlocks[s.envBlocks.length - 1];
  if (!b) return null;
  const key = readiness.repoKey(s.base && s.base.origin, s.base && s.base.repo);
  const locale = s.req && s.req.locale === 'en' ? 'en' : 'es';
  return { task: b.at === 'prepare' ? null : b.at, command: b.command, line: b.line, missing: b.missing, envFile: `~/.pravex/env/${key}.env`, fix: readiness.fixRequirement({ command: b.command, line: b.line, missing: b.missing, locale }) };
}

/** What Pravex prepared by itself, by name and how, never the values. */
function prepared(events) {
  const names = [];
  const services = [];
  for (const e of events) {
    if (e.type !== 'env.prepared') continue;
    for (const n of e.names || []) if (!names.some((x) => x.name === n.name)) names.push(n);
    for (const x of e.services || []) if (!services.includes(x)) services.push(x);
  }
  return { names, services };
}

function preparedSection(events, l) {
  const { names, services } = prepared(events);
  if (!names.length && !services.length) return [];
  return [`## ${l.prepWhat}`, '', ...names.map((n) => `- \`${n.name}\` (${l.prepHow[n.how] || n.how})`), ...(services.length ? [`- ${l.prepServices}: ${services.map((x) => `\`${x}\``).join(', ')}`] : []), '', l.prepNote, ''];
}

function envSection(s, l) {
  const e = envStop(s);
  if (!e) return [];
  return [`## ${l.envWhat}`, '', `- ${l.envCmd}: \`${e.command}\``, `- ${l.envSaid}: ${e.line}`, ...(e.missing ? [`- ${l.envVar}: \`${e.missing}\``] : []), '', `## ${l.envHow}`, '', `1. ${l.envHow1(e.missing, e.envFile)}`, `2. ${l.envHow2}`, '', `   > ${e.fix}`, ''];
}

function report(s, { reason, status, events = [] }) {
  const locale = s.req && s.req.locale === 'en' ? 'en' : 'es';
  const l = L[locale];
  const f = s.feasibility || {};
  const crit = proven(s);
  const flaky = [...new Set(events.filter((e) => e.type === 'check.finished' && e.flaky).map((e) => e.command))];
  const wasRed = ((s.prepared && s.prepared.checks) || []).filter((c) => !c.ok).map((c) => c.command);
  const md = [`# ${l[status] || status}${status === 'done' && f.verify && f.verify.ok === false ? ` · ${l.pend}` : ''}`, ''];
  const why = reason ? { ...say(reason, locale) } : null;
  if (why) md.push(`**${why.what}** ${why.did} ${why.todo}`, '');
  if (reason === 'environment' && s.prepareError) md.push(`${say(s.prepareError.code, locale).what}`, '', '```', s.prepareError.detail || '', '```', '');
  if (reason === 'checks-cannot-run') md.push(...envSection(s, l, locale));
  md.push(...preparedSection(events, l));
  md.push(`## ${l.asked}`, '', String((s.req && s.req.text) || '').slice(0, 2000), '');
  if (f.summary) md.push(`## ${l.result}`, '', f.summary, '');
  if (f.build && f.build.ok === false) md.push(f.build.why, '', ...(f.alternative ? [`## ${l.alt}`, '', f.alternative, ''] : []));
  if (crit.length && s.tasks.length) {
    md.push(`## ${l.criteria}`, '', `| | ${l.criteria} | ${l.proof} |`, '|---|---|---|');
    for (const c of crit) md.push(`| ${c.id} · ${c.ok ? l.yes : l.no} | ${c.text.replace(/\|/g, '/')} | ${c.tests.join(', ').replace(/\|/g, '/') || '–'} |`);
    md.push('');
  }
  if (s.tasks.length) {
    md.push(`## ${l.parts}`, '');
    for (const t of s.tasks) {
      const w = t.blocked ? say(t.blocked.reason, locale) : null;
      md.push(`- **${t.title}** (${t.id}): ${t.phase === 'done' ? `${l.yes}, ${t.round} ${l.rounds}, ${t.redBefore ? l.red : l.nored}` : w ? `${w.what} ${w.did} ${w.todo}${t.blocked.detail ? ` (${t.blocked.detail})` : ''}` : t.phase}`);
    }
    md.push('');
  }
  if (s.decisions.length)
    md.push(
      `## ${l.decided}`,
      '',
      ...s.decisions.map((d) => {
        const o = s.objections.find((x) => x.n === d.n);
        return `- **${d.n}. ${d.title}**${d.decision && d.decision !== d.title ? `: ${d.decision} ${d.why}` : ''} (${d.reversible ? l.undo : l.noundo})${o ? ` · ${o.state === 'applied' ? l.objApplied : l.objFailed}: ${o.reason}` : ''}`;
      }),
      ''
    );
  if (f.missing && f.missing.length) md.push(`## ${l.missing}`, '', ...f.missing.map((m) => `- ${m.what} (${m.owner}); ${l.until}: ${m.meanwhile}`), '');
  const notes = [...new Set(s.tasks.flatMap((t) => (t.review && t.review.notes) || []))];
  if (notes.length) md.push(`## ${l.notes}`, '', ...notes.map((n) => `- ${n}`), '');
  md.push(`## ${l.trust}`, '');
  if (s.prepared) md.push(...s.prepared.checks.filter((c) => c.ok).map((c) => `- \`${c.command}\``));
  if (wasRed.length) md.push(`- ${l.base}: ${wasRed.map((c) => `\`${c}\``).join(', ')}`);
  if (flaky.length) md.push(`- ${l.flaky}: ${flaky.map((c) => `\`${c}\``).join(', ')}`);
  md.push('', `${l.branch}: \`${s.base ? s.base.branch : ''}\` · ${l.cost}: US$${s.usd.toFixed(2)} · ${l.time}: ${Math.round(s.activeMs / 60e3)} min`, '');
  return {
    markdown: md.join('\n'),
    evidence: { status, reason: reason || null, base: s.base, criteria: crit, verify: f.verify || null, checksBefore: (s.prepared && s.prepared.checks) || [], flaky, tasks: s.tasks.map((t) => ({ id: t.id, title: t.title, phase: t.phase, round: t.round, blocked: t.blocked, evidence: t.evidence, violations: t.violations })), integrate: s.integrate, usd: s.usd, activeMs: s.activeMs, cost: s.cost, jobs: s.jobs },
  };
}

module.exports = { report, explain, proven, envStop, prepared };
