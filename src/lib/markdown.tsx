import type { ComponentChildren } from "preact";

/** Matches **bold**, *italic*, `code`, and [text](url) — the inline markdown LLM replies tend to use. */
const INLINE_PATTERN = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

function renderLine(line: string, lineIndex: number): ComponentChildren[] {
  const nodes: ComponentChildren[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of line.matchAll(INLINE_PATTERN)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) nodes.push(line.slice(lastIndex, idx));

    if (match[1] !== undefined) {
      nodes.push(<strong key={`${lineIndex}-${key++}`}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      nodes.push(<em key={`${lineIndex}-${key++}`}>{match[2]}</em>);
    } else if (match[3] !== undefined) {
      nodes.push(<code key={`${lineIndex}-${key++}`}>{match[3]}</code>);
    } else if (match[4] !== undefined && match[5] !== undefined) {
      nodes.push(
        <a key={`${lineIndex}-${key++}`} href={match[5]} target="_blank" rel="noopener noreferrer">
          {match[4]}
        </a>,
      );
    }

    lastIndex = idx + match[0].length;
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes;
}

/** Renders simple inline markdown (bold/italic/code/links) plus line breaks, without a full markdown parser or dangerouslySetInnerHTML. */
export function MarkdownText({ text }: { text: string }) {
  const lines = text.split("\n");
  const nodes: ComponentChildren[] = [];

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) nodes.push(<br key={`br-${lineIndex}`} />);
    nodes.push(...renderLine(line, lineIndex));
  });

  return <>{nodes}</>;
}
