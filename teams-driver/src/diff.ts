/** Minimal unified diff, so a changed text file shows what changed rather than
 *  just that it changed. No dependency, LCS over lines. */

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j]! = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

export type DiffOp = { op: ' ' | '-' | '+'; line: string };

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const table = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ op: ' ', line: a[i]! }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ op: '-', line: a[i]! }); i++; }
    else { ops.push({ op: '+', line: b[j]! }); j++; }
  }
  while (i < a.length) ops.push({ op: '-', line: a[i++]! });
  while (j < b.length) ops.push({ op: '+', line: b[j++]! });
  return ops;
}

/** Collapse to changed hunks with `context` unchanged lines around each. */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  const ops = diffLines(oldText, newText);
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.op === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });
  const out: string[] = [];
  let skipping = false;
  ops.forEach((o, idx) => {
    if (keep[idx]) { out.push(o.op + o.line); skipping = false; }
    else if (!skipping) { out.push('@@ ...'); skipping = true; }
  });
  return out.join('\n');
}
