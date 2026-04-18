/**
 * Action Mapper — maps *action text* from Lain's responses to sprite expressions.
 * First match wins. Unrecognized actions return null (avatar stays as-is).
 */

// eslint-disable-next-line no-unused-vars -- global, consumed by app.js at runtime
const ActionMapper = (() => {
  const actions = [
    {
      keywords: ['small smile'],
      expression: 'smile',
      duration: 4000,
    },
    {
      keywords: ['smile', 'smiles', 'grin', 'grins'],
      expression: 'smile',
      duration: 4000,
    },
    {
      keywords: ['laugh', 'laughs', 'chuckle', 'giggles'],
      expression: 'smile',
      duration: 3000,
    },
    {
      keywords: ['frown', 'frowns', 'frowning'],
      expression: 'frown',
      duration: 4000,
    },
    {
      keywords: ['surprised', 'surprise', 'eyes widen', 'wide eyes'],
      expression: 'surprised',
      duration: 2500,
    },
    {
      keywords: ['closes eyes', 'eyes close', 'shuts eyes'],
      expression: 'eyes-closed',
      duration: 3000,
    },
    {
      keywords: ['looks away', 'glances away'],
      expression: 'look-away',
      duration: 3000,
    },
    {
      keywords: ['looks up', 'glances up'],
      expression: 'look-up',
      duration: 3000,
    },
    {
      keywords: ['looks down', 'glances down'],
      expression: 'look-down',
      duration: 3000,
    },
    {
      keywords: ['thoughtful', 'thinking', 'thinks'],
      expression: 'thoughtful',
      duration: 5000,
    },
    {
      keywords: ['curious', 'curiously'],
      expression: 'curious',
      duration: 4000,
    },
    {
      keywords: ['sigh', 'sighs', 'sighing'],
      expression: 'sigh',
      duration: 2500,
    },
    {
      keywords: ['blush', 'blushing'],
      expression: 'blush',
      duration: 4000,
    },
    {
      keywords: ['tilts head', 'head tilt'],
      expression: 'thoughtful',
      duration: 3000,
    },
    {
      keywords: ['nods', 'nodding'],
      expression: 'eyes-closed',
      duration: 1500,
    },
    {
      keywords: ['quiet', 'pause', 'pauses', 'silent'],
      expression: 'neutral',
      duration: 3000,
    },
    {
      keywords: ['leans forward', 'leaning forward', 'leans back', 'sits back'],
      expression: 'neutral',
      duration: 3000,
    },
    {
      keywords: ['breath', 'breathing', 'exhale'],
      expression: 'sigh',
      duration: 3000,
    },
  ];

  /**
   * Resolve action text to a sprite expression.
   * @param {string} text — the text between asterisks, e.g. "small smile"
   * @returns {{ expression: string, duration: number }|null}
   */
  function resolve(text) {
    const lower = text.toLowerCase().trim();
    for (const action of actions) {
      for (const kw of action.keywords) {
        if (lower.includes(kw)) {
          return {
            expression: action.expression,
            duration: action.duration,
          };
        }
      }
    }
    return null;
  }

  return { resolve };
})();
