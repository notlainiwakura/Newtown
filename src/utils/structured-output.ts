export type LabeledSections = Record<string, string>;

export function labelKey(label: string): string {
  return label.trim().replace(/[\s_-]+/g, '_').toUpperCase();
}

/**
 * Parse simple LLM "LABEL: value" output without losing wrapped lines.
 *
 * A section begins only when an allowed label appears at the start of a line.
 * Its value continues until the next allowed label, so long questions,
 * summaries, descriptions, and reasons survive normal model line wrapping.
 */
export function parseLabeledSections(
  text: string,
  labels: readonly string[],
): LabeledSections {
  const allowed = new Set(labels.map(labelKey));
  const sections: LabeledSections = {};
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (!currentKey) return;
    const value = currentLines.join('\n').trim();
    if (value.length === 0) {
      currentKey = null;
      currentLines = [];
      return;
    }
    sections[currentKey] = sections[currentKey]
      ? `${sections[currentKey]}\n${value}`
      : value;
    currentKey = null;
    currentLines = [];
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{0,64})\s*:\s*(.*)$/);
    const key = match ? labelKey(match[1]!) : null;

    if (key && allowed.has(key)) {
      flush();
      currentKey = key;
      currentLines = [match![2] ?? ''];
      continue;
    }

    if (currentKey) {
      currentLines.push(line);
    }
  }

  flush();
  return sections;
}

export function getLabeledSection(
  sections: LabeledSections,
  label: string,
): string | null {
  const value = sections[labelKey(label)]?.trim();
  return value && value.length > 0 ? value : null;
}

