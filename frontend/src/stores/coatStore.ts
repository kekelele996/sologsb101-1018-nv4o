/**
 * 髹涂道次状态管理（Zustand）
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 *
 * 待复检标记规则（与荫房复检配套）：
 * - coat.recheckRoomIds 为挂起本道次的荫房记录 id 列表（引用计数，来源可追溯）；
 * - coat.needRecheck 是「recheckRoomIds 非空」的派生缓存，任何写库路径统一经
 *   normalizeCoats() 重算，业务代码不直接手改 needRecheck；
 * - 一条超标荫房记录挂标时，只登记当时胎体上未完成（state !== 'done'）的道次；
 * - 复检通过只摘除该记录自身的 id，别的来源照常保留；同一道次被两条记录挂过时，
 *   只登记其中一条的复检不算清掉，必须全部来源闭环（复检通过，或返工重做打磨完成）；
 * - 复检判返工时，关联道次退回「待打磨」；未涂（todo）道次保留原状态。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState, withRecheckDerived } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { useBodyStore } from './bodyStore';

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<Coat>;
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  removeCoat: (id: string) => Promise<void>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<void>;
  /** 一条超标荫房记录给胎体上当时未完成的道次挂「待复检」（登记来源 id） */
  addRoomRecheckFlag: (bodyId: string, roomId: string) => Promise<void>;
  /** 复检通过：摘除该记录在所有道次上的来源 id（不影响其他来源） */
  removeRoomRecheckFlag: (roomId: string) => Promise<void>;
  /**
   * 复检判返工：关联道次退回「待打磨」（已涂 coated / 已完成 done → toPolish；
   * 待涂 todo 保留），来源 id 保留，待重做打磨完成再摘除。
   */
  applyRoomRework: (roomId: string) => Promise<void>;
  /** 打磨完成：摘除该道次上已判返工的来源 id；未复检的挂标来源保留 */
  resolveReworkedRoomsForCoat: (coatId: string, reworkedRoomIds: string[]) => Promise<void>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<void>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
}

/** 统一重算 recheckRoomIds（去重）与派生标记 needRecheck */
function normalizeCoat(coat: Coat): Coat {
  return withRecheckDerived(coat);
}

/** 剥离外部入参里的布尔待复检标记：标记只能经引用计数重算，不能直接手改 */
function withoutDerivedFlag(patch: Partial<Coat>): Partial<Coat> {
  const { needRecheck: _omitted, ...rest } = patch;
  return rest;
}

export const useCoatStore = create<CoatStoreState>((set, get) => ({
  coats: [],
  loading: false,
  ready: false,
  error: '',

  async loadCoats() {
    set({ loading: true });
    try {
      const coats = (await db.coats.toArray()).map(normalizeCoat);
      coats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ coats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '道次读取失败' });
    }
  },

  coatsOfBody(bodyId) {
    return get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  async createCoat(draft) {
    const now = Date.now();
    const row = normalizeCoat({ ...draft, id: createId('coat'), createdAt: now, updatedAt: now });
    await db.coats.put(row);
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    const existing = get().coats.find((coat) => coat.id === id);
    const base = existing ?? ((await db.coats.get(id)) as Coat | undefined);
    if (!base) return;
    const merged = normalizeCoat({ ...base, ...withoutDerivedFlag(patch), id, updatedAt: Date.now() } as Coat);
    await db.coats.put(merged);
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    await db.coats.delete(id);
    if (target) {
      // 删除后按序重编号，保持 seq 连续
      const rest = get()
        .coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((coat, index) => normalizeCoat({ ...coat, seq: index + 1, updatedAt: Date.now() }));
      if (rest.length > 0) await db.coats.bulkPut(rest);
    }
    await get().loadCoats();
  },

  async batchUpdate(ids, patch) {
    if (ids.length === 0) return;
    const now = Date.now();
    const safePatch = withoutDerivedFlag(patch);
    const rows = get()
      .coats.filter((coat) => ids.includes(coat.id))
      // 批量改状态等操作不得绕过引用计数直接清标记：needRecheck 已在上方剥离
      .map((coat) => normalizeCoat({ ...coat, ...safePatch, updatedAt: now } as Coat));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const next = nextCoatState(coat.state);
    if (next === coat.state) return;
    await get().updateCoat(id, { state: next });
  },

  async addRoomRecheckFlag(bodyId, roomId) {
    // 挂标只登记当时未完成的道次；已完成道次不受新记录影响
    const affected = get().coats.filter((coat) => coat.bodyId === bodyId && coat.state !== 'done');
    if (affected.length === 0) return;
    const now = Date.now();
    const rows = affected.map((coat) =>
      normalizeCoat({
        ...coat,
        recheckRoomIds: coat.recheckRoomIds.includes(roomId) ? coat.recheckRoomIds : [...coat.recheckRoomIds, roomId],
        updatedAt: now,
      }),
    );
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async removeRoomRecheckFlag(roomId) {
    const affected = get().coats.filter((coat) => coat.recheckRoomIds.includes(roomId));
    if (affected.length === 0) return;
    const now = Date.now();
    const rows = affected.map((coat) =>
      normalizeCoat({
        ...coat,
        recheckRoomIds: coat.recheckRoomIds.filter((id) => id !== roomId),
        updatedAt: now,
      }),
    );
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async applyRoomRework(roomId) {
    const affected = get().coats.filter((coat) => coat.recheckRoomIds.includes(roomId));
    if (affected.length === 0) return;
    const now = Date.now();
    const rows = affected.map((coat) => {
      // 已涂 / 已完成退回待打磨重做；待涂道次尚未施漆，无漆可返工，保留待涂
      const state: CoatState = coat.state === 'todo' ? 'todo' : 'toPolish';
      return normalizeCoat({ ...coat, state, updatedAt: now });
    });
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async resolveReworkedRoomsForCoat(coatId, reworkedRoomIds) {
    const coat = get().coats.find((item) => item.id === coatId);
    if (!coat || reworkedRoomIds.length === 0) return;
    const remove = new Set(reworkedRoomIds);
    const remaining = coat.recheckRoomIds.filter((id) => !remove.has(id));
    if (remaining.length === coat.recheckRoomIds.length) return;
    await get().updateCoat(coatId, { recheckRoomIds: remaining });
  },

  async reorderCoats(bodyId, orderedIds) {
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const rows = get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((coat, index) => normalizeCoat({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
  },

  suggestForBody(bodyId) {
    const bodies = useBodyStore.getState().bodies;
    const current = bodies.find((body) => body.id === bodyId);
    const previousBody = bodies.find((body) => body.id !== bodyId && current !== undefined && body.shape === current.shape);
    const previousCoat = previousBody
      ? get()
          .coats.filter((coat) => coat.bodyId === previousBody.id)
          .sort((a, b) => a.seq - b.seq)
          .pop()
      : undefined;
    const paintType = suggestPaintType(get().nextSeq(bodyId), previousCoat?.paintType, current?.shape);
    return {
      paintType,
      intervalHours: suggestIntervalHours(paintType),
      sourceCode: previousBody?.code ?? '',
      sourceColor: previousCoat?.colorName ?? '',
    };
  },
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
