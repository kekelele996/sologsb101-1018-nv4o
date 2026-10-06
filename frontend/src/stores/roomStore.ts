/**
 * 荫房记录状态管理（Zustand）
 * 维护荫房记录、复检补记与超标派生统计。
 *
 * 与道次待复检标记的联动（标记来源按荫房记录 id 引用计数，见 coatStore）：
 * - 新建 / 编辑后区间判定超标的记录，给同胎体当时未完成的道次挂标；
 * - 每条记录可补记一次复检（结论 / 复检人 / 日期 / 备注）：
 *   · 复检通过：摘除「本记录」挂在各道次上的标记，其他记录挂的标记照常保留；
 *   · 判返工：本记录关联道次退回「待打磨」，重做打磨完成后才摘标记；
 *   · 撤销复检：恢复按区间判定联动（重新挂标）；
 * - 删除记录前先摘除其全部挂标。
 * 判定展示与超标次数一律以复检结论为准（effectiveRoomVerdict / roomIsOver）。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Room, RoomDraft, RoomRecheck, RoomRecheckDraft, RoomVerdict } from '@/types/room';
import { effectiveRoomVerdict, roomIsOver } from '@/types/room';
import { judgeVerdict } from '@/utils/humidity';
import { useCoatStore } from './coatStore';

interface RoomStoreState {
  rooms: Room[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadRooms: () => Promise<void>;
  roomsOfBody: (bodyId: string) => Room[];
  createRoom: (draft: RoomDraft) => Promise<Room>;
  updateRoom: (id: string, patch: Partial<Room>) => Promise<void>;
  /** 补记 / 修改 / 撤销（recheck 传 null）复检；同步道次挂标与返工退回 */
  saveRoomRecheck: (id: string, recheck: RoomRecheckDraft | null) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  /** 超标次数（以复检结论为准） */
  overCount: () => number;
  overCountOfBody: (bodyId: string) => number;
  verdictCount: () => Record<RoomVerdict, number>;
}

/** 按复检结论重算一条记录对道次挂标的影响 */
async function reconcileFlags(
  room: Pick<Room, 'id' | 'bodyId' | 'verdict' | 'recheck'>,
  previousBodyId?: string,
): Promise<void> {
  const coatStore = useCoatStore.getState();
  // 编辑时更换了关联胎体：先从旧胎体道次上摘除本记录的挂标
  if (previousBodyId && previousBodyId !== room.bodyId) {
    await coatStore.removeRoomRecheckFlag(room.id);
  }
  if (room.recheck?.verdict === 'pass') {
    await coatStore.removeRoomRecheckFlag(room.id);
    return;
  }
  if (room.recheck?.verdict === 'rework') {
    // 标记保留（重做打磨完成才摘），并把关联道次退回待打磨
    await coatStore.applyRoomRework(room.id);
    return;
  }
  // 未复检：按区间判定联动。先摘除旧挂法（覆盖「撤销复检」等状态翻转），
  // 超标的再按当前胎体未完成道次重新挂标（addRoomRecheckFlag 自带去重）
  await coatStore.removeRoomRecheckFlag(room.id);
  if (room.verdict !== 'suitable') {
    await coatStore.addRoomRecheckFlag(room.bodyId, room.id);
  }
}

export const useRoomStore = create<RoomStoreState>((set, get) => ({
  rooms: [],
  loading: false,
  ready: false,
  error: '',

  async loadRooms() {
    set({ loading: true });
    try {
      const rooms = await db.rooms.toArray();
      rooms.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      set({ rooms, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '荫房记录读取失败' });
    }
  },

  roomsOfBody(bodyId) {
    return get()
      .rooms.filter((room) => room.bodyId === bodyId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },

  async createRoom(draft) {
    const now = Date.now();
    const verdict = judgeVerdict(draft.tempC, draft.humidityPct);
    const recheck: RoomRecheck | null = draft.recheck ?? null;
    const row: Room = { ...draft, recheck, verdict, id: createId('room'), createdAt: now, updatedAt: now };
    await db.rooms.put(row);
    await reconcileFlags(row);
    await get().loadRooms();
    return row;
  },

  async updateRoom(id, patch) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    // 复检信息只走 saveRoomRecheck；普通编辑不覆盖既有复检结论
    const recheck = patch.recheck === undefined ? existing.recheck : (patch.recheck ?? null);
    const next: Room = {
      ...existing,
      ...patch,
      tempC,
      humidityPct,
      verdict,
      recheck,
      updatedAt: Date.now(),
    };
    await db.rooms.put(next);
    await reconcileFlags(next, existing.bodyId);
    await get().loadRooms();
  },

  async saveRoomRecheck(id, recheck) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return;
    const next: Room = { ...existing, recheck, updatedAt: Date.now() };
    await db.rooms.put(next);
    await reconcileFlags(next);
    await get().loadRooms();
  },

  async removeRoom(id) {
    // 先摘干净本记录挂在道次上的标记，再删除记录
    await useCoatStore.getState().removeRoomRecheckFlag(id);
    await db.rooms.delete(id);
    await get().loadRooms();
  },

  overCount() {
    return get().rooms.filter((room) => roomIsOver(room)).length;
  },

  overCountOfBody(bodyId) {
    return get().rooms.filter((room) => room.bodyId === bodyId && roomIsOver(room)).length;
  },

  verdictCount() {
    const result: Record<RoomVerdict, number> = { suitable: 0, dry: 0, wet: 0 };
    get().rooms.forEach((room) => {
      result[effectiveRoomVerdict(room)] += 1;
    });
    return result;
  },
}));
