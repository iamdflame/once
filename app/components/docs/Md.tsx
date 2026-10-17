import type { ReactNode } from "react";

/**
 * A small Markdown renderer for the docs page: headings, paragraphs, fenced code,
 * ordered and bulleted lists (one level of nesting), bold and inline code. It
 * renders the settle.js interface straight from lib/settle-interface.ts so the docs
 * cannot drift from what the agent is told.
 */
export function Md({ text, demote = 0 }: { text: string; demote?: number }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const h = (level: number, s: string) => {
    const L = Math.min(6, level + demote);
    const id = slug(s);
    const content = inline(s);
    if (L === 2) return <h2 key={key++} id={id}>{content}</h2>;
    if (L === 3) return <h3 key={key++} id={id}>{content}</h3>;
    return <h4 key={key++} id={id}>{content}</h4>;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      out.push(h(hm[1].length, hm[2]));
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const lm = line.match(/^(\d+)\.\s+(.*)$/) ?? line.match(/^[-*]\s+(.*)$/);
    if (lm) {
      const ordered = /^\d/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const m = ordered ? lines[i].match(/^\d+\.\s+(.*)$/) : lines[i].match(/^[-*]\s+(.*)$/);
        if (!m) break;
        const head = m[1];
        i++;
        const sub: string[] = [];
        while (i < lines.length && /^\s{2,}[-*]\s+/.test(lines[i])) sub.push(lines[i++].replace(/^\s+[-*]\s+/, ""));
        items.push(
          <li key={items.length}>
            {inline(head)}
            {sub.length ? (
              <ul>
                {sub.map((t, k) => (
                  <li key={k}>{inline(t)}</li>
                ))}
              </ul>
            ) : null}
          </li>,
        );
      }
      out.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    // a paragraph runs until a blank line or a block start
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\d+\.\s|[-*]\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(<p key={key++}>{inline(buf.join(" "))}</p>);
  }
  return <>{out}</>;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** `code` and **bold**. */
function inline(s: string): ReactNode {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) parts.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else parts.push(<b key={k++}>{t.slice(2, -2)}</b>);
    last = m.index + t.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts.length === 1 ? parts[0] : parts;
}
