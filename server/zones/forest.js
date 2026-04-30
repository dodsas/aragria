// Forest zone — 5×5 그리드. 절차 생성 + 명명된 칸 오버라이드.
// (0,0)의 west 출구는 town zone(temple)을 가리킨다 — zone 간 연결.

const FOREST_SIZE = 5;

const OVERRIDES = {
  '0_0': {
    name: '숲 입구',
    desc: '신전 동쪽의 숲 가장자리. 울창한 나무들이 빛을 가리기 시작한다.',
    objects: ['forest_signpost'],
  },
  '4_0': {
    name: '북동 안개',
    desc: '짙은 안개가 깔린 숲의 북동쪽 끝. 나무 사이로 바람 소리만 들린다.',
  },
  '3_1': {
    name: '옹달샘',
    desc: '맑은 물이 솟는 작은 샘. 이끼 낀 바위에 둘러싸여 있다.',
    objects: ['spring'],
  },
  '2_2': {
    name: '숲 광장',
    desc: '거대한 고목이 하늘을 떠받치는 둥근 빈터. 잎 사이로 햇빛이 내려앉는다.',
    objects: ['ancient_tree'],
  },
  '1_3': {
    name: '버섯 군락',
    desc: '낙엽 위로 핏빛 갓의 버섯이 줄지어 자라 있다.',
    objects: ['mushrooms'],
  },
  '0_4': {
    name: '부서진 사당',
    desc: '돌기둥이 무너진 작은 사당터. 이끼가 모든 것을 덮고 있다.',
    objects: ['stone_pillar'],
  },
  '4_4': {
    name: '숲의 심장',
    desc: '숲의 가장 깊은 곳. 짙은 그늘 속에 검은 돌 제단이 서 있다.',
    objects: ['forest_altar'],
  },
};

function buildRooms() {
  const out = {};
  for (let r = 0; r < FOREST_SIZE; r++) {
    for (let c = 0; c < FOREST_SIZE; c++) {
      const id = `forest_${c}_${r}`;
      const exits = {};
      if (r > 0) exits.north = `forest_${c}_${r - 1}`;
      if (r < FOREST_SIZE - 1) exits.south = `forest_${c}_${r + 1}`;
      if (c > 0) exits.west = `forest_${c - 1}_${r}`;
      if (c < FOREST_SIZE - 1) exits.east = `forest_${c + 1}_${r}`;
      // 모서리 칸의 외부 연결: 숲 입구는 신전과 이어진다.
      if (c === 0 && r === 0) exits.west = 'temple';

      const ov = OVERRIDES[`${c}_${r}`] || {};
      out[id] = {
        name: ov.name || `숲 (${c},${r})`,
        desc: ov.desc || '울창한 나무들 사이로 좁은 길이 이어진다.',
        exits,
        objects: ov.objects || [],
      };
    }
  }
  return out;
}

export default {
  id: 'forest',
  name: '동쪽 숲',

  rooms: buildRooms(),

  objects: {
    forest_signpost: {
      name: '나무 표지판',
      desc: '낡은 나무 표지판에 서툰 글씨로 "숲 안쪽엔 들어가지 마시오"라 새겨져 있다.',
    },
    ancient_tree: {
      name: '고목',
      desc: '천 년은 됐을 법한 거대한 나무. 줄기에 사람 형상의 뒤틀린 흉터가 있다.',
      view: {
        icon: '✤',
        title: '천 년의 고목',
        tags: ['신성', '자연'],
        stats: [
          { label: '수령', value: 92, max: 100 },
          { label: '정령 친화', value: 64, max: 100 },
        ],
        lore: '뿌리가 어디까지 뻗어 있는지 누구도 모른다.',
      },
    },
    spring: {
      name: '옹달샘',
      desc: '바닥의 자갈까지 비치는 맑은 샘물. 한 모금 마시면 피로가 가시는 듯하다.',
    },
    mushrooms: {
      name: '핏빛 버섯',
      desc: '핏빛 갓의 버섯이 군락을 이루고 있다. 만지면 위험할지도 모른다.',
    },
    stone_pillar: {
      name: '부서진 돌기둥',
      desc: '깨진 돌기둥에 잊혀진 룬 문양이 새겨져 있다.',
      view: {
        icon: '⚱',
        title: '잊혀진 사당의 돌기둥',
        tags: ['고대', '훼손'],
        stats: [
          { label: '룬 잔존', value: 21, max: 100 },
        ],
        lore: '문양은 지워졌지만, 신성의 기운은 아직 머문다.',
      },
    },
    forest_altar: {
      name: '검은 제단',
      desc: '숲 속에 외따로 선 검은 돌 제단. 표면에 마른 핏자국이 남아 있다.',
      view: {
        icon: '☗',
        title: '숲의 검은 제단',
        tags: ['금기', '의식'],
        stats: [
          { label: '봉인', value: 4, max: 100 },
          { label: '오염', value: 88, max: 100 },
        ],
        lore: '여기서 무언가가 깨어나고 있다.',
      },
    },
  },

  spawns: [],
};
