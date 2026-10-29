import crypto from 'node:crypto';

export function checksum(upSql, downSql) {
  return crypto
    .createHash('sha256')
    .update(normalize(upSql) + '\n--down--\n' + normalize(downSql || ''))
    .digest('hex');
}

function normalize(sql) {
  return sql.replace(/\r\n/g, '\n').trim();
}

// Removes comments and string literals so pattern checks don't trip on
// words that only appear inside a comment or a quoted value.
export function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, ' $$BODY$$ ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

// Splits SQL into statements while respecting quotes and $$ blocks.
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let dollarTag = null;

  while (i < sql.length) {
    const ch = sql[i];

    if (!inSingle && !dollarTag && ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (!inSingle) {
      const m = sql.slice(i).match(/^\$([a-z_]*)\$/i);
      if (m) {
        if (dollarTag === null) dollarTag = m[0];
        else if (dollarTag === m[0]) dollarTag = null;
        buf += m[0];
        i += m[0].length;
        continue;
      }
    }

    if (!dollarTag && ch === "'") inSingle = !inSingle;

    if (ch === ';' && !inSingle && !dollarTag) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => stripNoise(s).trim().length > 0);
}
