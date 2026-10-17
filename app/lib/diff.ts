// A small line diff (LCS) for showing what the agent changed in settle.js.
// Files are a few hundred lines at most, so the O(n*m) table is fine.

export type DiffLine = { op: " " | "+" | "-"; text: string; a?: number; b?: number };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // Too large for the table: show as a full replacement.
    return [...a.map((text, i) => ({ op: "-" as const, text, a: i + 1 })), ...b.map((text, j) => ({ op: "+" as const, text, b: j + 1 }))];
  }
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i], a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      out.push({ op: "-", text: a[i], a: i + 1 });
      i++;
    } else {
      out.push({ op: "+", text: b[j], b: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ op: "-", text: a[i], a: ++i });
  while (j < m) out.push({ op: "+", text: b[j], b: ++j });
  return out;
}

/** Unified diff text with `context` lines around each change. */
export function unifiedDiff(before: string, after: string, names = { a: "settle.js (before)", b: "settle.js (after)" }, context = 3): string {
  const lines = diffLines(before, after);
  const changed = lines.map((l) => l.op !== " ");
  if (!changed.some(Boolean)) return "";
  const keep = new Array(lines.length).fill(false);
  changed.forEach((c, idx) => {
    if (!c) return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out = [`--- ${names.a}`, `+++ ${names.b}`];
  let idx = 0;
  while (idx < lines.length) {
    if (!keep[idx]) {
      idx++;
      continue;
    }
    const start = idx;
    while (idx < lines.length && keep[idx]) idx++;
    const hunk = lines.slice(start, idx);
    const aStart = hunk.find((l) => l.a)?.a ?? 0;
    const bStart = hunk.find((l) => l.b)?.b ?? 0;
    const aLen = hunk.filter((l) => l.op !== "+").length;
    const bLen = hunk.filter((l) => l.op !== "-").length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const l of hunk) out.push(`${l.op}${l.text}`);
  }
  return out.join("\n");
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  const lines = diffLines(before, after);
  return { added: lines.filter((l) => l.op === "+").length, removed: lines.filter((l) => l.op === "-").length };
}
