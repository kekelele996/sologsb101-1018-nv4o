/**
 * 荫房记录（Room）数据模型
 * 每次入荫房的温湿度与出入房时间，是漆层缺陷回溯的关键依据。
 */

/** 初判结论：适宜 / 偏干 / 偏湿（按温湿度区间机械判定，登记后不改写） */
export type RoomVerdict = 'suitable' | 'dry' | 'wet';

/** 复检结论：通过（漆层无碍）/ 返工（退回打磨） */
export type RoomRecheckVerdict = 'pass' | 'rework';

/** 补记的复检信息 */
export interface RoomRecheck {
  /** 复检结论 */
  verdict: RoomRecheckVerdict;
  /** 复检人 */
  inspector: string;
  /** 复检日期 yyyy-MM-dd */
  date: string;
  /** 复检说明（可选） */
  note: string;
}

/** 复检登记时的草稿（无 id，id 复用荫房记录 id） */
export type RoomRecheckDraft = RoomRecheck;

export interface Room {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 记录日期 yyyy-MM-dd */
  date: string;
  /** 荫房温度（摄氏度） */
  tempC: number;
  /** 相对湿度（%） */
  humidityPct: number;
  /** 入房时间 HH:mm */
  inAt: string;
  /** 出房时间 HH:mm */
  outAt: string;
  /** 初判结论（按温湿度区间判定，登记后冻结，复检不改写本字段） */
  verdict: RoomVerdict;
  /**
   * 该记录挂起的道次 id 名单：初判偏干 / 偏湿时，登记当时该胎体未完成的道次。
   * 每条记录只挂自己的标记；复检通过只摘除本条挂的标记，不影响别的记录。
   */
  flaggedCoatIds: string[];
  /** 补记的复检结论，未复检为 null；判定与超标次数一律以复检结论为准 */
  recheck: RoomRecheck | null;
  createdAt: number;
  updatedAt: number;
}

export type RoomDraft = Omit<Room, 'id' | 'createdAt' | 'updatedAt' | 'verdict' | 'flaggedCoatIds' | 'recheck'>;

export const ROOM_VERDICT_LABEL: Record<RoomVerdict, string> = {
  suitable: '适宜',
  dry: '偏干',
  wet: '偏湿',
};

export const ROOM_VERDICT_COLOR: Record<RoomVerdict, string> = {
  suitable: '#2f6f4f',
  dry: '#c9963c',
  wet: '#3a6ea5',
};

export const ROOM_VERDICT_OPTIONS: ReadonlyArray<{ value: RoomVerdict; label: string }> = [
  { value: 'suitable', label: '适宜' },
  { value: 'dry', label: '偏干' },
  { value: 'wet', label: '偏湿' },
];

export const ROOM_RECHECK_LABEL: Record<RoomRecheckVerdict, string> = {
  pass: '复检通过',
  rework: '判返工',
};

export const ROOM_RECHECK_COLOR: Record<RoomRecheckVerdict, string> = {
  pass: '#2f6f4f',
  rework: '#b03a2e',
};

export const ROOM_RECHECK_OPTIONS: ReadonlyArray<{ value: RoomRecheckVerdict; label: string }> = [
  { value: 'pass', label: '复检通过' },
  { value: 'rework', label: '判返工（关联道次退回待打磨）' },
];

/**
 * 有效判定：以复检结论为准。
 * - 复检通过 → 视同适宜，不再计超标、不再挂待复检；
 * - 判返工 → 保留原偏干 / 偏湿定性，继续计超标；
 * - 未复检 → 取温湿度初判。
 */
export function effectiveRoomVerdict(room: Pick<Room, 'verdict' | 'recheck'>): RoomVerdict {
  if (!room.recheck) return room.verdict;
  return room.recheck.verdict === 'pass' ? 'suitable' : room.verdict === 'suitable' ? 'wet' : room.verdict;
}

/** 是否计入超标次数：未复检且初判超标，或复检判返工；复检通过即摘除 */
export function isRoomOver(room: Pick<Room, 'verdict' | 'recheck'>): boolean {
  if (room.recheck) return room.recheck.verdict === 'rework';
  return room.verdict !== 'suitable';
}

/** 该记录是否仍在挂起待复检（初判超标且未复检） */
export function isRoomPending(room: Pick<Room, 'verdict' | 'recheck'>): boolean {
  return room.verdict !== 'suitable' && room.recheck === null;
}

export function createEmptyRoomDraft(bodyId: string): RoomDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    bodyId,
    date: today,
    tempC: 24,
    humidityPct: 75,
    inAt: '09:00',
    outAt: '21:00',
  };
}

export function createEmptyRoomRecheckDraft(): RoomRecheckDraft {
  return {
    verdict: 'pass',
    inspector: '',
    date: new Date().toISOString().slice(0, 10),
    note: '',
  };
}
