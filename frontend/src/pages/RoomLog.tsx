/**
 * /rooms 荫房温湿度记录
 * 按区间判定适宜度；每条超标记录可补记复检（结论 / 复检人 / 日期），
 * 判定展示与超标次数以复检结论为准：
 * - 复检通过：只摘除本记录挂在各道次上的待复检标记，其他记录挂的标记照留；
 * - 判返工：本记录关联道次退回「待打磨」，重做打磨完成后才摘标记。
 * 支持日期区间与判定筛选（同步 URL query）。消费 Room、Coat；复用 <FilterBar> 等。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
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
  RollbackOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import {
  ROOM_RECHECK_VERDICT_COLOR,
  ROOM_RECHECK_VERDICT_LABEL,
  ROOM_RECHECK_VERDICT_OPTIONS,
  ROOM_VERDICT_COLOR,
  ROOM_VERDICT_LABEL,
  ROOM_VERDICT_OPTIONS,
  createEmptyRoomDraft,
  createEmptyRoomRecheckDraft,
  effectiveRoomVerdict,
  roomIsOver,
  roomRecheckPending,
  type Room,
  type RoomDraft,
  type RoomRecheckDraft,
  type RoomRecheckVerdict,
  type RoomVerdict,
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
  const saveRoomRecheck = useRoomStore((state) => state.saveRoomRecheck);
  const removeRoom = useRoomStore((state) => state.removeRoom);
  const coats = useCoatStore((state) => state.coats);

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [recheckRoom, setRecheckRoom] = useState<Room | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [draftTemp, setDraftTemp] = useState(24);
  const [draftHumidity, setDraftHumidity] = useState(75);

  const watchedRecheckVerdict = Form.useWatch('verdict', recheckForm) as RoomRecheckVerdict | undefined;

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const verdicts = url.values.verdict ?? [];
    return rooms.filter((room) => {
      if (keyword.length > 0) {
        const haystack = `${bodyCode(room.bodyId)}${room.date}${room.tempC}${room.humidityPct}${
          room.recheck?.inspector ?? ''
        }`;
        if (!haystack.includes(keyword)) return false;
      }
      // 判定筛选以复检后的有效判定为准
      if (verdicts.length > 0 && !verdicts.includes(effectiveRoomVerdict(room))) return false;
      if (dateFrom.length > 0 && room.date < dateFrom) return false;
      if (dateTo.length > 0 && room.date > dateTo) return false;
      return true;
    });
  }, [rooms, url.keyword, url.values, dateFrom, dateTo, bodies]);

  const stat = useMemo(() => {
    const total = rooms.length;
    const suitable = rooms.filter((room) => effectiveRoomVerdict(room) === 'suitable').length;
    const dry = rooms.filter((room) => effectiveRoomVerdict(room) === 'dry').length;
    const wet = rooms.filter((room) => effectiveRoomVerdict(room) === 'wet').length;
    const recheckPassed = rooms.filter((room) => room.recheck?.verdict === 'pass').length;
    const rework = rooms.filter((room) => room.recheck?.verdict === 'rework').length;
    const pending = rooms.filter((room) => roomRecheckPending(room)).length;
    return {
      total,
      suitable,
      dry,
      wet,
      over: rooms.filter((room) => roomIsOver(room)).length,
      suitablePercent: total === 0 ? 0 : Math.round((suitable / total) * 100),
      recheckPassed,
      rework,
      pending,
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
    form.setFieldsValue(room);
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const verdict = judgeVerdict(values.tempC, values.humidityPct);
    if (editing) {
      await updateRoom(editing.id, values);
      message.success(`已更新 ${values.date} 的荫房记录（区间判定：${ROOM_VERDICT_LABEL[verdict]}）`);
    } else {
      await createRoom(values);
      if (verdict === 'suitable') {
        message.success('已记录荫房温湿度，环境适宜');
      } else {
        message.warning(`区间判定为${ROOM_VERDICT_LABEL[verdict]}，已给该胎体未完成道次挂上待复检，可逐条补记复检`);
      }
    }
    setOpen(false);
  };

  const openRecheck = (room: Room): void => {
    setRecheckRoom(room);
    recheckForm.setFieldsValue(room.recheck ?? createEmptyRoomRecheckDraft('pass'));
  };

  const submitRecheck = async (): Promise<void> => {
    if (!recheckRoom) return;
    const values = await recheckForm.validateFields();
    await saveRoomRecheck(recheckRoom.id, values);
    if (values.verdict === 'pass') {
      message.success(
        `已补记复检通过：只摘除 ${recheckRoom.date} 这条记录挂的待复检标记，其他记录挂的标记照常保留`,
      );
    } else {
      message.warning('已补记返工：本记录关联道次已退回待打磨，重做打磨完成后标记才摘除');
    }
    setRecheckRoom(null);
  };

  const revokeRecheck = async (): Promise<void> => {
    if (!recheckRoom?.recheck) return;
    await saveRoomRecheck(recheckRoom.id, null);
    message.success('已撤销复检结论，恢复按区间判定挂标');
    setRecheckRoom(null);
  };

  /** 本记录当前挂起的道次（用于提示复检影响范围） */
  const linkedCoats = (room: Room) =>
    coats
      .filter((coat) => coat.recheckRoomIds.includes(room.id))
      .sort((a, b) => a.seq - b.seq);

  const renderVerdict = (value: RoomVerdict, record: Room) => {
    const effective = effectiveRoomVerdict(record);
    return (
      <Space size={4} wrap>
        <Tag color={ROOM_VERDICT_COLOR[effective]}>{ROOM_VERDICT_LABEL[effective]}</Tag>
        {record.recheck ? (
          <Tooltip title={`复检人：${record.recheck.inspector || '未填写'}　复检日期：${record.recheck.date}`}>
            <Tag color={ROOM_RECHECK_VERDICT_COLOR[record.recheck.verdict]}>
              {ROOM_RECHECK_VERDICT_LABEL[record.recheck.verdict]}
            </Tag>
          </Tooltip>
        ) : value !== 'suitable' ? (
          <Tag>未复检</Tag>
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          露点 {dewPoint(record.tempC, record.humidityPct)}℃
        </Typography.Text>
      </Space>
    );
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
    { title: '入房', dataIndex: 'inAt', width: 75 },
    { title: '出房', dataIndex: 'outAt', width: 75 },
    {
      title: '在房时长',
      key: 'stay',
      width: 95,
      render: (_value, record) => `${roomStayHours(record.inAt, record.outAt)} 小时`,
    },
    {
      title: '判定 / 复检',
      dataIndex: 'verdict',
      width: 180,
      filters: ROOM_VERDICT_OPTIONS.map((item) => ({ text: item.label, value: item.value })),
      onFilter: (value, record) => effectiveRoomVerdict(record) === value,
      render: renderVerdict,
    },
    {
      title: '复检明细',
      key: 'recheckDetail',
      width: 170,
      render: (_value, record) => {
        const linked = linkedCoats(record);
        if (!record.recheck) {
          return record.verdict === 'suitable' ? (
            <Typography.Text type="secondary">—</Typography.Text>
          ) : (
            <Tooltip title={linked.length > 0 ? `挂起第 ${linked.map((coat) => coat.seq).join('、')} 道` : '当前无挂起道次'}>
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                待复检{linked.length > 0 ? `（挂 ${linked.length} 道）` : ''}
              </Typography.Text>
            </Tooltip>
          );
        }
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12 }}>
              {record.recheck.inspector || '未填写'} · {record.recheck.date}
            </Typography.Text>
            {record.recheck.note ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                {record.recheck.note}
              </Typography.Text>
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              挂起 {linked.length} 道
            </Typography.Text>
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
      width: 190,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<AuditOutlined />} onClick={() => openRecheck(record)}>
            {record.recheck ? '改复检' : '补记复检'}
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该荫房记录"
            description="将同时摘除本记录挂在道次上的待复检标记。"
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
            {rangeHint()}；越界记录给同胎体未完成道次挂「待复检」，每条记录可单独补记复检：
            通过只摘本条记录的标记，返工退回待打磨，判定与超标次数以复检结论为准。
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
        <StatBadge label="待复检" value={stat.pending} suffix="条" tone="warning" />
        <StatBadge label="复检通过" value={stat.recheckPassed} suffix="条" tone="success" />
        <StatBadge label="判返工" value={stat.rework} suffix="条" tone="danger" />
        <StatBadge label="偏干" value={stat.dry} suffix="次" tone="warning" />
        <StatBadge label="偏湿" value={stat.wet} suffix="次" tone="info" />
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="复检摘标按来源逐条计数"
        description="同一道次被两条荫房记录挂过时，只给其中一条登记复检通过不会清掉该道次的标记，必须所有来源记录都复检通过（或判返工后重做打磨完成）；各道次的挂标来源可在「髹涂道次」页查看。"
      />

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
        keywordPlaceholder="搜索编号 / 日期 / 温湿度 / 复检人…"
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
                ? '每次入荫房时登记温度、湿度与出入房时间；超标记录可逐条补记复检结论。'
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
            <Tag color={ROOM_VERDICT_COLOR[previewVerdict]}>区间判定：{ROOM_VERDICT_LABEL[previewVerdict]}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              露点约 {dewPoint(draftTemp, draftHumidity)}℃ · 在房 {roomStayHours(form.getFieldValue('inAt') ?? '09:00', form.getFieldValue('outAt') ?? '21:00')} 小时
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {dryingAdvice(draftTemp, draftHumidity, 40)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              保存后如越界会给该胎体未完成道次挂「待复检」；复检结论请保存后用「补记复检」登记。
            </Typography.Text>
          </Space>
        </Form>
      </Modal>

      <Modal
        open={recheckRoom !== null}
        title={recheckRoom ? `补记复检：${recheckRoom.date} · ${bodyCode(recheckRoom.bodyId)}` : ''}
        onCancel={() => setRecheckRoom(null)}
        onOk={() => void submitRecheck()}
        okText="保存复检"
        cancelText="取消"
        destroyOnClose
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space>
            {recheckRoom?.recheck ? (
              <Popconfirm
                title="撤销复检结论"
                description="恢复为未复检，并按区间判定重新挂标。"
                okText="确认撤销"
                cancelText="取消"
                onConfirm={() => void revokeRecheck()}
              >
                <Button danger icon={<RollbackOutlined />}>
                  撤销复检
                </Button>
              </Popconfirm>
            ) : null}
            <CancelBtn />
            <OkBtn />
          </Space>
        )}
      >
        {recheckRoom ? (
          <Form form={recheckForm} layout="vertical" preserve={false}>
            <Alert
              type={recheckRoom.verdict !== 'suitable' ? 'warning' : 'info'}
              showIcon
              style={{ marginBottom: 14 }}
              message={`区间判定：${ROOM_VERDICT_LABEL[recheckRoom.verdict]}（${recheckRoom.tempC}℃ / ${recheckRoom.humidityPct}%）${
                recheckRoom.recheck ? ` · 已登记：${ROOM_RECHECK_VERDICT_LABEL[recheckRoom.recheck.verdict]}` : ''
              }`}
              description={
                linkedCoats(recheckRoom).length > 0
                  ? `本记录当前挂起第 ${linkedCoats(recheckRoom)
                      .map((coat) => coat.seq)
                      .join('、')} 道。`
                  : '本记录当前没有挂起的道次。'
              }
            />
            <Space size={12} style={{ display: 'flex' }}>
              <Form.Item name="verdict" label="复检结论" rules={[{ required: true, message: '请选择复检结论' }]} style={{ flex: 1 }}>
                <Select
                  options={ROOM_RECHECK_VERDICT_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                />
              </Form.Item>
              <Form.Item name="date" label="复检日期" rules={[{ required: true, message: '请选择复检日期' }]} style={{ flex: 1 }}>
                <Input type="date" />
              </Form.Item>
            </Space>
            <Form.Item name="inspector" label="复检人" rules={[{ required: true, message: '请填写复检人' }]}>
              <Input placeholder="如：周衡" />
            </Form.Item>
            <Form.Item name="note" label="复检备注">
              <Input.TextArea rows={2} placeholder="如：漆面成膜正常 / 局部起皱需返工" />
            </Form.Item>
            <Alert
              type={watchedRecheckVerdict === 'rework' ? 'error' : 'success'}
              showIcon
              message={
                watchedRecheckVerdict === 'rework'
                  ? '判返工：本记录关联的道次将退回「待打磨」，重做打磨完成后待复检标记才摘除；超标次数照计。'
                  : '复检通过：只摘除本记录挂在各道次上的标记，别的荫房记录挂的标记照常保留；该条超标不再计入超标次数。'
              }
            />
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
