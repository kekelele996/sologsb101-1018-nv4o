/**
 * 荫房记录状态管理（Zustand）
 * 维护荫房记录与超标派生统计。
 * 初判偏干 / 偏湿时，只把该胎体当时未完成的道次记入「本条记录自己的挂起名单」
 * （Room.flaggedCoatIds），再由 coatStore 按名单对账道次的待复检标记：
 * - 复检通过：摘除本条记录挂的标记，别的记录挂的照留；
 * - 判返工：本条挂的关联道次退回待打磨（待复检标记随之闭环到打磨流程）；
 * - 判定与超标次数一律以复检结论为准。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import {
  effectiveRoomVerdict,
  isRoomOver,
  type Room,
  type RoomDraft,
  type RoomVerdict,
  type RoomRecheckDraft,
} from '@/types/room';
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
  removeRoom: (id: string) => Promise<void>;
  /** 按当前未完成道次重新快照本条记录的挂起名单（手动补挂 / 修正用） */
  resnapshotFlags: (id: string) => Promise<void>;
  /** 为单条荫房记录补记复检：通过则摘本条标记，返工则把关联道次退回待打磨 */
  submitRecheck: (id: string, draft: RoomRecheckDraft) => Promise<Room | null>;
  /** 超标次数（以复检结论为准：复检通过不计，判返工仍计） */
  overCount: () => number;
  overCountOfBody: (bodyId: string) => number;
  verdictCount: () => Record<RoomVerdict, number>;
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
    // 只快照该胎体当前未完成的道次，作为本条记录自己的挂起名单
    const openCoatIds = useCoatStore
      .getState()
      .coats.filter((coat) => coat.bodyId === draft.bodyId && coat.state !== 'done')
      .map((coat) => coat.id);
    const row: Room = {
      ...draft,
      verdict,
      flaggedCoatIds: verdict === 'suitable' ? [] : openCoatIds,
      recheck: null,
      id: createId('room'),
      createdAt: now,
      updatedAt: now,
    };
    await db.rooms.put(row);
    await get().loadRooms();
    await useCoatStore.getState().reconcileRecheckFlags();
    return row;
  },

  async updateRoom(id, patch) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    // 编辑温湿度只改初判；已有挂起名单与复检结论属于工序事实，不由表单覆盖。
    // 初判由超标变为适宜且尚未复检时，该条不再构成挂起来源，名单清空。
    const flaggedCoatIds =
      verdict === 'suitable' && existing.recheck === null ? [] : existing.flaggedCoatIds ?? [];
    await db.rooms.update(id, {
      ...patch,
      tempC,
      humidityPct,
      verdict,
      flaggedCoatIds,
      updatedAt: Date.now(),
    } as never);
    await get().loadRooms();
    await useCoatStore.getState().reconcileRecheckFlags();
  },

  async removeRoom(id) {
    await db.rooms.delete(id);
    await get().loadRooms();
    await useCoatStore.getState().reconcileRecheckFlags();
  },

  async resnapshotFlags(id) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing || existing.verdict === 'suitable' || existing.recheck) return;
    const openCoatIds = useCoatStore
      .getState()
      .coats.filter((coat) => coat.bodyId === existing.bodyId && coat.state !== 'done')
      .map((coat) => coat.id);
    await db.rooms.update(id, { flaggedCoatIds: openCoatIds, updatedAt: Date.now() } as never);
    await get().loadRooms();
    await useCoatStore.getState().reconcileRecheckFlags();
  },

  async submitRecheck(id, draft) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return null;
    const now = Date.now();
    const updated: Room = { ...existing, recheck: { ...draft }, updatedAt: now };
    const coatStore = useCoatStore.getState();
    if (draft.verdict === 'rework') {
      // 判返工：本条记录挂过的关联道次退回「待打磨」，待复检标记随对账闭环
      const targets = coatStore.coats.filter((coat) => existing.flaggedCoatIds.includes(coat.id));
      if (targets.length > 0) {
        await db.coats.bulkPut(
          targets.map((coat) => ({
            ...coat,
            state: coat.state === 'done' ? coat.state : 'toPolish',
            updatedAt: now,
          })),
        );
      }
    }
    await db.rooms.put(updated);
    await get().loadRooms();
    // 复检通过：pendingCoatIds 中本条名单消失 → 只摘除本条挂的标记，别的记录照留
    await useCoatStore.getState().reconcileRecheckFlags(await db.rooms.toArray());
    return updated;
  },

  overCount() {
    return get().rooms.filter((room) => isRoomOver(room)).length;
  },

  overCountOfBody(bodyId) {
    return get().rooms.filter((room) => room.bodyId === bodyId && isRoomOver(room)).length;
  },

  verdictCount() {
    const result: Record<RoomVerdict, number> = { suitable: 0, dry: 0, wet: 0 };
    get().rooms.forEach((room) => {
      result[effectiveRoomVerdict(room)] += 1;
    });
    return result;
  },
}));
