/**
 * /rooms 荫房温湿度记录
 * 按区间给出初判，偏干 / 偏湿时只把该胎体「当时未完成」的道次记入本条记录的挂起名单；
 * 每条记录可补记复检（结论 / 复检人 / 日期），判定与超标次数以复检结论为准：
 * 复检通过只摘除本条记录挂的标记，判返工把关联道次退回待打磨。支持日期区间筛选（同步 URL query）。
 * 消费 Room、Coat；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import {
  ROOM_RECHECK_COLOR,
  ROOM_RECHECK_LABEL,
  ROOM_RECHECK_OPTIONS,
  ROOM_VERDICT_COLOR,
  ROOM_VERDICT_LABEL,
  ROOM_VERDICT_OPTIONS,
  createEmptyRoomDraft,
  createEmptyRoomRecheckDraft,
  effectiveRoomVerdict,
  isRoomOver,
  isRoomPending,
  type Room,
  type RoomDraft,
  type RoomRecheckDraft,
} from '@/types/room';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { dewPoint, dryingAdvice, dryingHours, judgeVerdict, rangeHint, roomStayHours } from '@/utils/humidity';

const FILTER_KEYS = ['verdict'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'verdict', label: '判定', options: ROOM_VERDICT_OPTIONS },
];

export default function RoomLog() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<RoomDraft>();
  const [recheckForm] = Form.useForm<RoomRecheckDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const rooms = useRoomStore((state) => state.rooms);
  const createRoom = useRoomStore((state) => state.createRoom);
  const updateRoom = useRoomStore((state) => state.updateRoom);
  const removeRoom = useRoomStore((state) => state.removeRoom);
  const resnapshotFlags = useRoomStore((state) => state.resnapshotFlags);
  const submitRecheck = useRoomStore((state) => state.submitRecheck);
  const coats = useCoatStore((state) => state.coats);

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [recheckTarget, setRecheckTarget] = useState<Room | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [draftTemp, setDraftTemp] = useState(24);
  const [draftHumidity, setDraftHumidity] = useState(75);

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const verdicts = url.values.verdict ?? [];
    return rooms.filter((room) => {
      if (keyword.length > 0) {
        const haystack = `${bodyCode(room.bodyId)}${room.date}${room.tempC}${room.humidityPct}`;
        if (!haystack.includes(keyword)) return false;
      }
      // 筛选的「判定」同样以复检结论为准
      if (verdicts.length > 0 && !verdicts.includes(effectiveRoomVerdict(room))) return false;
      if (dateFrom.length > 0 && room.date < dateFrom) return false;
      if (dateTo.length > 0 && room.date > dateTo) return false;
      return true;
    });
  }, [rooms, url.keyword, url.values, dateFrom, dateTo, bodies]);

  const stat = useMemo(() => {
    const total = rooms.length;
    let suitable = 0;
    let dry = 0;
    let wet = 0;
    let over = 0;
    let pending = 0;
    let humiditySum = 0;
    rooms.forEach((room) => {
      humiditySum += room.humidityPct;
      if (isRoomOver(room)) over += 1;
      if (isRoomPending(room)) pending += 1;
      const verdict = effectiveRoomVerdict(room);
      if (verdict === 'suitable') suitable += 1;
      else if (verdict === 'dry') dry += 1;
      else wet += 1;
    });
    return {
      total,
      suitable,
      dry,
      wet,
      over,
      pending,
      suitablePercent: total === 0 ? 0 : Math.round((suitable / total) * 100),
      avgHumidity: total === 0 ? 0 : Math.round(humiditySum / total),
    };
  }, [rooms]);

  const openCreate = (): void => {
    const bodyId = bodies[0]?.id ?? '';
    if (!bodyId) {
      message.warning('请先在胎体台账中登记胎体');
      return;
    }
    setEditing(null);
    const draft = createEmptyRoomDraft(bodyId);
    setDraftTemp(draft.tempC);
    setDraftHumidity(draft.humidityPct);
    form.setFieldsValue(draft);
    setOpen(true);
  };

  const openEdit = (room: Room): void => {
    setEditing(room);
    setDraftTemp(room.tempC);
    setDraftHumidity(room.humidityPct);
    form.setFieldsValue({
      bodyId: room.bodyId,
      date: room.date,
      tempC: room.tempC,
      humidityPct: room.humidityPct,
      inAt: room.inAt,
      outAt: room.outAt,
    });
    setOpen(true);
  };

  const openRecheck = (room: Room): void => {
    setRecheckTarget(room);
    recheckForm.setFieldsValue(room.recheck ? { ...room.recheck } : createEmptyRoomRecheckDraft());
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const verdict = judgeVerdict(values.tempC, values.humidityPct);
    if (editing) {
      await updateRoom(editing.id, values);
      message.success(`已更新 ${values.date} 的荫房记录（初判：${ROOM_VERDICT_LABEL[verdict]}）`);
    } else {
      const created = await createRoom(values);
      if (verdict === 'suitable') {
        message.success('已记录荫房温湿度，环境适宜');
      } else {
        message.warning(
          `初判${ROOM_VERDICT_LABEL[verdict]}：已把该胎体当前 ${created.flaggedCoatIds.length} 道未完成道次挂为待复检，可逐条补记复检`,
        );
      }
    }
    setOpen(false);
  };

  const submitRecheckForm = async (): Promise<void> => {
    if (!recheckTarget) return;
    const values = await recheckForm.validateFields();
    const updated = await submitRecheck(recheckTarget.id, values);
    if (!updated) return;
    if (values.verdict === 'pass') {
      message.success('复检通过：已只摘除本条记录挂的待复检标记，其他记录挂的标记照留');
    } else {
      message.warning(`判返工：本条关联的 ${recheckTarget.flaggedCoatIds.length} 道道次已退回待打磨`);
    }
    setRecheckTarget(null);
  };

  const columns: ColumnsType<Room> = [
    { title: '日期', dataIndex: 'date', width: 110, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 110,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    { title: '温度', dataIndex: 'tempC', width: 80, render: (value: number) => `${value} ℃` },
    { title: '湿度', dataIndex: 'humidityPct', width: 80, render: (value: number) => `${value} %` },
    { title: '入房', dataIndex: 'inAt', width: 70 },
    { title: '出房', dataIndex: 'outAt', width: 70 },
    {
      title: '判定',
      key: 'verdict',
      width: 130,
      filters: ROOM_VERDICT_OPTIONS.map((item) => ({ text: item.label, value: item.value })),
      onFilter: (value, record) => effectiveRoomVerdict(record) === value,
      render: (_value, record) => {
        const effective = effectiveRoomVerdict(record);
        return (
          <Space direction="vertical" size={0}>
            <Space size={4} wrap>
              <Tag color={ROOM_VERDICT_COLOR[effective]}>{ROOM_VERDICT_LABEL[effective]}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                露点 {dewPoint(record.tempC, record.humidityPct)}℃
              </Typography.Text>
            </Space>
            {record.recheck ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                温湿度初判：{ROOM_VERDICT_LABEL[record.verdict]}（以复检为准）
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '复检 / 挂起道次',
      key: 'recheck',
      width: 250,
      render: (_value, record) => {
        if (record.verdict === 'suitable' && !record.recheck) {
          return <Typography.Text type="secondary">环境适宜，未挂道次</Typography.Text>;
        }
        const seqText = record.flaggedCoatIds
          .map((coatId) => coats.find((coat) => coat.id === coatId)?.seq)
          .filter((seq): seq is number => typeof seq === 'number')
          .map((seq) => `第${seq}道`)
          .join('、');
        return (
          <Space direction="vertical" size={2}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本条挂起：{seqText || '（关联道次已删除）'}
            </Typography.Text>
            {record.recheck ? (
              <Tooltip title={record.recheck.note || '无复检说明'}>
                <Space size={4} wrap>
                  <Tag color={ROOM_RECHECK_COLOR[record.recheck.verdict]}>
                    {ROOM_RECHECK_LABEL[record.recheck.verdict]}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {record.recheck.inspector || '未填复检人'} · {record.recheck.date}
                  </Typography.Text>
                </Space>
              </Tooltip>
            ) : (
              <Tag color="#c9963c">待复检</Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: '荫干建议',
      key: 'advice',
      render: (_value, record) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {dryingAdvice(record.tempC, record.humidityPct, coats.find((coat) => coat.bodyId === record.bodyId)?.thicknessUm ?? 40)}
          （预计 {dryingHours(record.tempC, record.humidityPct, 40)} 小时）
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.verdict !== 'suitable' ? (
            <Button size="small" type="link" icon={<AuditOutlined />} onClick={() => openRecheck(record)}>
              {record.recheck ? '改复检' : '补记复检'}
            </Button>
          ) : null}
          {isRoomPending(record) ? (
            <Tooltip title="按该胎体当前未完成道次，重新生成这条记录的挂起名单">
              <Button
                size="small"
                type="link"
                icon={<ReloadOutlined />}
                onClick={() =>
                  void resnapshotFlags(record.id).then(() => message.success('已按当前未完成道次重挂本条名单'))
                }
              >
                重挂名单
              </Button>
            </Tooltip>
          ) : null}
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该荫房记录"
            description="该记录挂的待复检标记会一并摘除（其他记录挂的不受影响）。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeRoom(record.id).then(() => message.success('已删除'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const previewVerdict = judgeVerdict(draftTemp, draftHumidity);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>荫房温湿度记录</h2>
          <p>
            {rangeHint()}；一条记录判偏干 / 偏湿，只挂该胎体当时未完成的道次，并可对这条记录补记复检：
            通过只摘本条标记、判返工退回待打磨，判定与超标次数均以复检结论为准。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增记录
        </Button>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="记录总数" value={stat.total} suffix="条" tone="primary" />
        <StatBadge label="适宜占比" value={`${stat.suitablePercent}%`} percent={stat.suitablePercent} tone="success" />
        <StatBadge label="超标次数（复检后）" value={stat.over} suffix="次" tone="danger" />
        <StatBadge label="待复检记录" value={stat.pending} suffix="条" tone="warning" />
        <StatBadge label="偏干" value={stat.dry} suffix="次" tone="warning" />
        <StatBadge label="偏湿" value={stat.wet} suffix="次" tone="info" />
        <StatBadge label="平均湿度" value={stat.avgHumidity} suffix="%" />
      </div>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
          setDateFrom('');
          setDateTo('');
        }}
        keywordPlaceholder="搜索编号 / 日期 / 温湿度…"
        actions={
          <Space size={6} wrap>
            <Input
              type="date"
              size="small"
              style={{ width: 150 }}
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
            <Typography.Text type="secondary">至</Typography.Text>
            <Input
              type="date"
              size="small"
              style={{ width: 150 }}
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={rooms.length === 0 ? '还没有荫房记录' : '当前条件下没有记录'}
            description={
              rooms.length === 0
                ? '每次入荫房时登记温度、湿度与出入房时间；偏干 / 偏湿只挂本条记录对应的未完成道次。'
                : '试着调整判定或日期区间。'
            }
            actionText="新增记录"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={() => {
              url.reset();
              setDateFrom('');
              setDateTo('');
            }}
            size="small"
          />
        ) : (
          <Table<Room> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={columns} dataSource={filtered} />
        )}
      </Card>

      <Modal
        open={open}
        title={editing ? `编辑 ${editing.date} 的荫房记录` : '新增荫房记录'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false} onValuesChange={(changed) => {
          if (typeof changed.tempC === 'number') setDraftTemp(changed.tempC);
          if (typeof changed.humidityPct === 'number') setDraftHumidity(changed.humidityPct);
        }}>
          <Form.Item name="bodyId" label="关联胎体" rules={[{ required: true, message: '请选择胎体' }]}>
            <Select
              options={bodies.map((body) => ({
                value: body.id,
                label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
              }))}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="记录日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="inAt" label="入房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
            <Form.Item name="outAt" label="出房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="tempC" label="温度（℃）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={5} max={45} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="humidityPct" label="湿度（%）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space direction="vertical" size={2}>
            <Tag color={ROOM_VERDICT_COLOR[previewVerdict]}>实时初判：{ROOM_VERDICT_LABEL[previewVerdict]}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              露点约 {dewPoint(draftTemp, draftHumidity)}℃ · 在房 {roomStayHours(form.getFieldValue('inAt') ?? '09:00', form.getFieldValue('outAt') ?? '21:00')} 小时
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {dryingAdvice(draftTemp, draftHumidity, 40)}
            </Typography.Text>
            {previewVerdict !== 'suitable' ? (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                保存后将把该胎体当前未完成的道次挂到「本条记录」名下；每条记录可单独补记复检。
              </Typography.Text>
            ) : null}
          </Space>
        </Form>
      </Modal>

      <Modal
        open={recheckTarget !== null}
        title={recheckTarget ? `补记复检 · ${recheckTarget.date}（初判${ROOM_VERDICT_LABEL[recheckTarget.verdict]}）` : '补记复检'}
        onCancel={() => setRecheckTarget(null)}
        onOk={() => void submitRecheckForm()}
        okText="保存复检"
        cancelText="取消"
        destroyOnClose
      >
        {recheckTarget ? (
          <Space direction="vertical" size={8} style={{ display: 'flex' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本条记录挂起的道次：
              {recheckTarget.flaggedCoatIds
                .map((coatId) => coats.find((coat) => coat.id === coatId)?.seq)
                .filter((seq): seq is number => typeof seq === 'number')
                .map((seq) => `第 ${seq} 道`)
                .join('、') || '（关联道次已删除）'}
              ；复检通过只摘除本条挂的标记，其他荫房记录挂的标记照留。
            </Typography.Text>
            <Form form={recheckForm} layout="vertical" preserve={false}>
              <Form.Item name="verdict" label="复检结论" rules={[{ required: true, message: '请选择复检结论' }]}>
                <Select options={[...ROOM_RECHECK_OPTIONS]} />
              </Form.Item>
              <Space size={12} style={{ display: 'flex' }}>
                <Form.Item
                  name="inspector"
                  label="复检人"
                  rules={[{ required: true, message: '请填写复检人' }]}
                  style={{ flex: 1 }}
                >
                  <Input placeholder="如：周衡" />
                </Form.Item>
                <Form.Item name="date" label="复检日期" rules={[{ required: true, message: '请选择复检日期' }]} style={{ flex: 1 }}>
                  <Input type="date" />
                </Form.Item>
              </Space>
              <Form.Item name="note" label="复检说明">
                <Input.TextArea rows={3} placeholder="如：漆面无起皱流挂，可继续下一道；或说明返工原因" />
              </Form.Item>
            </Form>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
