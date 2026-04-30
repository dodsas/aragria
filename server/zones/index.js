// Zone 로더. 부팅 시 한 번 호출돼 zone 모듈들을 머지하여
// 글로벌 ROOMS / OBJECTS / INITIAL_SPAWNS를 만든다. 자세한 계약은 zone.md.
//
// 새 zone을 추가하려면 모듈을 만들고 ZONES 배열에 import & 추가한다.

import town from './town.js';
import forest from './forest.js';

const ZONES = [town, forest];

export function loadZones() {
  const rooms = {};
  const objects = {};
  const spawns = [];

  for (const zone of ZONES) {
    for (const [roomId, def] of Object.entries(zone.rooms || {})) {
      if (rooms[roomId]) {
        throw new Error(`Duplicate room id "${roomId}" — already defined before zone "${zone.id}".`);
      }
      // id와 zone 태그를 자동 부착. zone 정의 측은 신경 쓰지 않는다.
      rooms[roomId] = { ...def, id: roomId, zone: zone.id };
    }
    for (const [key, obj] of Object.entries(zone.objects || {})) {
      if (objects[key]) {
        throw new Error(`Duplicate object key "${key}" — already defined before zone "${zone.id}".`);
      }
      objects[key] = obj;
    }
    if (Array.isArray(zone.spawns)) spawns.push(...zone.spawns);
  }

  return { rooms, objects, spawns };
}
