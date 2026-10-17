import s from "./bench.module.css";

type Op = { kind: "same" | "del" | "add"; text: string };

/** Line diff by longest common subsequence; the sources are short. */
export function lineDiff(oldText: string, newText: string): Op[] {
  const a = oldText.replace(/\r/g, "").split("\n");
  const b = newText.replace(/\r/g, "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "add", text: b[j++] });
  return ops;
}

/** A unified diff (one hunk, no context trimming) for the record the host keeps of an agent run. */
export function unifiedDiff(oldText: string, newText: string, oldName = "settle.js (before)", newName = "settle.js (after)"): string {
  const ops = lineDiff(oldText, newText);
  const a = oldText.replace(/\r/g, "").split("\n").length;
  const b = newText.replace(/\r/g, "").split("\n").length;
  const body = ops.map((o) => (o.kind === "add" ? "+" : o.kind === "del" ? "-" : " ") + o.text);
  return [`--- ${oldName}`, `+++ ${newName}`, `@@ -1,${a} +1,${b} @@`, ...body].join("\n");
}

type Row = { op: "same" | "del" | "add" | "hunk"; text: string; l: string; r: string };

/** Renders a unified diff with the same styles as the live diff. */
export function UnifiedDiff({ unified, oldLabel, newLabel }: { unified: string; oldLabel: string; newLabel: string }) {
  const rows = unified.replace(/\r/g, "").split("\n");
  let ln = 0;
  let rn = 0;
  let dels = 0;
  let adds = 0;
  const parsed: Row[] = rows
    .filter((row) => !row.startsWith("--- ") && !row.startsWith("+++ "))
    .map((row) => {
      const m = row.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        ln = Number(m[1]) - 1;
        rn = Number(m[2]) - 1;
        return { op: "hunk", text: row, l: "", r: "" };
      }
      const op: Row["op"] = row.startsWith("+") ? "add" : row.startsWith("-") ? "del" : "same";
      if (op !== "add") ln++;
      if (op !== "del") rn++;
      if (op === "add") adds++;
      if (op === "del") dels++;
      return { op, text: row.slice(1), l: op === "add" ? "" : String(ln), r: op === "del" ? "" : String(rn) };
    });
  return (
    <div className={s.diff}>
      <div className={s.diffHead}>
        <span className={s.diffFile}>settle.js</span>
        <span className={s.diffVersions}>
          <s>{oldLabel}</s>
          <span aria-hidden="true">→</span>
          <b>{newLabel}</b>
        </span>
        <span className={s.diffCounts}>
          <span className={s.cntDel}>−{dels}</span> <span className={s.cntAdd}>+{adds}</span>
        </span>
      </div>
      <pre className={s.diffBody} tabIndex={0} aria-label={`Diff of settle.js ${oldLabel} against ${newLabel}, from the last run`}>
        {parsed.map((o, k) => (
          <span key={k} className={s.diffLine} data-op={o.op}>
            <span className={s.gutter}>{o.l}</span>
            <span className={s.gutter}>{o.r}</span>
            <span className={s.sign}>{o.op === "add" ? "+" : o.op === "del" ? "−" : " "}</span>
            <span className={s.code}>{o.text || " "}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

export function Diff({ oldText, newText, oldLabel, newLabel }: { oldText: string; newText: string; oldLabel: string; newLabel: string }) {
  const ops = newText ? lineDiff(oldText, newText) : oldText.split("\n").map((text) => ({ kind: "same" as const, text }));
  const dels = ops.filter((o) => o.kind === "del").length;
  const adds = ops.filter((o) => o.kind === "add").length;
  let ln = 0;
  let rn = 0;
  return (
    <div className={s.diff}>
      <div className={s.diffHead}>
        <span className={s.diffFile}>settle.js</span>
        <span className={s.diffVersions}>
          <s>{oldLabel}</s>
          <span aria-hidden="true">→</span>
          <b>{newLabel || "…"}</b>
        </span>
        <span className={s.diffCounts}>
          <span className={s.cntDel}>−{dels}</span> <span className={s.cntAdd}>+{adds}</span>
        </span>
      </div>
      <pre className={s.diffBody} tabIndex={0} aria-label={`Diff of settle.js ${oldLabel} against ${newLabel}`}>
        {ops.map((o, k) => {
          if (o.kind !== "add") ln++;
          if (o.kind !== "del") rn++;
          return (
            <span key={k} className={s.diffLine} data-op={o.kind}>
              <span className={s.gutter}>{o.kind === "add" ? "" : ln}</span>
              <span className={s.gutter}>{o.kind === "del" ? "" : rn}</span>
              <span className={s.sign}>{o.kind === "add" ? "+" : o.kind === "del" ? "−" : " "}</span>
              <span className={s.code}>{o.text || " "}</span>
            </span>
          );
        })}
      </pre>
    </div>
  );
}
