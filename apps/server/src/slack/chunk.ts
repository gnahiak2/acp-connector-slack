export interface FenceState {
  open: boolean;
  language: string;
}

const fenceAtEnd = (text: string): FenceState => {
  let open = false;
  let language = "";
  for (const line of text.split("\n")) {
    const match = /^\s*```(.*)$/.exec(line);
    if (!match) continue;
    if (open) {
      open = false;
      language = "";
    } else {
      open = true;
      language = (match[1] ?? "").trim().slice(0, 32);
    }
  }
  return { open, language };
};

const adjustCut = (text: string, cut: number): number => {
  if (cut <= 0) return 0;
  if (cut >= text.length) return text.length;
  const code = text.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) return cut - 1;
  return cut;
};

export const splitSlackMessage = (text: string, limit = 3_200): string[] => {
  if (!text) return [];
  const budget = Math.max(256, limit - 8);
  const chunks: string[] = [];
  let remaining = text.replace(/\r\n/g, "\n");
  while (remaining.length > budget) {
    let cut = remaining.lastIndexOf("\n", budget);
    if (cut < Math.floor(budget * 0.55)) {
      cut = remaining.lastIndexOf(" ", budget);
    }
    if (cut < Math.floor(budget * 0.55)) cut = budget;
    cut = adjustCut(remaining, cut);
    if (cut <= 0) cut = budget;
    let chunk = remaining.slice(0, cut);
    const state = fenceAtEnd(chunk);
    let rest = remaining.slice(cut).replace(/^\n/, "");
    if (state.open) {
      chunk += "\n```";
      rest = `\`\`\`${state.language}\n${rest}`;
    }
    chunks.push(chunk);
    remaining = rest;
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
};

export const escapeSlackText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const truncateSlackText = (text: string, limit = 3_000): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

export const safeSlackChunk = (text: string, limit = 3_200): string => {
  const chunks = splitSlackMessage(escapeSlackText(text), limit);
  return chunks[0] ?? "";
};
