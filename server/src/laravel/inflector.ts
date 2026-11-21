/**
 * The table name Eloquent derives from a model class: `Str::snake(Str::pluralStudly($basename))`,
 * with the English rules of the Doctrine inflector Laravel uses.
 */

const UNCOUNTABLE = new Set([
  'adult',
  'advice',
  'aircraft',
  'art',
  'audio',
  'baggage',
  'butter',
  'cattle',
  'chassis',
  'clothing',
  'coal',
  'compensation',
  'cotton',
  'data',
  'deer',
  'education',
  'emoji',
  'equipment',
  'evidence',
  'feedback',
  'firmware',
  'fish',
  'flour',
  'food',
  'furniture',
  'gold',
  'hardware',
  'homework',
  'information',
  'innings',
  'jeans',
  'kin',
  'knowledge',
  'leather',
  'love',
  'luggage',
  'management',
  'metadata',
  'moose',
  'music',
  'news',
  'nutrition',
  'offspring',
  'oil',
  'patience',
  'pokemon',
  'police',
  'polish',
  'progress',
  'recommended',
  'related',
  'research',
  'rice',
  'series',
  'sheep',
  'silk',
  'sms',
  'soap',
  'social',
  'software',
  'species',
  'staff',
  'sugar',
  'swine',
  'talent',
  'toothpaste',
  'traffic',
  'travel',
  'wheat',
  'wood',
  'wool',
]);

const IRREGULAR: Record<string, string> = {
  atlas: 'atlases',
  axe: 'axes',
  beef: 'beefs',
  brother: 'brothers',
  cafe: 'cafes',
  chateau: 'chateaux',
  child: 'children',
  cookie: 'cookies',
  corpus: 'corpuses',
  cow: 'cows',
  criterion: 'criteria',
  curriculum: 'curricula',
  demo: 'demos',
  domino: 'dominoes',
  echo: 'echoes',
  foot: 'feet',
  fungus: 'fungi',
  ganglion: 'ganglions',
  gas: 'gases',
  genie: 'genies',
  genus: 'genera',
  goose: 'geese',
  graffito: 'graffiti',
  hippopotamus: 'hippopotami',
  hoof: 'hoofs',
  human: 'humans',
  iris: 'irises',
  larva: 'larvae',
  leaf: 'leaves',
  lens: 'lenses',
  loaf: 'loaves',
  man: 'men',
  medium: 'media',
  memorandum: 'memoranda',
  money: 'monies',
  mongoose: 'mongooses',
  motto: 'mottoes',
  move: 'moves',
  mythos: 'mythoi',
  niche: 'niches',
  nucleus: 'nuclei',
  numen: 'numina',
  occiput: 'occiputs',
  octopus: 'octopuses',
  opus: 'opuses',
  ox: 'oxen',
  passerby: 'passersby',
  penis: 'penises',
  person: 'people',
  plateau: 'plateaux',
  sex: 'sexes',
  sieve: 'sieves',
  soliloquy: 'soliloquies',
  syllabus: 'syllabi',
  testis: 'testes',
  thief: 'thieves',
  tooth: 'teeth',
  tornado: 'tornadoes',
  trilby: 'trilbys',
  turf: 'turfs',
  valve: 'valves',
  wave: 'waves',
  wife: 'wives',
  woman: 'women',
  zombie: 'zombies',
};

const RULES: Array<[RegExp, string]> = [
  [/(s)tatus$/i, '$1tatuses'],
  [/(quiz)$/i, '$1zes'],
  [/^(ox)$/i, '$1en'],
  [/([m|l])ouse$/i, '$1ice'],
  [/(matr|vert|ind)(ix|ex)$/i, '$1ices'],
  [/(x|ch|ss|sh)$/i, '$1es'],
  [/([^aeiouy]|qu)y$/i, '$1ies'],
  [/(hive|gulf)$/i, '$1s'],
  [/(?:([^f])fe|([lr])f)$/i, '$1$2ves'],
  [/sis$/i, 'ses'],
  [/([ti])um$/i, '$1a'],
  [/(tax)on$/i, '$1a'],
  [/(c)riterion$/i, '$1riteria'],
  [/(p)erson$/i, '$1eople'],
  [/(m)an$/i, '$1en'],
  [/(c)hild$/i, '$1hildren'],
  [/(f)oot$/i, '$1eet'],
  [/(buffal|her|potat|tomat|volcan)o$/i, '$1oes'],
  [/(alumn|bacill|cact|foc|fung|nucle|radi|stimul|syllab|termin|vir)us$/i, '$1i'],
  [/us$/i, 'uses'],
  [/(alias)$/i, '$1es'],
  [/(analys|ax|cris|test|thes)is$/i, '$1es'],
  [/s$/, 's'],
  [/^$/, ''],
  [/$/, 's'],
];

function matchCase(value: string, comparison: string): string {
  if (comparison === comparison.toUpperCase() && comparison !== comparison.toLowerCase()) {
    return value.toUpperCase();
  }
  if (comparison[0] && comparison[0] === comparison[0].toUpperCase()) {
    return value[0].toUpperCase() + value.slice(1);
  }
  return value;
}

export function plural(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) {
    return word;
  }
  const irregular = IRREGULAR[lower];
  if (irregular) {
    return matchCase(irregular, word);
  }
  for (const [rule, replacement] of RULES) {
    if (rule.test(word)) {
      return word.replace(rule, replacement);
    }
  }
  return word;
}

/** `Str::pluralStudly`: pluralizes the last word of a StudlyCase name. */
export function pluralStudly(value: string): string {
  const parts = value.split(/(?=[A-Z])/);
  const last = parts.pop() ?? '';
  return parts.join('') + plural(last);
}

/** `Str::snake` */
export function snake(value: string): string {
  if (value === value.toLowerCase()) {
    return value;
  }
  return value
    .replace(/\s+/g, '')
    .replace(/(.)(?=[A-Z])/g, '$1_')
    .toLowerCase();
}

/** The default table of a model class: `App\Models\UserProfile` → `user_profiles`. */
export function tableForModel(className: string): string {
  const basename = className.split('\\').pop() ?? className;
  return snake(pluralStudly(basename));
}

/** The table `constrained()` guesses from a foreign key column: `user_id` → `users`. */
export function tableForForeignKey(column: string): string {
  const base = column.replace(/_id$/, '');
  const parts = base.split('_');
  const last = parts.pop() ?? '';
  return [...parts, plural(last)].join('_');
}
