// CharacterCard classifier.
//
// Two-stage flow:
//   1. LLM call — receives the player's free-form name+description and is
//      asked to emit a strict JSON card. The output is parsed, schema-clamped
//      to known enum values, and returned on success.
//   2. Keyword fallback — if the LLM is unavailable, returned junk, or got
//      schema-clamped to all defaults, we run a regex-based Korean/English
//      keyword match instead. Always produces a card; never returns null.
//
// This is the *only* place free-form user text touches a model. Output is a
// strict enum-only structure, so the worst a malicious description can do is
// pick a different (still valid) archetype. No way to inject arbitrary text
// into the rendered SVG.

import { callLLM } from '../../index.js';
import { PALETTE_NAMES } from './palettes.js';

const ARCHETYPES = ['warrior', 'mage', 'rogue', 'ranger', 'cleric', 'wanderer'];
const RACES = ['human', 'elf', 'dwarf', 'half-orc'];
const BUILDS = ['slim', 'medium', 'stocky'];
const HAIRS = ['short', 'long', 'bald'];
const WEARS = ['none', 'hood', 'helm', 'circlet', 'hat'];
const ARMORS = ['none', 'leather', 'chain', 'plate', 'robe'];
const WEAPONS = ['sword', 'axe', 'staff', 'dagger', 'bow', 'spear', 'mace', 'wand', 'none'];
const OFFHANDS = ['shield', 'dagger', 'tome', 'orb', 'none'];
const ACCENTS = ['rune', 'amulet', 'feather', 'sash', 'belt-pouch', 'none'];
const WEATHERINGS = [0, 1, 2, 3];

function buildPrompt(name, description) {
  return `당신은 다크 판타지 텍스트 MUD "Agria"의 캐릭터 분류기입니다.
플레이어가 입력한 이름과 자유 묘사를 아래 JSON 스키마로만 분류하세요. JSON 외 모든 텍스트(설명·코드 펜스·마크다운·주석)는 절대 포함하지 마세요.

스키마와 허용 값(반드시 정확한 enum 값만 사용):
{
  "race": "human" | "elf" | "dwarf" | "half-orc",
  "build": "slim" | "medium" | "stocky",
  "archetype": "warrior" | "mage" | "rogue" | "ranger" | "cleric" | "wanderer",
  "palette": "iron" | "leather" | "cloth" | "bone" | "verdant",
  "head": {
    "hair": "short" | "long" | "bald",
    "wear": "none" | "hood" | "helm" | "circlet" | "hat"
  },
  "torso": {
    "armor": "none" | "leather" | "chain" | "plate" | "robe",
    "cloak": true | false
  },
  "weapon_main": "sword" | "axe" | "staff" | "dagger" | "bow" | "spear" | "mace" | "wand" | "none",
  "weapon_off": "shield" | "dagger" | "tome" | "orb" | "none",
  "accent": "rune" | "amulet" | "feather" | "sash" | "belt-pouch" | "none",
  "weathering": 0 | 1 | 2 | 3
}

가이드:
- 묘사가 모호하면 wanderer 디폴트(후드 + 가죽 갑옷 + 검 + 망토 + leather 팔레트)
- archetype은 무기·복식 단서가 있으면 그것을 우선 (지팡이/마법 → mage, 단검 → rogue, 활 → ranger, 사제/성스러움 → cleric, 검·도끼·창 → warrior)
- palette는 archetype 톤과 맞물리게: warrior=iron, mage=cloth, cleric=bone, ranger=verdant, rogue/wanderer=leather (단 묘사에 색·재질 단서가 있으면 그것 우선)
- weathering은 폐허·낡은·해진·풍화·녹슨 단서면 2~3, 새것·반짝이는 단서면 0~1, 그 외 1
- mage 또는 cleric은 robe 권장, warrior는 plate/chain, rogue/ranger/wanderer는 leather

플레이어 이름: ${name}
플레이어 묘사: ${description}

위 묘사를 가장 잘 반영하는 JSON 한 개만 출력하세요.`;
}

function safeParseJson(text) {
  if (!text) return null;
  // Greedy match captures from the first { to the last } — handles models
  // that wrap the JSON in code fences or add a leading "Here is the card:"
  // sentence.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function clamp(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// Validate + clamp every field. Returns a fully-defaulted card on garbage
// input (so the composer never sees `undefined`).
function validateCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    race: clamp(raw.race, RACES, 'human'),
    build: clamp(raw.build, BUILDS, 'medium'),
    archetype: clamp(raw.archetype, ARCHETYPES, 'wanderer'),
    palette: clamp(raw.palette, PALETTE_NAMES, 'leather'),
    head: {
      hair: clamp(raw.head?.hair, HAIRS, 'short'),
      wear: clamp(raw.head?.wear, WEARS, 'hood'),
    },
    torso: {
      armor: clamp(raw.torso?.armor, ARMORS, 'leather'),
      cloak: !!raw.torso?.cloak,
    },
    weapon_main: clamp(raw.weapon_main, WEAPONS, 'sword'),
    weapon_off: clamp(raw.weapon_off, OFFHANDS, 'none'),
    accent: clamp(raw.accent, ACCENTS, 'belt-pouch'),
    weathering: WEATHERINGS.includes(raw.weathering) ? raw.weathering : 1,
  };
}

// Heuristic: if the LLM gave us a card that's identical to the all-defaults
// fallback, treat it as low-information and let the keyword path try too.
// Used to detect "the model returned `{}` but we filled everything in" —
// which happens with smaller free-tier classifiers.
function isAllDefaults(card) {
  return card.race === 'human' && card.build === 'medium' &&
    card.archetype === 'wanderer' && card.palette === 'leather' &&
    card.head.hair === 'short' && card.head.wear === 'hood' &&
    card.torso.armor === 'leather' && card.torso.cloak === false &&
    card.weapon_main === 'sword' && card.weapon_off === 'none' &&
    card.accent === 'belt-pouch' && card.weathering === 1;
}

// Korean/English keyword → CharacterCard. Used as fallback and as a base for
// the merge described above. Always produces a card.
function classifyFromKeywords(name, desc) {
  const t = `${name} ${desc}`.toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));

  const archetype =
    has('마법사', '마도사', '마술사', '주술사', '마법', 'wizard', 'mage', 'sorcer') ? 'mage' :
    has('도적', '암살자', '도둑', 'rogue', 'thief', 'assassin') ? 'rogue' :
    has('궁수', '사냥꾼', 'ranger', 'archer', 'hunter') ? 'ranger' :
    has('사제', '신관', '성기사', '팔라딘', 'priest', 'cleric', 'paladin') ? 'cleric' :
    has('전사', '검사', '기사', 'warrior', 'knight', 'fighter') ? 'warrior' :
    'wanderer';

  const weapon_main =
    has('지팡이', 'staff') ? 'staff' :
    has('완드', 'wand') ? 'wand' :
    has('단검', '비수', 'dagger') ? 'dagger' :
    has('도끼', 'axe') ? 'axe' :
    has('창', 'spear', 'lance') ? 'spear' :
    has('활', 'bow') ? 'bow' :
    has('철퇴', '메이스', 'mace', 'flail') ? 'mace' :
    has('검', 'sword', 'blade') ? 'sword' :
    archetype === 'mage' ? 'staff' :
    archetype === 'rogue' ? 'dagger' :
    archetype === 'ranger' ? 'bow' :
    archetype === 'cleric' ? 'mace' :
    'sword';

  const armor =
    archetype === 'mage' || archetype === 'cleric' ? 'robe' :
    archetype === 'warrior' ? (has('판금', 'plate') ? 'plate' : has('체인', '사슬', 'chain', 'mail') ? 'chain' : 'plate') :
    'leather';

  const palette =
    has('금속', '강철', '철', 'iron', 'steel') || archetype === 'warrior' ? 'iron' :
    has('로브', '천', '비단', 'cloth', 'silk') || archetype === 'mage' ? 'cloth' :
    has('해골', '뼈', '시체', '죽음', 'bone', 'undead') || archetype === 'cleric' ? 'bone' :
    has('숲', '나무', '풀', '초록', 'forest', 'green', 'verdant') || archetype === 'ranger' ? 'verdant' :
    'leather';

  const wear =
    archetype === 'mage' ? 'hat' :
    archetype === 'rogue' ? 'hood' :
    archetype === 'cleric' ? 'circlet' :
    archetype === 'warrior' ? 'helm' :
    'hood';

  const weapon_off =
    archetype === 'warrior' ? 'shield' :
    archetype === 'mage' ? 'tome' :
    archetype === 'cleric' ? 'tome' :
    'none';

  const build =
    has('덩치', '거대', '뚱뚱', '튼튼', 'stocky', 'huge') ? 'stocky' :
    has('마른', '날렵', '호리호리', 'slim', 'thin') ? 'slim' :
    'medium';

  const race =
    has('엘프', 'elf') ? 'elf' :
    has('드워프', '난쟁이', 'dwarf') ? 'dwarf' :
    has('오크', '반오크', 'half-orc', 'orc') ? 'half-orc' :
    'human';

  const cloak = has('망토', '클로크', 'cloak', '후드') || archetype === 'wanderer' || archetype === 'rogue';

  const accent =
    has('룬', '마법진', 'rune') ? 'rune' :
    has('펜던트', '목걸이', '부적', 'amulet', 'pendant') ? 'amulet' :
    has('깃털', 'feather') ? 'feather' :
    has('띠', '허리띠', 'sash') ? 'sash' :
    archetype === 'mage' ? 'rune' :
    archetype === 'cleric' ? 'amulet' :
    'belt-pouch';

  const weathering =
    has('낡은', '해진', '풍화', '폐허', '오래', '녹슨', 'worn', 'old', 'rusted') ? 3 :
    has('떠돌이', '방랑', 'wandering') ? 2 :
    has('새것', '반짝', '깨끗', 'shiny', 'new') ? 0 :
    1;

  const hair =
    has('대머리', '민머리', 'bald') ? 'bald' :
    has('긴머리', '긴 머리', 'long hair', 'long-haired') ? 'long' :
    'short';

  return {
    race, build, archetype, palette,
    head: { hair, wear },
    torso: { armor, cloak },
    weapon_main, weapon_off, accent, weathering,
  };
}

export async function classify({ name, description }, opts = {}) {
  const prompt = buildPrompt(name, description);
  const raw = await callLLM(prompt, { timeoutMs: 30_000, ...opts });
  const llmCard = validateCard(safeParseJson(raw));
  if (llmCard && !isAllDefaults(llmCard)) return llmCard;
  // LLM failed, returned junk, or contributed nothing useful — derive from
  // keywords directly so the player still gets a character that reflects
  // their description.
  return classifyFromKeywords(name, description);
}
