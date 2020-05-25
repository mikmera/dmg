# `@pkmn/dmg`

[![npm
version](https://img.shields.io/npm/v/@pkmn/dmg.svg)](https://www.npmjs.com/package/@pkmn/dmg)
![Test Status](https://github.com/pkmn/dmg/workflows/Tests/badge.svg)

The most accurate and complete multi-generational Pokémon damage calculator package.

`@pkmn/dmg` is the spiritual successor of the `@smogon/calc` library, designed from scratch to be
compatible with the [`@pkmn`](https://github.com/pkmn) ecosystem and based around a scalable
architecture familar with Pokémon Showdown developers. In addition to the improvements made to
architecture and correctness, `@pkmn/dmg` features.

- sophisticated [**text parsing**](PARSING.md) support and the **ability to canonicalize and encode
  calculations**
- generalized pre-computation [**state manipulation**](#appliers) through **'application' of effects**
- **comprehensive multi-hit** support and **OHKO chance** calculation
- improved programmatic support for **recoil and recovery** results
- **non-intrusive support for [mods](#mods)** overriding data or effects
- extensive **tests** build on state of the art [**multi-generational testing
  infrastructure**](TESTING.md)


## Installation

```sh
$ npm install @pkmn/dmg
```

Alternatively, as [detailed below](#browser), if you are using `@pkmn/dmg` in the browser and want a
convenient way to get started, simply depend on a transpiled and minified version via
[unpkg](https://unpkg.com/):

```html
<script src="https://unpkg.com/@pkmn/dex"></script>
<script src="https://unpkg.com/@pkmn/data"></script>
<script src="https://unpkg.com/@pkmn/dmg"></script>
```

## Usage

### Library

TODO `inGen`, `State.createFoo`, `parse`, `calculate`

### CLI

The [`dmg` binary](dmg) can be used to perform damage calculations via the command line.

```sh
dmg +1 252 SpA Gengar @ Choice Specs [Focus Blast] vs. 0 HP / 172+ SpD Blissey --gen=4
+1 252 SpA Choice Specs Gengar Focus Blast vs. 0 HP / 172+ SpD Blissey: 362-428 (55.6 - 65.7%) -- guaranteed 2HKO after Leftovers recovery

$ dmg gengar [focus blast] vs. blissey gen:6
252 SpA Life Orb Gengar Focus Blast vs. 252 HP / 4 SpD Blissey: 263-309 (36.8 - 43.2%) -- 98.7% chance to 3HKO after Leftovers recovery

$ dmg gen=3 mence @ CB [EQ] vs. cune @ lefties
252+ Atk Choice Band Salamence Earthquake vs. 252 HP / 252+ Def Suicune: 121-143 (29.9 - 35.3%) -- guaranteed 4HKO after Leftovers recovery
```

Like the https://calc.pokemonshowdown.com, the CLI relies on predefined sets and heuristics to
minimize the amount of information that needs to be specified in order to perform a calculation. The
[parsing documentation](PARSING.md) covers the syntax in more details.

While not required, the first positional argument to `dmg` can be the format ID (eg. `gen7ou` or
`gen8anythinggoes`) which will scope the sets from
[`@pokemon-showdown/sets`](https://www.npmjs.com/package/@pokemon-showdown/sets) to be drawn from
that particular format (which is especially useful for VGC or Little Cup calculations).

### Browser

The recommended way of using `@smogon/calc` in a web browser is to **configure your bundler**
([Webpack](https://webpack.js.org/), [Rollup](https://rollupjs.org/),
[Parcel](https://parceljs.org/), etc) to minimize it and package it with the rest of your
application. If you do not use a bundler, a convenience `production.min.js` is included in the
package. You simply need to depend on `./node_modules/@pkmn/dmg/build/production.min.js` in a
`script` tag (which is what the unpkg shortcut above is doing), after which **`calc` will be
accessible as a global.** You must also have a `Generations` implementation provided, and it must be
loaded your data layer **before** loading the calc:

```html
<script src="./node_modules/@pkmn/dex/build/production.min.js"></script>
<script src="./node_modules/@pkmn/data/build/production.min.js"></script>
<script src="./node_modules/@pkmn/dmg/build/production.min.js"></script>
```

## Features

### Appliers

`@pkmn/dmg`'s handling of state and the concept of 'Appliers' and their `apply` functions are
perhaps the largest innovation `@pkmn/dmg` provides over previous damage calculators.


TODO

### Improvements

TODO
- multihit
- ohko
- recoil and recovery

### Mods

`@pkmn` packages do not intend to ever provide first class support for mods (non-canonical data or
mechanics), however, `@pkmn/dmg` was carefully designed to make it much more extensible for mods
than `@smogon/calc`. Changes to `@pkmn/dmg`'s **data** can be accomplished via:

- the `override` method exposed, which allows for modifying or adding fields to existing data (this
  is effectively the same as the `overrides` parameters some of `@smogon/calc`'s constructors took)
- exposing additional non-canonical data from `@pkmn/data`'s `Generations` class by providing its
  constructor with a custom `exists` function implementation (useful for National Dex or CAP)
- implementing a custom `@pkmn/dex-types` implementation (possibly with wraps `@pkmn/dex` and add
  in additional data) to implement completely new data.

Depending on the what your modifications entail, you will likely not be able to make use of the
convenience factory methods `State` provides, as they perform some verification of fundamental
Pokémon mechanics, however, you can always build up a `State` object without using these methods.

`@pkmn/dmg` will only use the `@pkmn/dex-types` fields it is aware of, so additional data fields
should not cause problems. However, if you wish to make use of any new fields or if you simply
wish to change the behavior of various mechanics, `calculate` takes an optional `handlers`
parameter that allows you to extend or override the existing handler **mechanics**. You most likely
will wish to leverage the existing exported `Handlers` object as a base.

If your use case requires more extensive modding capabilities (eg. being able to change around
the core damage flow), please open an issue to describe your use case. If there is sufficient
justification, core parts of the algorithm may be broken up and made moddable in the same way
`Handlers` have been.

## References

### Research

- [the ultimate POKéMON
  CENTER](https://web.archive.org/web/20170622160244/http:/upcarchive.playker.info/0/upokecenter/content/pokemon-ruby-version-sapphire-version-and-emerald-version-timing-notes.html) - Peter O
- [The Complete Damage Formula for Diamond &
  Pearl](https://www.smogon.com/dp/articles/damage_formula) - X-Act, Peterko, Kaphotics
- [The Complete Damage Formula for Black &
  White](https://www.smogon.com/bw/articles/bw_complete_damage_formula) - Xfr, Bond697, Kaphotics,
  V4Victini
- [A Complete Guide to the Damage
  Formula](https://www.trainertower.com/dawoblefets-damage-dissertation/) - DaWoblefet, based on
  work by [OZY](http://bbs10.aimix-z.com/mtpt.cgi?room=sonota&mode=view2&f=140&no=27-29)

### Implementations

- [pret](https://github.com/pret) - disassembly of Gens 1-3
- [Pokémon Showdown!](https://github.com/smogon/pokemon-showdown) - Guangcong Luo (Zarel) and
  contributors
- [Long Form Damage
  Calculator](https://docs.google.com/spreadsheets/d/14XBTYYRp1OK5epQzB3SF2ccdSkuA6Jv7UlRQi66pxkY/edit#gid=1621823916)
  by SadisticMystic
- [`@smogon/calc`](https://github.com/smogon/damage-calc) - Honko, Austin and contributors

## License

This package is distributed under the terms of the [MIT
License](https://github.com/pkmn/dmg/blob/master/LICENSE).
