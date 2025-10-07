const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

export function decodeEntities(text: string): string {
  return text.replace(/(&[a-zA-Z#0-9]+;)/g, (entity) => ENTITY_MAP[entity] ?? entity);
}

export function cleanText(text: string): string {
  return decodeEntities(stripTags(text)).replace(/\s+/g, ' ').trim();
}

export function extractAttribute(tag: string, attr: string): string | undefined {
  const regex = new RegExp(attr + '=\"([^\"]+)\"', 'i');
  const match = tag.match(regex);
  return match ? match[1] : undefined;
}

export function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<tr[\s\S]*?>[\s\S]*?<\/tr>/gi;
  const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
  const matches = html.match(rowRegex) ?? [];
  for (const row of matches) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(row))) {
      cells.push(cleanText(cellMatch[1]));
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}
