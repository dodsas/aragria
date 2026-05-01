// Card → SVG composer.
//
// Pure, deterministic, and fast (<5 ms in practice — string concat + a few
// table lookups). The LLM never reaches this stage; only validated cards do.
// The whole point of the new pipeline is that everything below this line is
// guaranteed correct.

import { PALETTES, HAIR_COLORS } from './palettes.js';
import {
  BODY, HEAD, HAIR, HEADWEAR, ARMOR, CLOAK,
  WEAPON, OFFHAND, ACCENT, WEATHERING,
} from './parts.js';

// Layer order matters — back-to-front so weapons sit on top of arms,
// weathering sits on top of everything, etc.
export function compose(card) {
  const p = PALETTES[card.palette] || PALETTES.leather;
  const hairColor = HAIR_COLORS[card.head.hair_color] || HAIR_COLORS.black;

  const layers = [];
  // 1. Cloak first so the body covers its center, edges peek out.
  if (card.torso.cloak) layers.push(CLOAK(p));
  // 2. Body (legs + torso + arms + neck + hands). Gender shapes the torso.
  layers.push(BODY[card.build](p, card.gender));
  // 3. Armor over torso/shoulders.
  if (card.torso.armor !== 'none') layers.push(ARMOR[card.torso.armor](p));
  // 4. Head, hair, headwear (top-down on the head).
  layers.push(HEAD[card.race](p));
  if (card.head.hair !== 'bald') layers.push(HAIR[card.head.hair](p, hairColor));
  if (card.head.wear !== 'none') layers.push(HEADWEAR[card.head.wear](p));
  // 5. Accent (small chest/waist detail). Sits over armor.
  if (card.accent !== 'none') layers.push(ACCENT[card.accent](p));
  // 6. Weapons (held in hands, drawn over arms).
  if (card.weapon_main !== 'none') layers.push(WEAPON[card.weapon_main](p));
  if (card.weapon_off !== 'none') layers.push(OFFHAND[card.weapon_off](p));
  // 7. Weathering on top.
  if (card.weathering > 0) layers.push(WEATHERING[card.weathering](p));

  return `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg">${layers.join('')}</svg>`;
}
