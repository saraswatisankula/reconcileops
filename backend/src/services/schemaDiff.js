// Compares two introspected schemas. `expected` is usually the desired schema,
// `actual` is what is really in the environment.
export function diffSchemas(expected, actual) {
  const diffs = [];
  const exp = expected?.tables || {};
  const act = actual?.tables || {};

  for (const t of Object.keys(exp)) {
    if (!act[t]) {
      diffs.push({ kind: 'table_missing', table: t, message: `Table "${t}" is missing` });
      continue;
    }
    const ec = exp[t].columns;
    const ac = act[t].columns;

    for (const c of Object.keys(ec)) {
      if (!ac[c]) {
        diffs.push({ kind: 'column_missing', table: t, column: c, expected: ec[c].type,
          message: `Column "${t}.${c}" is missing` });
        continue;
      }
      if (ec[c].type !== ac[c].type) {
        diffs.push({ kind: 'column_type', table: t, column: c, expected: ec[c].type, actual: ac[c].type,
          message: `"${t}.${c}" is ${ac[c].type}, expected ${ec[c].type}` });
      }
      if (ec[c].nullable !== ac[c].nullable) {
        diffs.push({ kind: 'column_nullable', table: t, column: c,
          expected: ec[c].nullable ? 'NULL' : 'NOT NULL', actual: ac[c].nullable ? 'NULL' : 'NOT NULL',
          message: `"${t}.${c}" nullability differs` });
      }
    }
    for (const c of Object.keys(ac)) {
      if (!ec[c]) {
        diffs.push({ kind: 'column_extra', table: t, column: c, actual: ac[c].type,
          message: `Column "${t}.${c}" exists but is not in the desired schema` });
      }
    }

    const eIdx = new Set(exp[t].indexes.map((i) => i.def));
    const aIdx = new Set(act[t].indexes.map((i) => i.def));
    for (const i of exp[t].indexes) {
      if (!aIdx.has(i.def)) diffs.push({ kind: 'index_missing', table: t, expected: i.def, message: `Index missing: ${i.name}` });
    }
    for (const i of act[t].indexes) {
      if (!eIdx.has(i.def)) diffs.push({ kind: 'index_extra', table: t, actual: i.def, message: `Unexpected index: ${i.name}` });
    }

    const eCon = new Set(exp[t].constraints.map((c) => `${c.name}|${c.def}`));
    const aCon = new Set(act[t].constraints.map((c) => `${c.name}|${c.def}`));
    for (const c of exp[t].constraints) {
      if (!aCon.has(`${c.name}|${c.def}`)) diffs.push({ kind: 'constraint_missing', table: t, expected: c.def, message: `Constraint missing: ${c.name}` });
    }
    for (const c of act[t].constraints) {
      if (!eCon.has(`${c.name}|${c.def}`)) diffs.push({ kind: 'constraint_extra', table: t, actual: c.def, message: `Unexpected constraint: ${c.name}` });
    }
  }

  for (const t of Object.keys(act)) {
    if (!exp[t]) diffs.push({ kind: 'table_extra', table: t, message: `Table "${t}" exists but is not in the desired schema` });
  }

  return diffs;
}

export function hasColumn(schema, table, column) {
  return Boolean(schema?.tables?.[table]?.columns?.[column]);
}
