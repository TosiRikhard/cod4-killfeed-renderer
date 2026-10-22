# cod4-killfeed-renderer

Renders the killfeed of a Call of Duty 4 `.dm_1` demo the way the game draws it, as an overlay for
fragmovies. You drag a demo onto one HTML page. Everything runs in the browser and nothing is uploaded.

**Just use it:** open `dist/cod4-killfeed.html` in Chrome or Edge. The file is self-contained, with the
font, icons and app inlined, so you can copy it anywhere and use it offline.

## What it does

- **Faithful to the game.**
  - Obituaries come from the demo's `EV_OBITUARY` events.
  - They're drawn with the game's own font atlas and kill icons, following the game's rules, ported
    from the client's `CG_Obituary`, `CL_DeathMessagePrint` and message-window code.
  - Defaults: 0.25 s scroll and fade-in, 5 s on screen, 0.5 s fade-out, 4 lines.
  - Icon sizes come from each weapon's kill-icon ratio, and gun icons are mirrored.
  - `^8`/`^9` team colors: your team's color is the allies or axis color you're on.
  - Black drop shadow.
  - Killcam replays are hidden, like in the game.
  - The layout is fitted to 1440p game footage.
- **Fragmovie options.**
  - Keep lines on screen with no fade-out, with any number of lines.
  - Clear the feed each round.
  - Show only the kills involving (or made by) one player.
  - Untick single lines.
  - Game notifications on or off.
- **Your look.**
  - Team, friendly/enemy, neutral and highlight colors.
  - Name color codes on or off.
  - Font, text and icon size, position, shadow.
- **Swappable icons.**
  - Click or drop a PNG on any icon in the page.
  - Change an icon's shape (1:1, 2:1, 4:1) or mirroring.
  - Load a whole icon folder, or download the current set as a starting point.
- **Export.**
  - Transparent WebM (VP9 with alpha).
  - Transparent PNG sequence (zip).
  - H.264 MP4 on a solid background.
  - 720p to 4K at 30/60/120 fps, rendered faster than real time with WebCodecs.
  - Also a PNG of the current frame, and the killfeed as JSON or CSV.

## Folder layout

```text
assets/              Game assets the page is built with (edit or replace freely)
  icons/<name>.png     All the game's kill icons (48 used + 19 spare)
  icons/icons.json     Every weapon -> icon, plus each icon's ratio and flip
  font/                HUD font atlas (gamefonts_pc.png) and glyph metrics (fonts.json)
  strings.json         English UI strings, for game notifications
dist/cod4-killfeed.html  The built page
src/app/             The page: UI, renderer, WebM/MP4/PNG export
src/demo/            .dm_1 demo decoder (from cod4-dm1-tools), runs in a web worker
src/extract/         Pulls the assets above out of a CoD4 install
src/cli.ts           Asset extraction and killfeed JSON from the command line
scripts/build.mjs    Bundles everything into dist/cod4-killfeed.html
```

## Building

Needs Node 22.6 or newer.

```bash
npm install
npm run build          # -> dist/cod4-killfeed.html
npm test               # TEST_DEMO=/path/to/demo.dm_1 npm test also runs the real-demo check
npm run typecheck
```

### Icons

`assets/icons/` holds every kill icon in the game:

- **48 icons that multiplayer kills use.** They're read from all 127 multiplayer weapon files
  (`weapons/mp/*`): each weapon's `killIcon`, `killIconRatio` and `flipKillIcon`, so every weapon and
  attachment variant shows exactly what the game draws. Means of death (headshot, knife, falling,
  crush, impact, suicide) come from the materials `CG_Obituary` uses. Weapons without a kill icon
  (flash grenade, AC-130, ...) get the skull, like in the game.
- **19 spare kill-icon images that no multiplayer weapon uses**, for custom mappings. For example:
  `mg42`, `minigun`, `javelin`, `stinger`, `shotgun`, `m16a4` (without the grenade launcher),
  `ak47_gp25`, `mp5_suppressor`, the `m4carbine_*` variants, `us_flashgrenade`, `suitcase_bomb`,
  `death_friendly_fire`.

To change an icon, replace its `<name>.png` or edit `icons.json`:

- `"weapons"` maps every weapon (without `_mp`) to an icon, e.g. `"m4_silencer": "m4"`. Point one at
  a spare icon, e.g. `"m4_silencer": "m4carbine_reddot_suppressor"`. Weapons that aren't listed (mods)
  fall back to the name with attachments stripped, then to `"default"`.
- `"deaths"` sets the icons for headshot, melee, falling and so on.
- `"icons"` sets each image's `ratio` (`1:1`, `2:1` or `4:1`) and `flip` (mirrored, so it points at
  the victim).

Then run `npm run build`. You can also skip the rebuild and load the folder in the page.

### Re-extracting the game assets

`assets/` was extracted from a stock CoD4 1.7 install. To pull it again, for example from another
language or a modded install:

```bash
node src/cli.ts assets "/path/to/Call of Duty 4"            # -> assets/
node src/cli.ts assets "/path/to/Call of Duty 4" --out my-assets
node scripts/build.mjs my-assets my-killfeed.html             # build with another asset folder
```

### Killfeed as data

```bash
node src/cli.ts json path/to/demo.dm_1 --out killfeed.json --game "/path/to/Call of Duty 4"
```

## Credits and license

- The demo decoder comes from [`cod4-dm1-tools`](https://github.com/Riyondev/cod4-dm1-tools), which builds on
  [`Iswenzz/CoD4-DM1`](https://github.com/Iswenzz/CoD4-DM1).
- The killfeed rules were ported from the [KisakCOD](https://github.com/SwagSoftware/KisakCOD) decompile.
- The source code is MIT licensed; see `LICENSE`.
- `assets/`, and the `dist/` page that embeds them, contain Activision's game files: kill icons, font
  and UI text. They're not covered by the MIT license.
