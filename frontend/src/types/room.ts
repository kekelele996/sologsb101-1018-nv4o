/**
 * 荫房记录（Room）数据模型
 * 每次入荫房的温湿度与出入房时间，是漆层缺陷回溯的关键依据。
 * 区间判定仅反映当时环境；每条记录可补记一次复检，判定与超标次数以复检结论为准。
 */

/** 区间判定结论：适宜 / 偏干 / 偏湿 */
export type RoomVerdict = 'suitable' | 'dry' | 'wet';

/** 复检结论：复检通过 / 判返工 */
export type RoomRecheckVerdict = 'pass' | 'rework';

/** 补记的复检信息：结论、复检人、复检日期（yyyy-MM-dd）、备注 */
export interface RoomRecheck {
  verdict: RoomRecheckVerdict;
  /** 复检人 */
  inspector: string;
  /** 复检日期 yyyy-MM-dd */
  date: string;
  /** 复检备注，可空 */
  note?: string;
}

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
  /** 区间判定结论（仅由温湿度区间得出，复检不覆盖该字段） */
  verdict: RoomVerdict;
  /** 补记的复检结论；null / undefined 表示尚未复检 */
  recheck?: RoomRecheck | null;
  createdAt: number;
  updatedAt: number;
}

export type RoomDraft = Omit<Room, 'id' | 'createdAt' | 'updatedAt'>;

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

export const ROOM_RECHECK_VERDICT_LABEL: Record<RoomRecheckVerdict, string> = {
  pass: '复检通过',
  rework: '复检返工',
};

export const ROOM_RECHECK_VERDICT_COLOR: Record<RoomRecheckVerdict, string> = {
  pass: '#2f6f4f',
  rework: '#b03a2e',
};

export const ROOM_RECHECK_VERDICT_OPTIONS: ReadonlyArray<{ value: RoomRecheckVerdict; label: string; description: string }> = [
  { value: 'pass', label: '复检通过', description: '只摘除本记录挂在各道次上的待复检标记，其他记录挂的标记照常保留' },
  { value: 'rework', label: '返工', description: '本记录关联的道次退回「待打磨」，重做打磨完成后标记才摘除' },
];

export function createEmptyRoomDraft(bodyId: string): RoomDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    bodyId,
    date: today,
    tempC: 24,
    humidityPct: 75,
    inAt: '09:00',
    outAt: '21:00',
    verdict: 'suitable',
    recheck: null,
  };
}

export function createEmptyRoomRecheckDraft(verdict: RoomRecheckVerdict = 'pass'): RoomRecheckDraft {
  return {
    verdict,
    inspector: '',
    date: new Date().toISOString().slice(0, 10),
    note: '',
  };
}

/**
 * 有效区间判定：复检通过按「适宜」计；未复检或判返工保留原区间判定。
 * 统计、筛选与超标次数一律使用该结果，不直接读 room.verdict。
 */
export function effectiveRoomVerdict(room: Pick<Room, 'verdict' | 'recheck'>): RoomVerdict {
  if (room.recheck?.verdict === 'pass') return 'suitable';
  return room.verdict;
}

/** 是否计为超标：未复检的偏干/偏湿、或复检判返工，均算超标；复检通过不再超标 */
export function roomIsOver(room: Pick<Room, 'verdict' | 'recheck'>): boolean {
  if (room.recheck) return room.recheck.verdict === 'rework';
  return room.verdict !== 'suitable';
}

/** 是否已挂起待复检（超标且尚未补记复检） */
export function roomRecheckPending(room: Pick<Room, 'verdict' | 'recheck'>): boolean {
  return room.recheck === null || room.recheck === undefined
    ? room.verdict !== 'suitable'
    : false;
}

/** 判定文案（含复检结论后缀），用于卡片回显、返工清单等 */
export function roomVerdictText(room: Pick<Room, 'verdict' | 'recheck'>): string {
  const base = ROOM_VERDICT_LABEL[effectiveRoomVerdict(room)];
  if (room.recheck?.verdict === 'pass') return `${base}（复检通过）`;
  if (room.recheck?.verdict === 'rework') return `${ROOM_VERDICT_LABEL[room.verdict]}（复检返工）`;
  return base;
}
