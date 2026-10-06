/**
 * <StageTag> 阶段标签
 * 按胎体状态（待髹涂/髹涂中/待荫干/已完成）与道次状态（待涂/已涂/待打磨/已完成）渲染底色，
 * 并支持荫房异常回写的「待复检」提示；被胎体页、道次页、打磨页消费。
 */
import { Tag, Tooltip } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { BODY_STATE_COLOR, BODY_STATE_LABEL, type BodyState } from '@/types/body';
import { COAT_STATE_COLOR, COAT_STATE_LABEL, type CoatState } from '@/types/coat';

export type StageKey = BodyState | CoatState;

export interface StageTagProps {
  /** 状态键：胎体状态或道次状态 */
  state: StageKey;
  /** 是否需要复检（荫房温湿度越界且来源未全部闭环） */
  needRecheck?: boolean;
  /** 道次序号，传入时前缀显示「第 n 道」 */
  seq?: number;
  /** 追加文案，如「已完成 2/4」 */
  suffix?: string;
  /** 挂起本道次的荫房记录条数，传入时在提示中说明 */
  recheckSourceCount?: number;
}

const LABEL: Record<string, string> = { ...BODY_STATE_LABEL, ...COAT_STATE_LABEL };
const COLOR: Record<string, string> = { ...BODY_STATE_COLOR, ...COAT_STATE_COLOR };

export function StageTag({ state, needRecheck = false, seq, suffix, recheckSourceCount }: StageTagProps) {
  const label = LABEL[state] ?? state;
  const color = COLOR[state] ?? '#8c8c8c';
  const text = `${seq === undefined ? '' : `第 ${seq} 道 · `}${label}${suffix ? ` · ${suffix}` : ''}`;
  const recheckTooltip =
    recheckSourceCount && recheckSourceCount > 0
      ? `有 ${recheckSourceCount} 条荫房记录挂着待复检，全部复检通过（或返工重做打磨完成）后才摘除`
      : '关联荫房记录超标且尚未复检闭环，需复检漆层';

  return (
    <>
      <Tag color={color} style={{ marginInlineEnd: needRecheck ? 4 : 0 }}>
        {text}
      </Tag>
      {needRecheck ? (
        <Tooltip title={recheckTooltip}>
          <Tag icon={<ExclamationCircleOutlined />} color="warning">
            待复检{recheckSourceCount && recheckSourceCount > 1 ? ` ×${recheckSourceCount}` : ''}
          </Tag>
        </Tooltip>
      ) : null}
    </>
  );
}

export default StageTag;
