import {
  BoostID,
  GameType,
  Generation,
  GenerationNum,
  Generations,
  Specie,
  StatsTable,
  toID,
} from '@pkmn/data';
import {PRNG} from '@pkmn/sim';

import {
  Conditions,
  PseudoWeathers,
  SideConditions,
  Statuses,
  Terrains,
  Volatiles,
  Weathers,
} from '../../conditions';
import {
  FieldOptions,
  MoveOptions,
  PokemonOptions,
  SideOptions,
  State,
  setGender,
} from '../../state';
import {is} from '../../utils';
import * as math from '../../math';

export function generate(gens: Generations, prng: PRNG) {
  const gen = gens.get(range(prng, 1, 8) as GenerationNum);
  const gameType = (gen.num >= 3 && prng.randomChance(1, 4)) ? 'doubles' : 'singles';

  const field = generateField(gen, prng);
  const attacker = generateSide(gen, gameType, prng);
  const defender = generateSide(gen, gameType, prng);
  const move = generateMove(gen, gameType, attacker, prng);

  return new State(gen, attacker, defender, move, field, gameType);
}

function generateField(gen: Generation, prng: PRNG) {
  const options: FieldOptions = {};
  if (gen.num >= 2 && prng.randomChance(1, 10)) {
    options.weather = sample(prng, Object.values(Weathers).filter(v => v[1] <= gen.num))[0];
  }
  if (gen.num >= 4) {
    if (prng.randomChance(1, 20)) {
      options.terrain = sample(prng, Object.values(Terrains).filter(v => v[1] <= gen.num))[0];
    }
    const pws = Object.values(PseudoWeathers).filter(v => v[1] <= gen.num);
    options.pseudoWeather = {};
    while (pws.length && prng.randomChance(1, 25)) {
      const pw = toID(sample(prng, pws, true)[0]);
      options.pseudoWeather[pw] = {level: pw === 'echoedvoice' ? range(prng, 1, 5) : 1};
      if (options.pseudoWeather[pw].level === 1) options.pseudoWeather[pw] = {};
    }
  }

  return State.createField(gen, options);
}

const ALLY_ABILITIES = [
  'flowergift', 'battery', 'powerspot', 'steelyspirit', 'friendguard', 'stormdrain',
  'aurabreak', 'darkaura', 'fairyaura', // Aura abilities effect any
];

function generateSide(gen: Generation, gameType: GameType, prng: PRNG) {
  const options: SideOptions = {};
  const scs = Object.values(SideConditions).filter(v => v[1] <= gen.num);
  options.sideConditions = {};
  while (scs.length && prng.randomChance(1, 8)) {
    const sc = toID(sample(prng, scs, true)[0]);
    options.sideConditions[sc] = {level: sc === 'spikes' && gen.num >= 3 ? range(prng, 1, 3) : 1};
    if (options.sideConditions[sc].level === 1) options.sideConditions[sc] = {};
  }
  if (gameType === 'doubles' && prng.randomChance(1, 10)) {
    const a = sample(prng, ALLY_ABILITIES);
    if (gen.abilities.get(a)) options.abilities = [a];
  }
  // NOTE: team is filled in only if Beat Up ends up being the move selected
  const pokemon = generatePokemon(gen, prng);
  return State.createSide(gen, pokemon, options);
}

const BOOSTS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];

function generatePokemon(gen: Generation, prng: PRNG) {
  const options: PokemonOptions = {};

  const species = sample(prng, Array.from(gen.species));
  options.level = prng.randomChance(1, 20) ? range(prng, 1, 100) : 100;
  if (prng.randomChance(1, 100)) {
    options.weighthg = math.round(species.weighthg * prng.next() * 2) + 1;
  }

  if (gen.num >= 2 && prng.randomChance(99, 100)) {
    options.item = sample(prng, Array.from(gen.items)).name;
  }
  if (gen.num >= 3) {
    options.ability =
      sample(prng, Object.values(species.abilities).filter(a => !!gen.abilities.get(a)));
  }
  // NOTE: not worth the complexity of setting gender some fraction of the time
  // NOTE: happiness is set only if Return or Frustration are selected
  if (prng.randomChance(1, 10)) {
    options.status = sample(prng, Object.keys(Statuses));
    if (options.status === 'tox') options.statusState = {toxicTurns: range(prng, 0, 15)};
  }

  const volatiles = Object.values(Volatiles).filter(v =>
    Conditions.get(gen, v[0])?.[1] === 'Volatile Status' && v[0] !== 'Dynamax');
  options.volatiles = {};
  // Special case Dynamax to proc more often than other volatiles
  if (gen.num === 8 && prng.randomChance(1, 4)) options.volatiles.dynamax = {};
  while (volatiles.length && prng.randomChance(1, 8)) {
    const v = toID(sample(prng, volatiles, true)[0]);
    options.volatiles[v] = {level: is(v, 'autotomize', 'stockpile') ? range(prng, 1, 3) : 1};
    if (options.volatiles[v].level === 1) options.volatiles[v] = {};
  }
  if (prng.randomChance(1, 100)) options.addedType = sample(prng, ['Grass', 'Ghost']);

  const nature = gen.num >= 3 ? sample(prng, Array.from(gen.natures)) : undefined;
  options.nature = nature && (nature.plus ? nature.name : undefined);
  options.ivs = {};
  options.evs = {};
  const stats: Partial<StatsTable> = {};

  // NOTE: we iterate to ensure HP gets handled last after all of the other IVs have been
  // rolled so that if we need to compute the expected HP DV in RBY/GSC we are able to
  const order = Array.from(gen.stats).slice(gen.num < 3 ? 1 : 0);
  prng.shuffle(order);
  if (gen.num < 3) order.push('hp');

  let total = 510;
  for (const stat of order) {
    if (gen.num < 3) {
      // We need SpA and SpD to match, so set the other to match whichever was set first
      if (stat === 'spa' && 'spd' in options.ivs) {
        options.ivs.spa = options.ivs.spd;
        options.evs.spa = options.evs.spd;
        stats.spa = stats.spd;
        continue;
      } else if (stat === 'spd' && 'spa' in options.ivs) {
        options.ivs.spd = options.ivs.spa;
        options.evs.spd = options.evs.spa;
        stats.spd = stats.spa;
        continue;
      }
    }
    options.ivs[stat] = stat === 'hp' && gen.num < 3
      ? gen.stats.toIV(gen.stats.getHPDV(options.ivs))
      : prng.randomChance(1, 10) ? range(prng, 0, 31) : 31;
    if (gen.num < 3) options.ivs[stat] = gen.stats.toIV(gen.stats.toDV(options.ivs[stat]!));
    options.evs[stat] = gen.num >= 3
      ? (prng.randomChance(1, 2) ? range(prng, 0, math.min(total, 252)) : math.min(total, 252))
      : (prng.randomChance(1, 20) ? range(prng, 0, 252) : 252);
    total -= options.evs[stat]!;
    stats[stat] = gen.stats.calc(
      stat, species.baseStats[stat], options.ivs[stat], options.evs[stat], options.level, nature
    );
  }

  if (options.volatiles.dynamax || options.ability === 'powerconstruct') {
    const mod = 0.5 * (options.volatiles.dynamax && prng.randomChance(1, 10) ? prng.next() : 1);
    options.maxhp = math.round(stats.hp! * (1 + mod));
  }
  if (prng.randomChance(1, 10)) options.hp = math.round(stats.hp! * prng.next());

  options.boosts = {};
  const boosts = BOOSTS.slice() as BoostID[];
  // eslint-disable-next-line no-unmodified-loop-condition
  while (boosts && prng.randomChance(1, 10)) {
    options.boosts[sample(prng, boosts, true)] = range(prng, 1, 6);
  }
  if (gen.num < 3 && options.boosts.spa !== options.boosts.spd) {
    if (options.boosts.spa) {
      options.boosts.spd = options.boosts.spa;
    } else {
      options.boosts.spa = options.boosts.spd;
    }
  }

  // NOTE: switching/moveLastTurnResult/hurtThisTurn are set when relevant for the particular move
  return State.createPokemon(gen, species.name, options);
}

function generateMove(gen: Generation, gameType: GameType, side: State.Side, prng: PRNG) {
  const pokemon = side.pokemon;

  const options: MoveOptions = {};
  const status = prng.randomChance(1, 200);
  const item = (pokemon.item || undefined) && gen.items.get(pokemon.item!);

  let move = item?.zMoveFrom
    ? gen.moves.get(item.zMoveFrom)!
    : sample(prng, Array.from(gen.moves).filter(m => status ? m.status : !m.status));

  if (move.id === 'hiddenpower' && move.name !== 'Hidden Power') {
    // Change our IVs to match our Hidden Power or change the Hidden Power type to match our IVs
    if (prng.randomChance(3, 5)) {
      const type = gen.types.get(toID(move.name).slice(11))!;
      pokemon.ivs = {};
      if (gen.num < 3) {
        for (const stat of gen.stats) {
          pokemon.ivs[stat] = stat in type.HPdvs ? gen.stats.toIV(type.HPdvs[stat]!) : 31;
        }
        pokemon.ivs.hp = gen.stats.toIV(gen.stats.getHPDV(pokemon.ivs));
      } else {
        for (const stat of gen.stats) {
          pokemon.ivs[stat] = type.HPivs[stat] ?? 31;
        }
      }
      const maxhp = gen.stats.calc(
        'hp', pokemon.species.baseStats.hp, pokemon.ivs.hp, pokemon.evs?.hp ?? 252, pokemon.level
      );
      const fraction = pokemon.hp / pokemon.maxhp;
      pokemon.maxhp = maxhp;
      pokemon.hp = math.round(fraction * maxhp);
      setGender(gen, pokemon as {species: Specie; ivs: StatsTable});
    } else {
      const type = gen.types.getHiddenPower(gen.stats.fill({...pokemon.ivs}, 31)).type;
      move = gen.moves.get(`Hidden Power ${type}`)!;
    }
  }
  if (prng.randomChance(1, 16)) options.crit = true;
  if (move.multihit && typeof move.multihit !== 'number' && !pokemon.volatiles.dynamax) {
    options.hits = range(prng, move.multihit[0], move.multihit[1]);
  }

  if (gen.num >= 3 && gameType === 'doubles' &&
    is(move.target, 'allAdjacent', 'allAdjacentFoes') && prng.randomChance(4, 5)) {
    options.spread = true;
  }
  if (pokemon.item === 'metronome') options.consecutive = range(prng, 1, 10);
  if (gen.num === 7 && !move.isZ &&
      (item?.zMove ? prng.randomChance(4, 5) : prng.randomChance(1, 100))) {
    options.useZ = true;
    options.hits = undefined;
  }

  if (move.id === 'magnitude' && !options.useZ) {
    options.magnitude = range(prng, 4, 10);
  } else if (move.id === 'beatup') {
    const atks = [];
    for (let i = 0; i < range(prng, 0, 5); i++) atks.push(range(prng, 30, 150));
    side = State.createSide(gen, pokemon, {
      sideConditions: side.sideConditions,
      abilities: side.active?.map(p => p?.ability).filter(Boolean) as string[] | undefined,
      atks,
    });
  } else if (is(move.id, 'return', 'frustration') && prng.randomChance(1, 10)) {
    pokemon.happiness = range(prng, 0, 255);
  } else if (move.id === 'stompingtantrum' && prng.randomChance(1, 2)) {
    pokemon.moveLastTurnResult = false;
  } else if (move.id === 'assurance' && prng.randomChance(1, 2)) {
    pokemon.hurtThisTurn = false;
  } else if (move.id === 'pursuit' && prng.randomChance(1, 2)) {
    pokemon.switching = prng.randomChance(1, 2) ? 'in' : 'out';
  }
  return State.createMove(gen, move.name, options, pokemon);
}

function range(prng: PRNG, min: number, max: number) {
  return prng.next(min, max + 1);
}

function sample<T>(prng: PRNG, arr: T[], remove = false) {
  if (arr.length === 0) throw new RangeError('Cannot sample an empty array');
  const index = prng.next(arr.length);
  const val = arr[index];
  if (remove) {
    arr[index] = arr[arr.length - 1];
    arr.pop();
  }
  if (val === undefined && !Object.prototype.hasOwnProperty.call(arr, index)) {
    throw new RangeError('Cannot sample a sparse array');
  }
  return val;
}
