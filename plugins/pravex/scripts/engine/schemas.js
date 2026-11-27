'use strict';
/** The shapes agents answer in. `checkShape` is the engine's own check: a shape it did not verify is not an answer. */
const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties, optional = []) => ({ type: 'object', properties, required: Object.keys(properties).filter((k) => !optional.includes(k)), additionalProperties: false });
const list = (items) => ({ type: 'array', items });

const ANALYSIS = obj({
  title: str,
  build: obj({ ok: { type: 'boolean' }, why: str }),
  verify: obj({ ok: { type: 'boolean' }, why: str }),
  summary: str,
  criteria: list(obj({ id: str, text: str })),
  decisions: list(obj({ title: str, decision: str, why: str, reversible: { type: 'boolean' } })),
  missing: list(obj({ what: str, owner: str, meanwhile: str })),
  alternative: str,
}, ['title']);
const PLAN = obj({ tasks: list(obj({ id: str, title: str, criteria: strs, dependsOn: strs, files: strs, tests: strs, risk: { enum: ['low', 'high'] }, notes: str })) });
const REPLAN = obj({ summary: str, criteria: list(obj({ id: str, text: str })), drop: strs, tasks: list(obj({ id: str, title: str, criteria: strs, dependsOn: strs, files: strs, tests: strs, risk: { enum: ['low', 'high'] }, notes: str })) });
const TESTS = obj({ status: { enum: ['DONE', 'BLOCKED'] }, files: strs, command: str, covers: list(obj({ criterion: str, test: str })), note: str });
const BUILD = obj({ status: { enum: ['DONE', 'BLOCKED'] }, summary: str, gaps: strs, needs: strs });
const REVIEW = obj({ verdict: { enum: ['APPROVED', 'FIX'] }, fixes: list(obj({ file: str, problem: str, check: str })), gaps: strs, notes: strs });
const DIAGNOSIS = obj({ cause: str, strategy: str, testsWrong: { type: 'boolean' }, kind: { enum: ['code', 'tests', 'environment'] } }, ['kind']);

function checkShape(schema, value, at = '$') {
  if (schema.enum) return schema.enum.includes(value) ? null : `${at} is not one of ${schema.enum.join(', ')}`;
  if (schema.type === 'string') return typeof value === 'string' ? null : `${at} is not text`;
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${at} is not true or false`;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} is not a list`;
    for (let i = 0; i < value.length; i++) {
      const p = checkShape(schema.items, value[i], `${at}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at} is not an object`;
  for (const k of schema.required) {
    if (!(k in value)) return `${at}.${k} is missing`;
    const p = checkShape(schema.properties[k], value[k], `${at}.${k}`);
    if (p) return p;
  }
  return null;
}

module.exports = { ANALYSIS, PLAN, REPLAN, TESTS, BUILD, REVIEW, DIAGNOSIS, checkShape };
