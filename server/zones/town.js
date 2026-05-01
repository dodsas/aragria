// Town zone — 광장/시장/신전. 손으로 쓴 룸들.
// 신전의 east 출구는 forest zone(forest_0_0)을 가리킨다 — zone 간 연결.

export default {
  id: 'town',
  name: '아그리아 시가지',

  rooms: {
    square: {
      name: '아그리아 광장',
      desc: '돌로 포장된 넓은 광장이다. 분수에서 물이 흐르고, 북쪽으로 시장이, 동쪽으로 신전이 보인다.',
      exits: { north: 'market', east: 'temple' },
      objects: ['fountain', 'crystal'],
    },
    market: {
      name: '시장 거리',
      desc: '상인들의 외침이 가득한 좁은 거리. 남쪽으로 광장이 있다.',
      exits: { south: 'square' },
      objects: ['stall'],
    },
    temple: {
      name: '낡은 신전',
      desc: '먼지 쌓인 석상이 줄지어 서 있다. 서쪽으로 광장이, 동쪽으로 울창한 숲이 보인다.',
      exits: { west: 'square', east: 'forest_0_0' },
      objects: ['statue'],
    },
  },

  objects: {
    fountain: {
      name: '분수',
      desc: '맑은 물이 끊임없이 솟아오른다.',
    },
    crystal: {
      name: '수정 조각상',
      desc: '광장 한가운데 박힌 푸른 수정. 안쪽에서 빛이 맥박처럼 뛴다.',
      view: {
        icon: '◆',
        title: '아그리아의 수정',
        tags: ['신성', '고대유물'],
        stats: [
          { label: '마나 공명', value: 87, max: 100 },
          { label: '균열도', value: 12, max: 100 },
        ],
        lore: '천 년 전, 첫 왕이 이곳에 박아 넣었다고 전해진다.',
      },
    },
    stall: {
      name: '노점',
      desc: '먹을거리와 잡화가 어지러이 쌓여 있다.',
    },
    statue: {
      name: '석상',
      desc: '얼굴이 깎여나간 옛 신의 석상.',
      view: {
        icon: '☖',
        title: '잊혀진 신의 석상',
        tags: ['고대', '훼손'],
        stats: [
          { label: '봉인 강도', value: 3, max: 100 },
        ],
        lore: '이름은 더 이상 누구도 기억하지 못한다.',
      },
    },
  },

  spawns: [
    { roomId: 'market', defId: 'goblin' },
    { roomId: 'temple', defId: 'skeleton' },
  ],
};
