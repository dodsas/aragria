// Aragria character palettes — fixed in code so the LLM (or keyword fallback)
// can only pick a name; it never names raw colors. Anything that ships
// requires editing this file, which keeps the cohort visually coherent.
//
// Field meanings (used by parts.js):
//   skin    — exposed skin tone
//   cloth   — base tunic / robe / inner garment
//   armor   — metal or hardened plate (kept low-saturation, "old metal")
//   accent  — secondary highlights (trim, buckles, embroidery)
//   leather — straps, sheath, belt, boot leather
//   outline — stroke color for every shape; never magenta or pure black
//   glow    — magical light (crystal blue / rune purple / cursed red, etc.)

export const PALETTES = {
  iron:    { skin: '#c8a888', cloth: '#3a3a42', armor: '#4a4a52', accent: '#8a8a92', leather: '#5a3a22', outline: '#1a1510', glow: '#4a8acc' },
  leather: { skin: '#c8a888', cloth: '#5a4a3a', armor: '#5a3a22', accent: '#8a6a3a', leather: '#5a3a22', outline: '#2a1510', glow: '#4a8acc' },
  cloth:   { skin: '#c8a888', cloth: '#2a4a4a', armor: '#5a2a3a', accent: '#b89a4a', leather: '#5a3a22', outline: '#1a1a1a', glow: '#8a6acc' },
  bone:    { skin: '#e8d8b8', cloth: '#2a2520', armor: '#c8c0a8', accent: '#6a5a4a', leather: '#5a3a22', outline: '#1a0a0a', glow: '#ff5020' },
  verdant: { skin: '#c8a888', cloth: '#3a5a3a', armor: '#5a4a3a', accent: '#6a4a2a', leather: '#5a3a22', outline: '#1a2510', glow: '#8acc4a' },
};

export const PALETTE_NAMES = Object.keys(PALETTES);
