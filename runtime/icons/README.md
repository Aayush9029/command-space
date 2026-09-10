# Extension icons

Command Space bundles monochrome SVG artwork for all 478 icon names published by `@raycast/api` 2.2.1, including deprecated aliases, plus thirteen Command Space aliases. `catalog.json` records each public name, its raw API value, and its bundled asset. `../icon-catalog.mjs` resolves either representation without network access.

Most artwork comes from [Phosphor Icons 2.1.1](https://github.com/phosphor-icons/core), distributed under the [MIT license](LICENSE). Regular and filled variants retain their original vector paths. Command Space supplies the additional SVG compositions in `custom`, including two-digit numbers, progress indicators, disabled states, and window layouts. Compositions that use Phosphor paths remain covered by the included attribution.

The two Raycast logo identifiers resolve to positive and negative command-key symbols. They identify launcher functionality without bundling Raycast's proprietary logo artwork.

Every asset uses paths and geometric shapes. Numbered icons compose outlined digit paths rather than depending on installed fonts. Symbolic colors are applied by the native renderer, including extension tint colors and the current foreground color.
