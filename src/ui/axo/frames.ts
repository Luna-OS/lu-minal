// Axo, the pixel axolotl of the Luna-OS Moon apps: its colours and its 26 x 20 pixel frames, ported
// value for value from Moon Code (src/mascot/axo.ts and src/mascot/frames.ts, which
// scripts/axolotl-frames.py generates there). One string per pixel row; each character is a colour
// key of AXO_COLORS, "." is transparent.

export type AxoMood = "idle" | "work" | "done" | "sleep";

/** Sprite size in pixels. Rendered with half blocks it is 26 columns x 10 rows. */
export const AXO_WIDTH = 26;
export const AXO_HEIGHT = 20;

/** The sprite's colours: the Moon palette plus the axolotl's pink gills. */
export const AXO_COLORS: Readonly<Record<string, string>> = {
  O: "#5b4f9e", // outline
  W: "#fbf7f0", // body (cream-100)
  S: "#ddd6ff", // belly spots
  G: "#f6a8c8", // gills
  g: "#e586b2", // gill stems
  E: "#1d1742", // eyes (night-800)
  e: "#ffffff", // the light in the eyes
  C: "#f7b89a", // cheeks (peach-300)
  M: "#e586b2", // mouth
  L: "#b9aefb", // the laptop lid (lavender-400)
  K: "#8f82e0", // the laptop base
  m: "#f4f1ff", // the moon on the lid (moon-100)
  T: "#ffffff", // sparkle centre
  t: "#7fe3c6", // sparkle (mint-400, Claude's colour)
};

/** The colour of the z's Axo snores while asleep (sky-300, as Moon Code's .mc-axo-z). */
export const AXO_Z_COLOR = "#9ad7f5";

/** One frame: AXO_HEIGHT strings of AXO_WIDTH colour keys. */
export type AxoFrame = readonly string[];

/**
 * The frames per mood: idle (eyes open, blink), sleep, work (two typing frames on the moon
 * laptop with mint sparks) and done (cheering, sparks around).
 */
export const AXO_FRAMES: Readonly<Record<AxoMood, readonly AxoFrame[]>> = {
  idle: [
    [
      "..........................",
      "..........................",
      ".G.......OOOOOOOO.......G.",
      "..G....OOWWWWWWWWOO....G..",
      "...G..OWWWWWWWWWWWWO..G...",
      "....ggWWWWWWWWWWWWWWgg....",
      "GG...OWWWWWWWWWWWWWWO...GG",
      "..GGggWWWeEWWWWeEWWWggGG..",
      ".....OWWWEEWWWWEEWWWO.....",
      "....ggWWCWWWWWWWWCWWgg....",
      "...G.OWWWWWWMMWWWWWWO.G...",
      "..G...OWWWWWWWWWWWWO...G..",
      ".G.....OOWWWWWWWWOO.....G.",
      ".........OOOOOOOO.........",
      "........OWWWWWWWWO.OOO....",
      ".......OOWWSWWSWWOOOWO....",
      "......OWOWWWWWWWWWWWO.....",
      ".......O.OWWWWWWOOOO......",
      "..........OOOOOO..........",
      "..........................",
    ],
    [
      "..........................",
      "..........................",
      ".G.......OOOOOOOO.......G.",
      "..G....OOWWWWWWWWOO....G..",
      "...G..OWWWWWWWWWWWWO..G...",
      "....ggWWWWWWWWWWWWWWgg....",
      "GG...OWWWWWWWWWWWWWWO...GG",
      "..GGggWWWWWWWWWWWWWWggGG..",
      ".....OWWWEEWWWWEEWWWO.....",
      "....ggWWCWWWWWWWWCWWgg....",
      "...G.OWWWWWWMMWWWWWWO.G...",
      "..G...OWWWWWWWWWWWWO...G..",
      ".G.....OOWWWWWWWWOO.....G.",
      ".........OOOOOOOO.........",
      "........OWWWWWWWWO.OOO....",
      ".......OOWWSWWSWWOOOWO....",
      "......OWOWWWWWWWWWWWO.....",
      ".......O.OWWWWWWOOOO......",
      "..........OOOOOO..........",
      "..........................",
    ],
  ],
  sleep: [
    [
      "..........................",
      "..........................",
      ".G.......OOOOOOOO.......G.",
      "..G....OOWWWWWWWWOO....G..",
      "...G..OWWWWWWWWWWWWO..G...",
      "....ggWWWWWWWWWWWWWWgg....",
      "GG...OWWWWWWWWWWWWWWO...GG",
      "..GGggWWWWWWWWWWWWWWggGG..",
      ".....OWWWEEWWWWEEWWWO.....",
      "....ggWWCWWWWWWWWCWWgg....",
      "...G.OWWWWWWOOWWWWWWO.G...",
      "..G...OWWWWWWWWWWWWO...G..",
      ".G.....OOWWWWWWWWOO.....G.",
      ".........OOOOOOOO.........",
      "........OWWWWWWWWO.OOO....",
      ".......OOWWSWWSWWOOOWO....",
      "......OWOWWWWWWWWWWWO.....",
      ".......O.OWWWWWWOOOO......",
      "..........OOOOOO..........",
      "..........................",
    ],
  ],
  work: [
    [
      "..........................",
      ".G......................G.",
      "..G......OOOOOOOO......G..",
      ".......OOWWWWWWWWOO.......",
      "...G..OWWWWWWWWWWWWO..G...",
      "GG..ggWWWWWWWWWWWWWWgg..GG",
      "..G..OWWWWWWWWWWWWWWO..G..",
      "...GggWWWEEWWWWEEWWWggG...",
      ".....OWWWEEWWWWEEWWWO.....",
      "....ggWWCWWWWWWWWCWWgg....",
      "...G.OWWWWWWOOWWWWWWO.G...",
      "......OWWWWWWWWWWWWO...t..",
      "..G....OOWWWWWWWWOO...tTt.",
      ".G.......OOOOOOWW......tG.",
      "..t.....OWWOOOOOOO.OOO....",
      ".tTt...OLLLLLmLLLLOOWO....",
      "..t....OLLLLmLLLLLOWO.....",
      ".......OLLLLmmLLLLOO......",
      ".......OLLLLLLLLLLO.......",
      "........KKKKKKKKKK........",
    ],
    [
      "..........................",
      "..........................",
      ".G.......OOOOOOOO.......G.",
      "..G....OOWWWWWWWWOO....G..",
      "...G..OWWWWWWWWWWWWO..G...",
      "....ggWWWWWWWWWWWWWWgg....",
      "GG...OWWWWWWWWWWWWWWO...GG",
      "..GGggWWWEEWWWWEEWWWggGG..",
      ".....OWWWEEWWWWEEWWWO.....",
      "....ggWWCWWWWWWWWCWWgg....",
      "...G.OWWWWWWOOWWWWWWO.G...",
      ".tG...OWWWWWWWWWWWWO...G..",
      "tTt....OOWWWWWWWWOO.....G.",
      ".t.......WWOOOOOO..OOO....",
      "........OOOOOOOWWO..WO..t.",
      ".......OLLLLLmLLLLOOO..tTt",
      ".......OLLLLmLLLLLOW....t.",
      ".......OLLLLmmLLLLOO......",
      ".......OLLLLLLLLLLO.......",
      "........KKKKKKKKKK........",
    ],
  ],
  done: [
    [
      "..t....................t..",
      ".tTt..................tTt.",
      "..t......OOOOOOOO......t..",
      ".......OOWWWWWWWWOO.......",
      "...G..OWWWWWWWWWWWWO..G...",
      "GG..ggWWWWWWWWWWWWWWgg..GG",
      "..G..OWWWWWWWWWWWWWWO..G..",
      "...GggWWWWEWWWWWEWWWggG...",
      ".....OWWWEWEWWWEWEWWO.....",
      "....ggWWCWWWWWWWWCWWgg....",
      "...G.OWWWWWWMMWWWWWWO.G...",
      "......OWWWWWMMWWWWWO......",
      "..G....OOWWWWWWWWOO....G..",
      ".G.......OOOOOOOO.......t.",
      ".t......OWWWWWWWWO.OOO.tTt",
      "tTt....OOWWSWWSWWOOOWO..t.",
      ".t....OWOWWWWWWWWWWWO.....",
      ".......O.OWWWWWWOOOO......",
      "..........OOOOOO..........",
      "..........................",
    ],
  ],
};
