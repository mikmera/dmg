// TODO ability activation...

import type {
  BoostsTable,
  GameType,
  GenderName,
  Generation,
  GenerationNum,
  Generations,
  ID,
  StatID,
  StatsTable,
  TypeName,
} from '@pkmn/data';

import {ConditionKind, Conditions, Player} from './conditions';
import {MOVE_SUGAR, State, bounded} from './state';
import {ABILITIES, RBY_STAT_ORDER, STAT_ORDER, decodeURL, getNature} from './encode';
import {has, is, toID} from './utils';

// Flags can either be specified as key:value or as 'implicits'
// eslint-disable-next-line max-len
const FLAG = /^(?:(?:(?:--?)?(\w+)(?:=|:)([-+0-9a-zA-Z_'’".,/%:= ]+))|((?:--?|\+)[a-zA-Z'’"][-+0-9a-zA-Z_'’".,/%:= ]*))$/;
// Used to splits up the 'value' of a flag into multiple logical sub-flags
const SPLIT_SUBFLAG = /[^+0-9a-zA-Z_'’"/%:= ]/;

// This is perhaps an overly cute trick to allow us to repurpose the existing nesting of the Flags
// structure without causing collisions - no input flag can ever match this unique symbol ('_' was
// chosen because '_' usually refers to "the rest" as well as "private" things, and 'conditions' is
// too annoying to continuously type).
const _ = Symbol('_');
interface Flags {
  general: {[id: string]: string};
  field: {[id: string]: string} & {[_]: {[k in ConditionKind]?: {[id: string]: string}}};
  p1: {[id: string]: string} & {[_]: {[k in ConditionKind]?: {[id: string]: string}}};
  p2: {[id: string]: string} & {[_]: {[k in ConditionKind]?: {[id: string]: string}}};
  move: {[id: string]: string};
}

const DEFAULTS: {[id: string]: 'p1' | 'p2'} = {
  movelastturn: 'p2', hurtthisturn: 'p2', switching: 'p2',
};

const stats = (s: string) =>
  ['hp', 'atk', 'def', 'spa', 'spd', 'spc', 'spe'].map(stat => `${stat}${s}`);
const boosts = (s: string) => [...stats(s).slice(1), `accuracy${s}`, `evasion${s}`];
// Known keys for the various Flags scopes above - in strict mode unknown keys causes errors, note
// that scalar conditions (weather/terrain/status) are 'lifted' out of _ up to the top level
const PLAYER_KNOWN = [
  _, 'species', 'level', 'ability', 'item', 'gender', 'nature', 'ivs', ...stats('ivs'), 'dvs',
  ...stats('dvs'), 'evs', ...stats('evs'), ...boosts('boosts'), 'happiness', 'hp', 'hppercent',
  'maxhp', 'toxiccounter', 'addedtype', 'weight', 'weightkg', 'allies', ...Object.keys(DEFAULTS),
  ...Object.keys(ABILITIES),
];
const KNOWN = {
  general: ['gametype'],
  field: [_, 'weather', 'terrain', 'pseudoweather'],
  p1: PLAYER_KNOWN,
  p2: PLAYER_KNOWN,
  move: ['name', 'hits', 'usez', 'z', 'crit', 'spread', 'consecutive'],
};

const BOOSTS = /(?:((?:\+|-)[1-6])?\s+)?/;
const LEVEL = /(?:Lvl?\s*(\d{1,2})\s+)?/;
// eslint-disable-next-line max-len
const EVS = /((?:\d{1,3}(?:\+|-)?\s*(?:HP|Atk|Def|SpA|SpD|Spe|Spc)(?:\s*\/\s*\d{1,3}(?:\+|-)?\s*(?:HP|Atk|Def|SpA|SpD|Spe|Spc)){0,5})?\s+)?/;
const HP = /(?:(100|\d{1,2}(?:\.\d+)?)%\s+)?/;
// eslint-disable-next-line no-misleading-character-class
const POKEMON_AND_ITEM = /(?:([A-Za-z][-0-9A-Za-zé%'’:. ]+)(?:\s*@\s*([A-Za-z][-0-9A-Za-z:' ]+))?)/;
const MOVE_VS = /\s*\[([-0-9A-Za-z', ]+)\]\s+vs\.?\s+/;
const VS = /^vs\.?$/i;

const PHRASE = new RegExp([
  // Attacker
  new RegExp(`^${BOOSTS.source}`), // 1
  LEVEL, // 2
  EVS, // 3
  HP, // 4
  POKEMON_AND_ITEM, // 5 & 6

  // Move
  MOVE_VS, // 7

  // Defender
  BOOSTS, // 8
  LEVEL, // 9
  EVS, // 10
  HP, // 11

  // eslint-disable-next-line no-misleading-character-class
  new RegExp(`${POKEMON_AND_ITEM.source}$`), // 12 & 13
].map(r => r.source).join(''), 'i');

const QUOTED = /^['"].*['"]$/;

interface Phrase {
  p1: {
    id: ID;
    boosts?: number;
    level?: number;
    nature?: {plus?: StatID; minus?: StatID};
    hp?: number;
    evs?: Partial<StatsTable>;
    ability?: ID;
    item?: ID;
  };
  move: {
    id: ID;
    consecutive?: number;
  };
  p2: {
    id: ID;
    boosts?: number;
    level?: number;
    nature?: {plus?: StatID; minus?: StatID};
    hp?: number;
    evs?: Partial<StatsTable>;
    ability?: ID;
    item?: ID;
  };
}

interface ParseContext {
  input: string;
  gen?: number;
  phrase?: {
    input: string;
    output?: Phrase | undefined;
  };
  flags?: {
    input: Array<[ID, string, string, boolean]>;
    output?: {
      general: {[id: string]: string};
      field: {[id: string]: string | {[k in ConditionKind]?: {[id: string]: string}}};
      p1: {[id: string]: string | {[k in ConditionKind]?: {[id: string]: string}}};
      p2: {[id: string]: string | {[k in ConditionKind]?: {[id: string]: string}}};
      move: {[id: string]: string};
    };
  };
}

// DEBUG
// let stringify = JSON.stringify;
// try { stringify = require('json-stringify-pretty-compact'); } catch {}

export function parse(gens: Generation | Generations, s: string, strict = false) {
  const context: ParseContext = {input: s};
  try {
    // Decode the string in case it was URL encoded and then split up the string into
    // whitespace separated tokens (respecting quotes!)
    const argv = tokenize(decodeURL(s));

    // Raw flag key:val in the order they appeared in `s` as well as the raw flag and whether or not
    // the flag came after the 'vs.' token or not (see `vs` below).
    const raw: Array<[ID, string, string, boolean]> = [];
    // Non-flag elements which are to be parsed as the phrase
    const fragments: string[] = [];

    // Whether a 'vs' or 'vs.' was detected when parsing flags. Any implicitly scoped flag before
    // the 'vs' token will be scoped to p1 and any after the token will be scoped to p2. Technically
    // 'vs' can be used on its own absent a valid phrase - we don't really care enough to verify
    // this, and in strict mode it gets checked anyway by other means
    let vs = false;
    // Because disambiguating implicits depends on the generation (boo!) we must make two passes
    // over the args - once to clean them up and figure out the ordering while determining which gen
    // to use, followed by second pass with disambiguates and scopes the parameters
    let g: GenerationNum | undefined = 'num' in gens ? gens.num : undefined;
    for (const arg of argv) {
      if (VS.test(arg)) {
        vs = true;
        fragments.push(arg);
        continue;
      }
      const parsed = parseFlag(arg);
      if (!parsed) {
        fragments.push(arg);
        continue;
      }

      const [id, val] = parsed;
      if (id === 'gen') {
        const n = validateGen(gens, g, val, strict);
        if (n) g = n;
        continue;
      }
      raw.push([id, val, arg, vs]);
    }

    const joined = fragments.join(' ');
    context.flags = {input: raw};
    const [gen, gameType, phrase] = parseGen(gens, g, joined, strict);
    context.gen = gen.num;
    context.phrase = {input: phrase};
    const flags = parseFlags(gen, vs, raw, strict);
    context.flags.output = toParseContext(flags);

    // Useful to include in error messages to reveal how `s` was parsed
    const parsed = phrase ? parsePhrase(gen, phrase) : undefined;
    context.phrase.output = parsed;
    if (phrase && !parsed && strict) throw new Error(`Unable to parse phrase: '${phrase}'`);

    // DEBUG console.log(stringify(context, null, 2) + '\n');
    return build(gen, gameType, parsed, flags, strict);
  } catch (err: any) {
    throw new ParseError(err, context);
  }
}

export class ParseError extends Error {
  readonly cause: Error;
  readonly context: ParseContext;

  constructor(cause: Error, context: ParseContext) {
    super(cause.message);
    this.cause = cause;
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Generation can be specified as [Gen 4] or [4] as well
const GEN = /\[\s*(?:(?:G|g)en)?\s*(\d)\s*(doubles|singles)?\]/gi;

// Gen can be specified by a flag or by passing in a specific Generation object in addition to
// as part of the phrase. We pull any generation information out of the phrase in addition to
// returning the correct Generation object
function parseGen(
  gens: Generation | Generations,
  g: GenerationNum | undefined,
  s: string,
  strict: boolean,
) {
  let gameType: GameType | undefined = undefined;

  let m;
  while ((m = GEN.exec(s))) {
    const n = validateGen(gens, g, m[1], strict);
    if (n) g = n;
    if (m[2]) gameType = toID(m[2]) as GameType;
    s = s.slice(0, m.index) + s.slice(m.index + m[0].length + 1);
  }

  // If no generation flag was specified we can default to the current generation
  const gen = 'num' in gens ? gens : gens.get(g || 8);
  return [gen, gameType, s] as const;
}

function validateGen(
  gens: Generation | Generations,
  g: GenerationNum | undefined,
  val: string,
  strict: boolean,
) {
  const n = Number(val);
  if (isNaN(n) || !bounded('gen', n)) {
    if (strict) throw new Error(`Invalid generation flag '${val}'`);
  } else if ((strict || 'num' in gens) && g && g !== n) {
    throw new Error(`Conflicting values for flag generation: '${g}' vs. '${val}'`);
  } else {
    return n as GenerationNum;
  }
}

// Map from unambiguous flags to the flag namespace they belong to
const UNAMBIGUOUS: {[id: string]: keyof Flags} = {
  gametype: 'general', doubles: 'general', singles: 'general',
  weather: 'field', terrain: 'field', pseudoweather: 'field',
  move: 'move', usez: 'move', z: 'move', crit: 'move',
  hits: 'move', spread: 'move', consecutive: 'move',
};

// ConditionKind aliases to allow for flexible flag naming
const CONDITIONS: {[id: string]: ConditionKind} = {
  weather: 'Weather',
  terrain: 'Terrain',
  pseudoweather: 'Pseudo Weather',
  pseudoweathers: 'Pseudo Weather',
  sidecondition: 'Side Condition',
  sideconditions: 'Side Condition',
  volatile: 'Volatile Status',
  volatiles: 'Volatile Status',
  volatilestatus: 'Volatile Status',
  volatilestatuses: 'Volatile Status',
  status: 'Status',
};

function parseFlags(
  gen: Generation,
  vsScope: boolean,
  raw: Array<[ID, string, string, boolean]>,
  strict: boolean,
) {
  const flags: Flags = {general: {}, field: {[_]: {}}, p1: {[_]: {}}, p2: {[_]: {}}, move: {}};

  const setFlag = (k: keyof Flags, id: ID, val: string, orig: ID) => {
    if (k === 'move' && id === 'move') id = 'name' as ID;
    if (KNOWN[k].includes(id)) {
      // NOTE: all booleans should have been converted to '1' or '0' by parseFlag before this
      if (strict && flags[k][id] && toID(flags[k][id]) !== toID(val)) {
        throw new Error(`Conflicting values for flag '${id}': '${flags[k][id]}' vs. '${val}'`);
      }
      flags[k][id] = val;
    } else if (strict) {
      throw new Error(`Unknown flag '${orig}'`);
    }
  };

  for (let [id, val, origFlag, afterVs] of raw) {
    const origID = id;
    const scope = vsScope ? (afterVs ? 'p2' : 'p1') : undefined;
    if (UNAMBIGUOUS[id]) {
      if (is(id, 'singles', 'doubles')) {
        val = id;
        id = 'gametype' as ID;
      }
      const type = UNAMBIGUOUS[id];
      if (type === 'field') {
        parseConditionFlag(gen, flags, val, origFlag, strict, 'field', true, CONDITIONS[id]);
      } else {
        setFlag(type, id, val, origID);
      }
    } else if (DEFAULTS[id]) {
      setFlag(scope || DEFAULTS[id], id, val, origID);
    } else if (ABILITIES[id]) {
      setFlag(scope || ABILITIES[id], id, val, origID);
    } else if (id === 'attacker' || id === 'p1') {
      parseConditionFlag(gen, flags, val, origFlag, strict, 'p1', true);
    } else if (id === 'defender' || id === 'p2') {
      parseConditionFlag(gen, flags, val, origFlag, strict, 'p2', true);
    } else if (id.startsWith('attacker') || id.startsWith('p1')) {
      id = id.slice(id.charAt(0) === 'p' ? 2 : 8) as ID;
      if (CONDITIONS[id]) {
        parseConditionFlag(gen, flags, val, origFlag, strict, 'p1', true, CONDITIONS[id]);
        continue;
      }
      setFlag('p1', id, val, origID);
    } else if (id.startsWith('defender') || id.startsWith('p2')) {
      id = id.slice(id.charAt(0) === 'p' ? 2 : 8) as ID;
      if (CONDITIONS[id]) {
        parseConditionFlag(gen, flags, val, origFlag, strict, 'p2', true, CONDITIONS[id]);
        continue;
      }
      setFlag('p2', id, val, origID);
      continue;
    } else if (scope && KNOWN[scope].includes(id)) {
      setFlag(scope, id, val, origID);
      continue;
    } else {
      parseConditionFlag(gen, flags, `${id}=${val}`, origFlag, strict, scope, false);
    }
  }

  return flags;
}

// Conditions that are not boolean flags
const CONDITION_NON_BOOLS = [
  'echoedvoice', 'spikes', 'toxicspikes', 'slowstart', 'autotomize', 'stockpile',
  'badlypoisoned', 'badpoisoned', 'toxic', 'tox',
] as ID[];
// Boolean flags that are not conditions
const NON_CONDITION_BOOLS = [
  'usez', 'z', 'crit', 'spread', 'movelastturn', 'hurtthisturn', ...Object.keys(ABILITIES),
] as ID[];

// Flags which canonically take an 's' suffix
const PLURALS = ['ev', 'iv', 'dv', 'boost'] as ID[];

function parseFlag(arg: string, condition = false): [ID, string] | undefined {
  const lower = arg.toLowerCase();
  // 'Type:Null' as part of the phrase will get detected as a flag without this hack
  if (lower === 'type:null') return undefined;
  // Metronome consecutive sugar requires we don't parse Metronome:N as a flag
  if (lower.startsWith('metronome:')) return undefined;
  const m = FLAG.exec(arg);
  if (!m) return undefined;
  if (m[3]) {
    const id = toID(m[3]);
    if (id.startsWith('no')) return [id.slice(2) as ID, '0'];
    if (id.startsWith('is')) return [id.slice(2) as ID, '1'];
    if (id.startsWith('has')) return [id.slice(3) as ID, '1'];
    return [id, '1'];
  } else {
    const id = toID(m[1]);
    const val = QUOTED.test(m[2]) ? m[2].slice(1, -1) : m[2];
    if (id.startsWith('no')) return [id.slice(2) as ID, asBoolean(val) ? '0' : '1'];
    if (id.startsWith('is')) return [id.slice(2) as ID, asBoolean(val) ? '1' : '0'];
    if (id.startsWith('has')) return [id.slice(3) as ID, asBoolean(val) ? '1' : '0'];
    if (!condition && has(NON_CONDITION_BOOLS, id)) return [id, asBoolean(val) ? '1' : '0'];
    if (condition && !has(CONDITION_NON_BOOLS, id)) return [id, asBoolean(val) ? '1' : '0'];
    if (PLURALS.some(p => id.endsWith(p))) return [`${id}s` as ID, val];
    return [id, val];
  }
}

const FIELD_CONDITIONS: ConditionKind[] = ['Weather', 'Terrain', 'Pseudo Weather'];

function parseConditionFlag(
  gen: Generation,
  flags: Flags,
  s: string,
  orig: string,
  strict: boolean,
  scope?: 'p1' | 'p2' | 'field',
  explicit?: boolean,
  kind?: ConditionKind
) {
  const raw = s.split(SPLIT_SUBFLAG).filter(x => x !== null && x !== undefined);
  if (strict && !raw.length) {
    const k = kind ? `${kind} ` : '';
    throw new Error(`Expected '${s}' to contain at least one ${k}condition but found none`);
  }

  for (const arg of raw) {
    let parsed = parseFlag(arg, !!kind);
    if (!parsed) {
      parsed = parseFlag(`+${arg}`, !!kind);
      if (!parsed) {
        throw new Error(`Unable to parse '${arg}' as a flag for a condition from '${s}'`);
      }
    }
    let [id, val] = parsed;

    const condition = Conditions.get(gen, id);
    if (!condition) {
      const a = ABILITIES[id];
      if (!kind && scope !== 'field' && a) {
        const cscope = scope ?? a;
        val = asBoolean(val) ? '1' : '0';
        if (strict && flags[cscope][id] && flags[cscope][id] !== val) {
          throw new Error(
            `Conflicting values for flag '${id}': '${flags[cscope][id]}' vs. '${val}'`
          );
        }
        flags[cscope][id] = val;
        continue;
      }
      if (strict) throw new Error(`Unrecognized or invalid condition '${id}' from '${s}'`);
      continue;
    }

    if (!has(CONDITION_NON_BOOLS, id)) val = asBoolean(val) ? '1' : '0';

    const name = condition[0];
    if (kind && kind !== condition[1]) {
      throw new Error(`Mismatched kind for condition '${name}': '${kind}' vs. '${condition[1]}'`);
    }

    const ckind = condition[1];
    let cscope = scope ?? condition[2];
    if (!cscope) throw new Error(`Ambiguous implicit condition '${id}'`);

    const isField = FIELD_CONDITIONS.includes(ckind);
    if ((isField && cscope !== 'field') || (!isField && cscope === 'field')) {
      if (explicit) throw new Error(`Mismatched scope for condition '${name}'`);
      cscope = 'field';
    }

    if (is(ckind, 'Weather', 'Terrain', 'Status')) {
      id = toID(ckind);
      if (name === 'tox') {
        const n = Number(val);
        if (!isNaN(n)) {
          // We need to reparse the original flag to figure out the difference between +toxic
          // (counter 0) and toxic:1 (counter 1) since by default parseFlag is going to turn +toxic
          // into [toxic, 1] as all booleans get turned into 1 or 0.
          // BUG: if toxic:1 is used in a subflag there is no way to properly discern the count
          const match = FLAG.exec(orig);
          if (match && !match[3]) {
            if (strict && flags[cscope].toxiccounter && flags[cscope].toxiccounter !== val) {
              throw new Error(
                'Conflicting values for flag \'toxiccounter\': ' +
                `'${flags[cscope].toxiccounter}' vs. '${val}'`
              );
            }
            flags[cscope].toxiccounter = val;
          }
        }
      }
      val = toID(name);
      if (strict && flags[cscope][id] && flags[cscope][id] !== val) {
        throw new Error(`Conflicting values for flag '${id}': '${flags[cscope][id]}' vs. '${val}'`);
      }
      flags[cscope][id] = val;
      continue;
    }

    id = toID(name);
    const conditions = flags[cscope][_][ckind] = (flags[cscope][_][ckind] || {});

    if (strict && conditions[id] && conditions[id] !== val) {
      throw new Error(`Conflicting values for condition '${id}': '${conditions[id]}' vs. '${val}'`);
    }
    conditions[id] = val;
  }

  return flags;
}

// Consecutive uses can be specified as part of Metronome
const METRONOME_SUGAR = /^\s*Metronome\s*:?\s*(\d+)?\s*$/i;

function parsePhrase(gen: Generation, s: string) {
  const m = PHRASE.exec(s);
  if (!m) return undefined;

  let item: ID | undefined = undefined;
  let consecutive: number | undefined = undefined;
  if (m[6]) {
    const ms = METRONOME_SUGAR.exec(m[6]);
    if (ms) {
      consecutive = Number(ms[1]) || undefined;
      item = 'metronome' as ID;
    } else {
      item = toID(m[6]) || undefined;
    }
  }

  return {
    p1: {
      boosts: parseInteger(m[1]),
      level: parseInteger(m[2]),
      ...parseSpreadValues(gen, 'ev', false, m[3]),
      hp: parseRational(m[4]),
      ...parsePokemonAndAbility(gen, m[5]),
      item,
    },
    move: {
      id: toID(m[7]),
      consecutive,
    },
    p2: {
      boosts: parseInteger(m[8]),
      level: parseInteger(m[9]),
      ...parseSpreadValues(gen, 'ev', false, m[10]),
      hp: parseRational(m[11]),
      ...parsePokemonAndAbility(gen, m[12]),
      item: toID(m[13]) || undefined,
    },
  } as Phrase;
}

function parseInteger(s: string) {
  const n = parseInt(s);
  return isNaN(n) ? undefined : n;
}

function parseRational(s: string) {
  const n = parseFloat(s);
  return isNaN(n) ? undefined : n;
}

function parsePokemonAndAbility(gen: Generation, s: string) {
  let ability = '';
  let species = toID(s);
  const split = s.split(/\s+/);
  while (species && !gen.species.get(species)) {
    ability += split.shift();
    species = toID(split.join(''));
  }
  return {id: species ? species : toID(s), ability: ability ? toID(ability) : undefined};
}

function parseSpreadValues(
  gen: Generation,
  type: 'iv' | 'ev' | 'dv',
  compact: boolean,
  s?: string,
  checks?: Checks,
) {
  let plus: StatID | undefined;
  let minus: StatID | undefined;
  const vals: Partial<StatsTable> = {};

  if (!s) return type === 'ev' ? {evs: vals} : vals;

  const split = s.split('/');
  if (compact && (split.length < 5 || split.length > 6)) {
    checks?.error(true, `Invalid number of ${type.toUpperCase()}s: ${split.length}`);
    return type === 'ev' ? {evs: vals} : vals;
  }
  const order = split.length === 5 ? RBY_STAT_ORDER : STAT_ORDER;
  for (const [i, v] of split.entries()) {
    let [val, name] = v.trim().split(/\s+/);
    const stat = (name && gen.stats.get(name)) || (compact ? order[i] : undefined);
    if (!stat) {
      checks?.error(true, `Unknown stat for ${type.toUpperCase()}s`);
      continue;
    }
    if (type === 'ev') {
      if (val.endsWith('+')) {
        val = val.slice(0, -1);
        plus = stat;
      } else if (val.endsWith('-')) {
        val = val.slice(0, -1);
        minus = stat;
      }
    }

    if (isNaN(+val)) {
      checks?.number(`${type.toUpperCase()}s`, val);
      continue;
    }
    vals[stat] = +val;
  }

  return type === 'ev' ? {evs: vals, nature: plus || minus ? {plus, minus} : undefined} : vals;
}

interface Checks {
  conflict<T>(k: string, a: T | undefined, b: T | undefined, required?: boolean): T | undefined;
  number<T>(k: string, a: T | undefined, b?: T | undefined, required?: boolean): number | undefined;
  error(condition: boolean, msg: string): void;
}

const REQUIRED = true;

function build(
  gen: Generation,
  gameType: GameType | undefined,
  phrase: Phrase | undefined,
  flags: Flags,
  strict: boolean
): State {
  const conflict = <T>(k: string, a: T | undefined, b: T | undefined, required?: boolean) => {
    if (strict && a && b && toID(a) !== toID(b)) {
      throw new Error(`Conflicting values for ${k}: '${a}' vs. '${b}'`);
    }
    const val = a ?? b;
    // NOTE: regardless of whether we're strict or not the value is required
    if (!val && required) throw new Error(`'${k}' must have a value`);
    return val;
  };
  const checks = {
    conflict,
    number<T>(k: string, a: T | undefined, b?: T | undefined, required?: boolean) {
      const n = conflict(k, a, b, required);
      if (n === undefined || n === null) return undefined;
      // NOTE: regardless of whether we're strict or not we need a number here
      if (isNaN(+n)) throw new Error(`Expected number for ${k}, received '${n}'`);
      return +n;
    },
    error(condition: boolean, msg: string) {
      if (strict && condition) throw new Error(`${msg}`);
    },
  };

  if (flags.general.gametype) {
    gameType = checks.conflict('game type', flags.general.gametype, gameType) as GameType;
  } else if (!gameType) {
    gameType = 'singles';
  }
  if (!is(gameType, 'singles', 'doubles') || gen.num <= 2 && gameType === 'doubles') {
    throw new Error(`Invalid game type '${gameType}' for generation ${gen.num}`);
  }

  const field = buildField(gen, flags, checks);
  const moveOptions = buildMoveOptions(phrase, flags, checks);
  const moveName = moveOptions.name;

  const p1 = buildSide(gen, 'p1', moveName, phrase, flags, checks);
  const p2 = buildSide(gen, 'p2', moveName, phrase, flags, checks);
  const move = State.createMove(gen, moveName, moveOptions, p1.pokemon);

  return {gameType, gen, field, p1, p2, move};
}

function buildField(gen: Generation, flags: Flags, checks: Checks) {
  const pw = flags.field[_]['Pseudo Weather'];
  const pseudoWeather: {[id: string]: {level?: number}} = {};
  if (pw) {
    for (const id in pw) {
      if (has(CONDITION_NON_BOOLS, id)) {
        pseudoWeather[id] = {
          level: checks.number(`Pseudo Weather ${id}`, pw[id], undefined, REQUIRED),
        };
      }
      if (pw[id] === '1') pseudoWeather[id] = {};
    }
  }

  return State.createField(gen, {
    weather: flags.field.weather,
    terrain: flags.field.terrain,
    pseudoWeather,
  });
}

function buildMoveOptions(
  phrase: Phrase | undefined,
  flags: Flags,
  checks: Checks,
) {
  const useZ = checks.conflict('move useZ', flags.move.usez, flags.move.z);
  return {
    name: checks.conflict('move', phrase?.move.id, flags.move.name, REQUIRED)!,
    hits: checks.number('move hits', flags.move.hits),
    consecutive:
      checks.number('move consecutive', phrase?.move.consecutive, flags.move.consecutive as any),
    crit: flags.move.crit ? !!+flags.move.crit : undefined,
    spread: flags.move.spread ? !!+flags.move.spread : undefined,
    useZ: useZ ? !!+useZ : undefined,
  };
}

function buildSide(
  gen: Generation,
  side: Player,
  move: string,
  phrase: Phrase | undefined,
  flags: Flags,
  checks: Checks,
) {
  const f = flags[side];
  const p = phrase?.[side];
  const c = f[_];

  const fillConditions = (kind: ConditionKind) => {
    const obj: {[id: string]: {level?: number}} = {};
    if (c[kind]) {
      for (const id in c[kind]) {
        if (has(CONDITION_NON_BOOLS, id)) {
          obj[id] = {
            level: checks.number(`${side} ${kind} ${id}`, c[kind]![id], undefined, REQUIRED),
          };
        }
        if (c[kind]![id] === '1') obj[id] = {};
      }
    }
    return obj;
  };

  const sideConditions = fillConditions('Side Condition');

  const name = checks.conflict(`${side} species`, p?.id, f.species, REQUIRED)!;

  let gender: GenderName | undefined = undefined;
  if (f.gender) {
    if (is(f.gender, 'M', 'F', 'N')) {
      gender = f.gender as GenderName;
    } else {
      checks.error(true, `Invalid gender: '${f.gender}'`);
    }
  }

  // This isn't correct for 'weird' moves, but this doesn't  need to be exhaustive - users
  // have a plethora of ways they can use to be more explicit here
  let m = gen.moves.get(move);
  if (!m) {
    const match = MOVE_SUGAR.exec(move);
    if (match) m = gen.moves.get(match[2]);
  }
  const stat = !m ? undefined : side === 'p1'
    ? (m.overrideOffensiveStat || (m.category === 'Special' ? 'spa' : 'atk'))
    : (m.overrideDefensiveStat || (m.category === 'Special' ? 'spd' : 'def'));
  // This can really only happen with an invalid move....
  checks.error(!stat && !!p?.boosts, `Ambiguous boosts ${p?.boosts} for ${side}`);

  const spread = parseSpreadValues(gen, 'ev', true, f.evs, checks) as {
    evs: Partial<StatsTable & {spc?: number}>;
    nature?: {plus?: StatID; minus?: StatID};
  };

  const evs = spread?.evs;
  const plusMinus = spread?.nature || p?.nature;
  checks.conflict('nature buff', p?.nature?.plus, spread?.nature?.plus);
  checks.conflict('nature nerf', p?.nature?.minus, spread?.nature?.minus);

  let nature: string | undefined = undefined;
  if (plusMinus && f.nature) {
    nature = f.nature;
    const n = gen.natures.get(f.nature);
    if (n) { // If the nature is invalid State.createPokemon will throw an error anyway
      const expected = `(${[
        plusMinus.plus ? `+${gen.stats.display(plusMinus.plus)}` : '',
        plusMinus.minus ? `+${gen.stats.display(plusMinus.minus)}` : '',
      ].filter(Boolean).join(', ')})`;
      checks.error(!!(
        (plusMinus.plus && plusMinus.plus !== n.plus) ||
        (plusMinus.minus && plusMinus.minus !== n.minus)),
      `Conflicting values for ${side} nature: ${f.nature} is not ${expected}`);
    }
  } else if (p?.nature) {
    nature = getNature(p.nature, p?.evs);
  } else if (f.nature) {
    nature = f.nature;
  }

  const dvs =
    parseSpreadValues(gen, 'dv', true, f.dvs, checks) as Partial<StatsTable & {spc?: number}>;
  const ivs =
    parseSpreadValues(gen, 'iv', true, f.ivs, checks) as Partial<StatsTable & {spc?: number}>;
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const boosts: Partial<BoostsTable & {spc: number}> = {
    accuracy: checks.number(`${side} accuracy boosts`, f.accuracyboosts),
    evasion: checks.number(`${side} evasion boosts`, f.evasionboosts),
  };
  for (const s of [...gen.stats, 'spc'] as (StatID | 'spc')[]) {
    const ev = (p?.evs as StatsTable & {spc: number} | undefined)?.[s];
    const d = gen.stats.display(s);
    // ev[s] may already be populated from the parseSpreadValues call above
    evs[s] = checks.number(`${side} ${d} EVs`, evs[s], ev);
    evs[s] = checks.number(`${side} ${d} EVs`, ev, f[`${s}evs`] as unknown);

    dvs[s] = checks.number(`${side} ${d} DVs`, dvs[s], f[`${s}dvs`] as unknown);
    ivs[s] = checks.number(`${side} ${d} IVs`, ivs[s], f[`${s}ivs`] as unknown);

    if (s === 'hp') continue;

    const boost = stat === s ? p?.boosts : undefined;
    boosts[s] = checks.number(`${side} ${d} boosts`, boost, f[`${s}boosts`] as any);
  }

  if (gen.num <= 2) {
    const pair: Array<[Partial<StatsTable & {spc?: number}>, string]> =
      [[evs, 'EVs'], [dvs, 'DVs'], [ivs, 'IVs']];
    for (const [vals, type] of pair) {
      if (vals.spa !== vals.spd) {
        if (vals.spa !== undefined && vals.spd === undefined) {
          vals.spd = vals.spa;
        } else if (vals.spa === undefined && vals.spd !== undefined) {
          vals.spa = vals.spd;
        } else {
          throw new Error(`SpA and SpD ${type} must match before generation 3`);
        }
      }
      if (gen.num === 1 && vals.spd !== vals.spc) {
        if (vals.spc !== undefined && vals.spd === undefined) {
          vals.spd = vals.spc;
        } else if (vals.spc === undefined && vals.spd !== undefined) {
          vals.spc = vals.spd;
        } else {
          throw new Error(`SpA and SpD ${type} must match before generation 3`);
        }
      }
    }
  }

  let addedType: TypeName | undefined = undefined;
  if (f.addedtype) {
    const type = gen.types.get(f.addedtype);
    if (type) {
      addedType = type.name;
    } else {
      checks.error(true, `'${f.addedtype}' is not a valid addedType`);
    }
  }

  let switching: State.Pokemon['switching'] = undefined;
  if (f.switching) {
    const val = toID(f.switching);
    if (is(val, 'in', 'out')) {
      switching = val as State.Pokemon['switching'];
    } else if (asBoolean(f.switching)) {
      switching = 'out';
    }
  }

  if (f?.hp?.endsWith('%')) {
    const hp = f.hp.slice(0, -1);
    delete f.hp;
    f.hppercent = checks.conflict(`${side} HP percent`, f.hppercent, hp)!;
  }

  const pokemon = State.createPokemon(gen, name, {
    level: checks.number(`${side} level`, p?.level, f.level as unknown),
    item: checks.conflict(`${side} item`, p?.item, f.item),
    ability: checks.conflict(`${side} ability`, p?.ability, f.ability),
    gender,
    happiness: checks.number(`${side} happiness`, f.happiness),
    hp: checks.number(`${side} HP`, f.hp),
    hpPercent: checks.number(`${side} HP percent`, p?.hp, f.hppercent as unknown),
    maxhp: checks.number(`${side} HP`, f.maxhp),
    nature,
    evs,
    weightkg: checks.number(`${side} weight`, f.weightkg, f.weight),
    ivs,
    dvs,
    boosts,
    status: f.status,
    statusState: f.toxiccounter
      ? {toxicTurns: checks.number(`${side} toxic counter`, f.toxiccounter)}
      : undefined,
    addedType,
    moveLastTurnResult: f.movelastturn ? asBoolean(f.movelastturn) : undefined,
    hurtThisTurn: f.hurtthisturn ? asBoolean(f.hurtthisturn) : undefined,
    switching,
    volatiles: fillConditions('Volatile Status'),
  }, side === 'p1' ? move : undefined);

  const abilities: ID[] = [];
  const noabilities: ID[] = [];
  for (const a in ABILITIES) {
    if (f[a]) (asBoolean(f[a]) ? abilities : noabilities).push(toID(a));
  }
  const atks = [];
  if (f.allies) {
    for (const v of f.allies.split(',')) {
      const n = parseInt(v);
      if (!isNaN(n)) {
        atks.push(n);
      } else {
        const id = toID(v);
        if (noabilities.includes(id)) {
          checks.conflict(`${side} ally ability`, 'false', 'true');
        } else if (!abilities.includes(id)) {
          abilities.push(id);
        }
      }
    }
  }

  return State.createSide(gen, pokemon, {
    sideConditions,
    atks: atks.length ? atks : undefined,
    abilities: abilities.length ? abilities : undefined,
  });
}

function asBoolean(s: string) {
  const id = toID(s);
  if (is(id, 'true', '1', 'yes', 'y')) return true;
  if (is(id, 'false', '0', 'no', 'n')) return false;
  throw new TypeError(`Invalid boolean flag value: ${s}`);
}

function toParseContext(flags: Flags) {
  const field: {[k: string]: unknown} = {...flags.field};
  if (Object.keys(flags.field[_]).length) field._ = flags.field[_];
  const p1: {[k: string]: unknown} = {...flags.p1};
  if (Object.keys(flags.p1[_]).length) p1._ = flags.p1[_];
  const p2: {[k: string]: unknown} = {...flags.p2};
  if (Object.keys(flags.p2[_]).length) p2._ = flags.p2[_];
  // TODO: as Context['flags']['output'];
  return {general: flags.general, field, p1, p2, move: flags.move} as any;
}

// https://github.com/mccormicka/string-argv v0.3.0
// MIT License Copyright 2014 Anthony McCormick

// matches nested quotes until the first space outside of quotes:
//  ([^\s'"]([^\s'"]*(['"])([^\3]*?)\3)+[^\s'"]*)
// or match if not a space ' or "
//   [^\s'"]+
// or match "quoted text" without quotes
//   (['"])([^\5]*?)\5
// `\3` and `\5` are a backreference to the quote style (' or ") captured

// NOTE: Modified to only allow double quotes
const TOKENIZE = /([^\s"]([^\s"]*(["])([^\3]*?)\3)+[^\s"]*)|[^\s"]+|(["])([^\5]*?)\5/gi;

function tokenize(s: string): string[] {
  const args: string[] = [];

  let match: RegExpExecArray | null;
  do {
    // Each call to exec returns the next regex match as an array
    match = TOKENIZE.exec(s);
    if (match !== null) {
      // Index 1 in the array is the captured group if it exists
      // Index 0 is the matched text, which we use if no captured group exists
      args.push(firstString(match[1], match[6], match[0])!);
    }
  } while (match !== null);

  return args;
}

// Accepts any number of arguments, and returns the first one that is a string (even empty string)
function firstString(...args: Array<any>): string | undefined {
  for (const arg of args) {
    if (typeof arg === 'string') return arg;
  }
}
