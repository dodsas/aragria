// SVG part library for Agria character composition.
//
// Every part is a function `(p) => string` where `p` is a palette object
// from palettes.js. The string is the inner markup of one or more `<g>`
// groups; the composer concatenates them inside a single
// `<svg viewBox="0 0 100 140" ...>` shell.
//
// All parts share the same canvas anchors so different combinations land
// in the right place without per-part offsets:
//   head_center    (50, 30)
//   neck           (50, 46)
//   shoulders      left 37 / right 63
//   hand_main      (30, 86)   (character's right hand — viewer's left)
//   hand_off       (70, 86)   (character's left  hand — viewer's right)
//   feet_center    (50, 130)
//
// Layer order is enforced by compose.js, not by parts.js.

// ----- BODY (legs + torso + arms + hands + neck) ---------------------------

export const BODY = {
  slim: (p) => `<g>
    <path d="M44,92 L42,128 L46,128 L48,95 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M52,95 L54,128 L58,128 L56,92 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <ellipse cx="44" cy="130" rx="4" ry="2" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.5"/>
    <ellipse cx="56" cy="130" rx="4" ry="2" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.5"/>
    <path d="M40,52 Q38,80 42,95 L58,95 Q62,80 60,52 Q55,50 50,50 Q45,50 40,52 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M40,54 Q34,68 32,84 L36,84 Q38,68 44,56 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M60,54 Q66,68 68,84 L64,84 Q62,68 56,56 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <circle cx="34" cy="86" r="2.4" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.5"/>
    <circle cx="66" cy="86" r="2.4" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.5"/>
    <rect x="48" y="42" width="4" height="9" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.4"/>
  </g>`,
  medium: (p) => `<g>
    <path d="M42,92 L40,128 L46,128 L48,95 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M52,95 L54,128 L60,128 L58,92 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <ellipse cx="43" cy="130" rx="4.5" ry="2" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.5"/>
    <ellipse cx="57" cy="130" rx="4.5" ry="2" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.5"/>
    <path d="M37,52 Q34,80 40,95 L60,95 Q66,80 63,52 Q56,50 50,50 Q44,50 37,52 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M37,54 Q30,68 28,86 L33,86 Q35,68 41,56 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M63,54 Q70,68 72,86 L67,86 Q65,68 59,56 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <circle cx="30" cy="86" r="2.6" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.5"/>
    <circle cx="70" cy="86" r="2.6" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.5"/>
    <rect x="47" y="42" width="6" height="9" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.4"/>
  </g>`,
  stocky: (p) => `<g>
    <path d="M40,92 L38,126 L46,126 L48,95 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M52,95 L54,126 L62,126 L60,92 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <ellipse cx="42" cy="128" rx="5" ry="2.2" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.5"/>
    <ellipse cx="58" cy="128" rx="5" ry="2.2" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.5"/>
    <path d="M33,52 Q30,80 36,95 L64,95 Q70,80 67,52 Q58,50 50,50 Q42,50 33,52 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M33,54 Q26,68 24,86 L29,86 Q31,68 37,56 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M67,54 Q74,68 76,86 L71,86 Q69,68 63,56 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <circle cx="26" cy="86" r="2.8" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.5"/>
    <circle cx="74" cy="86" r="2.8" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.5"/>
    <rect x="46" y="42" width="8" height="9" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.4"/>
  </g>`,
};

// ----- HEAD (race-flavored) ------------------------------------------------

export const HEAD = {
  human: (p) => `<g>
    <ellipse cx="50" cy="30" rx="11" ry="13" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.7"/>
    <ellipse cx="46" cy="32" rx="1" ry="1.5" fill="${p.outline}"/>
    <ellipse cx="54" cy="32" rx="1" ry="1.5" fill="${p.outline}"/>
  </g>`,
  elf: (p) => `<g>
    <ellipse cx="50" cy="30" rx="10.5" ry="13.5" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M39,28 L36,22 L41,29 Z" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M61,28 L64,22 L59,29 Z" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.6"/>
    <ellipse cx="46" cy="32" rx="1" ry="1.6" fill="${p.outline}"/>
    <ellipse cx="54" cy="32" rx="1" ry="1.6" fill="${p.outline}"/>
  </g>`,
  dwarf: (p) => `<g>
    <ellipse cx="50" cy="32" rx="12" ry="12" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.7"/>
    <ellipse cx="46" cy="33" rx="1" ry="1.4" fill="${p.outline}"/>
    <ellipse cx="54" cy="33" rx="1" ry="1.4" fill="${p.outline}"/>
    <path d="M40,40 Q42,46 50,47 Q58,46 60,40 Q56,42 50,42 Q44,42 40,40 Z" fill="${p.accent}" stroke="${p.outline}" stroke-width="0.5"/>
  </g>`,
  'half-orc': (p) => `<g>
    <ellipse cx="50" cy="30" rx="12" ry="13.5" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.7"/>
    <ellipse cx="46" cy="31" rx="1.2" ry="1.6" fill="${p.outline}"/>
    <ellipse cx="54" cy="31" rx="1.2" ry="1.6" fill="${p.outline}"/>
    <path d="M46,40 L45,43 L47,41 Z" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.4"/>
    <path d="M54,40 L55,43 L53,41 Z" fill="${p.skin}" stroke="${p.outline}" stroke-width="0.4"/>
  </g>`,
};

// ----- HAIR ----------------------------------------------------------------

export const HAIR = {
  short: (p) => `<g>
    <path d="M40,22 Q42,16 50,15 Q58,16 60,22 Q60,28 58,30 Q55,25 50,24 Q45,25 42,30 Q40,28 40,22 Z" fill="${p.outline}" opacity="0.85"/>
  </g>`,
  long: (p) => `<g>
    <path d="M39,22 Q41,15 50,14 Q59,15 61,22 Q62,38 60,48 L58,48 Q60,38 58,30 Q55,25 50,25 Q45,25 42,30 Q40,38 42,48 L40,48 Q38,38 39,22 Z" fill="${p.outline}" opacity="0.85"/>
  </g>`,
  bald: () => '',
};

// ----- HEADWEAR ------------------------------------------------------------

export const HEADWEAR = {
  none: () => '',
  hood: (p) => `<g>
    <path d="M36,30 Q34,16 50,12 Q66,16 64,30 Q62,28 60,26 Q58,18 50,16 Q42,18 40,26 Q38,28 36,30 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M36,30 Q42,38 50,40 Q58,38 64,30 L64,46 Q56,50 50,50 Q44,50 36,46 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.7" opacity="0.65"/>
  </g>`,
  helm: (p) => `<g>
    <path d="M36,30 Q36,16 50,14 Q64,16 64,30 L64,34 Q56,32 50,32 Q44,32 36,34 Z" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.7"/>
    <rect x="44" y="28" width="12" height="3" fill="${p.outline}" opacity="0.55"/>
    <path d="M50,14 L50,12 L52,11 L50,14 Z" fill="${p.accent}" stroke="${p.outline}" stroke-width="0.3"/>
  </g>`,
  circlet: (p) => `<g>
    <path d="M40,24 Q50,21 60,24 L60,27 Q50,24 40,27 Z" fill="${p.accent}" stroke="${p.outline}" stroke-width="0.5"/>
    <circle cx="50" cy="24" r="1.3" fill="${p.glow}" stroke="${p.outline}" stroke-width="0.3"/>
  </g>`,
  hat: (p) => `<g>
    <path d="M38,24 Q50,2 62,24 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M36,24 L64,24 L62,27 L38,27 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M44,18 L46,17 L46,19 Z" fill="${p.glow}" opacity="0.7"/>
  </g>`,
};

// ----- ARMOR (torso overlay) -----------------------------------------------

export const ARMOR = {
  none: () => '',
  leather: (p) => `<g>
    <path d="M38,52 Q36,80 42,94 L58,94 Q64,80 62,52 Q56,55 50,55 Q44,55 38,52 Z" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.6" opacity="0.85"/>
    <line x1="50" y1="55" x2="50" y2="92" stroke="${p.outline}" stroke-width="0.5" opacity="0.6"/>
    <circle cx="50" cy="62" r="0.8" fill="${p.outline}" opacity="0.6"/>
    <circle cx="50" cy="72" r="0.8" fill="${p.outline}" opacity="0.6"/>
    <circle cx="50" cy="82" r="0.8" fill="${p.outline}" opacity="0.6"/>
  </g>`,
  chain: (p) => `<g>
    <path d="M37,52 Q34,80 40,94 L60,94 Q66,80 63,52 Q56,55 50,55 Q44,55 37,52 Z" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.6"/>
    <g fill="${p.outline}" opacity="0.4">
      <circle cx="42" cy="60" r="0.5"/><circle cx="46" cy="60" r="0.5"/><circle cx="50" cy="60" r="0.5"/><circle cx="54" cy="60" r="0.5"/><circle cx="58" cy="60" r="0.5"/>
      <circle cx="44" cy="65" r="0.5"/><circle cx="48" cy="65" r="0.5"/><circle cx="52" cy="65" r="0.5"/><circle cx="56" cy="65" r="0.5"/>
      <circle cx="42" cy="70" r="0.5"/><circle cx="46" cy="70" r="0.5"/><circle cx="50" cy="70" r="0.5"/><circle cx="54" cy="70" r="0.5"/><circle cx="58" cy="70" r="0.5"/>
      <circle cx="44" cy="75" r="0.5"/><circle cx="48" cy="75" r="0.5"/><circle cx="52" cy="75" r="0.5"/><circle cx="56" cy="75" r="0.5"/>
      <circle cx="42" cy="80" r="0.5"/><circle cx="46" cy="80" r="0.5"/><circle cx="50" cy="80" r="0.5"/><circle cx="54" cy="80" r="0.5"/><circle cx="58" cy="80" r="0.5"/>
      <circle cx="44" cy="85" r="0.5"/><circle cx="48" cy="85" r="0.5"/><circle cx="52" cy="85" r="0.5"/><circle cx="56" cy="85" r="0.5"/>
    </g>
  </g>`,
  plate: (p) => `<g>
    <ellipse cx="36" cy="54" rx="6" ry="4" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.6"/>
    <ellipse cx="64" cy="54" rx="6" ry="4" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M38,55 Q35,80 41,94 L59,94 Q65,80 62,55 Q56,57 50,57 Q44,57 38,55 Z" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M44,60 Q50,62 56,60 L56,75 Q50,77 44,75 Z" fill="${p.outline}" opacity="0.25"/>
    <line x1="50" y1="60" x2="50" y2="92" stroke="${p.outline}" stroke-width="0.5" opacity="0.5"/>
  </g>`,
  robe: (p) => `<g>
    <path d="M34,52 Q30,90 38,108 L62,108 Q70,90 66,52 Q56,55 50,55 Q44,55 34,52 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M50,55 L50,108" stroke="${p.outline}" stroke-width="0.4" opacity="0.5"/>
    <path d="M44,52 Q42,72 48,92" stroke="${p.outline}" stroke-width="0.4" opacity="0.4" fill="none"/>
    <path d="M56,52 Q58,72 52,92" stroke="${p.outline}" stroke-width="0.4" opacity="0.4" fill="none"/>
    <path d="M38,108 L62,108 L60,112 L40,112 Z" fill="${p.accent}" stroke="${p.outline}" stroke-width="0.4" opacity="0.7"/>
  </g>`,
};

// ----- CLOAK (drawn behind body, edges peek around shoulders) --------------

export const CLOAK = (p) => `<g>
  <path d="M30,48 Q22,90 28,118 L36,116 Q34,84 38,52 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6" opacity="0.9"/>
  <path d="M70,48 Q78,90 72,118 L64,116 Q66,84 62,52 Z" fill="${p.cloth}" stroke="${p.outline}" stroke-width="0.6" opacity="0.9"/>
  <circle cx="50" cy="50" r="1.5" fill="${p.accent}" stroke="${p.outline}" stroke-width="0.4"/>
</g>`;

// ----- WEAPON (main hand at ~30,86; up the viewer's left side) -------------

export const WEAPON = {
  none: () => '',
  sword: (p) => `<g>
    <line x1="30" y1="84" x2="22" y2="50" stroke="${p.accent}" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="30" y1="84" x2="22" y2="50" stroke="${p.outline}" stroke-width="0.5"/>
    <rect x="27" y="83" width="6" height="2" fill="${p.outline}"/>
    <rect x="29" y="84" width="2" height="4" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.3"/>
  </g>`,
  axe: (p) => `<g>
    <line x1="30" y1="86" x2="28" y2="58" stroke="${p.leather}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M22,56 L34,53 L34,65 L22,68 Z" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.6"/>
    <path d="M28,56 L28,66" stroke="${p.outline}" stroke-width="0.4" opacity="0.5"/>
  </g>`,
  staff: (p) => `<g>
    <line x1="30" y1="88" x2="32" y2="20" stroke="${p.leather}" stroke-width="1.4" stroke-linecap="round"/>
    <circle cx="32" cy="18" r="3.2" fill="${p.glow}" stroke="${p.outline}" stroke-width="0.5" opacity="0.85"/>
    <circle cx="32" cy="18" r="1.4" fill="#ffffff" opacity="0.7"/>
  </g>`,
  dagger: (p) => `<g>
    <line x1="30" y1="84" x2="27" y2="70" stroke="${p.accent}" stroke-width="1.6" stroke-linecap="round"/>
    <line x1="30" y1="84" x2="27" y2="70" stroke="${p.outline}" stroke-width="0.4"/>
    <rect x="28" y="83" width="4" height="1.5" fill="${p.outline}"/>
    <rect x="29" y="84" width="2" height="3" fill="${p.leather}"/>
  </g>`,
  bow: (p) => `<g>
    <path d="M28,60 Q20,76 28,92" fill="none" stroke="${p.leather}" stroke-width="1.6"/>
    <line x1="28" y1="60" x2="28" y2="92" stroke="${p.outline}" stroke-width="0.4"/>
  </g>`,
  spear: (p) => `<g>
    <line x1="30" y1="92" x2="32" y2="18" stroke="${p.leather}" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M32,16 L29,24 L35,24 Z" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.5"/>
  </g>`,
  mace: (p) => `<g>
    <line x1="30" y1="88" x2="29" y2="62" stroke="${p.leather}" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="29" cy="58" r="4" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.6"/>
    <g fill="${p.outline}">
      <circle cx="26" cy="56" r="0.7"/><circle cx="32" cy="56" r="0.7"/>
      <circle cx="29" cy="54" r="0.7"/><circle cx="29" cy="61" r="0.7"/>
      <circle cx="26" cy="60" r="0.7"/><circle cx="32" cy="60" r="0.7"/>
    </g>
  </g>`,
  wand: (p) => `<g>
    <line x1="30" y1="84" x2="26" y2="68" stroke="${p.leather}" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="26" cy="66" r="1.8" fill="${p.glow}" opacity="0.85"/>
    <circle cx="26" cy="66" r="0.9" fill="#ffffff" opacity="0.7"/>
  </g>`,
};

// ----- OFFHAND (off hand at ~70,86; up the viewer's right side) ------------

export const OFFHAND = {
  none: () => '',
  shield: (p) => `<g>
    <path d="M68,72 Q70,68 76,68 Q82,68 84,72 Q84,86 76,94 Q68,86 68,72 Z" fill="${p.armor}" stroke="${p.outline}" stroke-width="0.7"/>
    <path d="M76,72 L76,90" stroke="${p.outline}" stroke-width="0.5" opacity="0.6"/>
    <path d="M70,80 L82,80" stroke="${p.outline}" stroke-width="0.5" opacity="0.6"/>
    <circle cx="76" cy="80" r="1.4" fill="${p.accent}" stroke="${p.outline}" stroke-width="0.3"/>
  </g>`,
  dagger: (p) => `<g>
    <line x1="70" y1="84" x2="73" y2="72" stroke="${p.accent}" stroke-width="1.6" stroke-linecap="round"/>
    <line x1="70" y1="84" x2="73" y2="72" stroke="${p.outline}" stroke-width="0.4"/>
    <rect x="68" y="83" width="4" height="1.5" fill="${p.outline}"/>
  </g>`,
  tome: (p) => `<g>
    <rect x="66" y="80" width="10" height="12" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.6"/>
    <line x1="71" y1="80" x2="71" y2="92" stroke="${p.outline}" stroke-width="0.4"/>
    <rect x="69" y="84" width="1" height="4" fill="${p.glow}" opacity="0.7"/>
  </g>`,
  orb: (p) => `<g>
    <circle cx="72" cy="86" r="3.5" fill="${p.glow}" stroke="${p.outline}" stroke-width="0.5" opacity="0.85"/>
    <circle cx="72" cy="86" r="1.6" fill="#ffffff" opacity="0.7"/>
  </g>`,
};

// ----- ACCENT (small detail at chest/waist) --------------------------------

export const ACCENT = {
  none: () => '',
  rune: (p) => `<g opacity="0.9">
    <path d="M48,68 L52,68 M50,66 L50,72 M48,72 L52,72" stroke="${p.glow}" stroke-width="0.9" fill="none"/>
    <circle cx="50" cy="69" r="3.5" stroke="${p.glow}" stroke-width="0.4" fill="none" opacity="0.6"/>
  </g>`,
  amulet: (p) => `<g>
    <line x1="46" y1="50" x2="50" y2="62" stroke="${p.outline}" stroke-width="0.4"/>
    <line x1="54" y1="50" x2="50" y2="62" stroke="${p.outline}" stroke-width="0.4"/>
    <circle cx="50" cy="63" r="1.6" fill="${p.glow}" stroke="${p.outline}" stroke-width="0.4"/>
  </g>`,
  feather: (p) => `<g>
    <path d="M40,46 L37,52 L41,50 Z" fill="${p.accent}" stroke="${p.outline}" stroke-width="0.4"/>
    <path d="M39,46 L39,52" stroke="${p.outline}" stroke-width="0.3"/>
  </g>`,
  sash: (p) => `<g>
    <path d="M38,60 L62,72 L62,76 L38,64 Z" fill="${p.accent}" stroke="${p.outline}" stroke-width="0.4" opacity="0.85"/>
  </g>`,
  'belt-pouch': (p) => `<g>
    <rect x="38" y="86" width="24" height="3" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.4"/>
    <rect x="56" y="88" width="4" height="5" fill="${p.leather}" stroke="${p.outline}" stroke-width="0.4"/>
  </g>`,
};

// ----- WEATHERING (overlay on top — scratches, gouges, soot dots) ---------

export const WEATHERING = {
  0: () => '',
  1: (p) => `<g opacity="0.4" stroke="${p.outline}" stroke-width="0.3" fill="none">
    <path d="M42,70 L44,72"/>
    <path d="M58,80 L56,82"/>
  </g>`,
  2: (p) => `<g opacity="0.5" stroke="${p.outline}" stroke-width="0.3" fill="none">
    <path d="M42,70 L44,72"/>
    <path d="M58,80 L56,82"/>
    <path d="M40,90 L43,88"/>
    <path d="M54,60 L57,58"/>
    <path d="M48,76 L51,79"/>
  </g>`,
  3: (p) => `<g opacity="0.55" stroke="${p.outline}" stroke-width="0.4" fill="none">
    <path d="M42,70 L44,72"/>
    <path d="M58,80 L56,82"/>
    <path d="M40,90 L43,88"/>
    <path d="M54,60 L57,58"/>
    <path d="M48,76 L51,79"/>
    <path d="M36,60 L39,62"/>
    <path d="M62,68 L65,66"/>
    <path d="M44,84 L47,86"/>
  </g>`,
};
