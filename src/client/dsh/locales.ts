const labels = {
  'kind.system': '系统',
  'kind.user': '用户',
  'kind.context': '上下文',
  'kind.compacted': '已压缩',
  'kind.assistant': '助手',
  'kind.tool': '工具',
  'kind.subtool': '子工具',
  'column.input': '输入',
  'column.model': '模型',
  'column.tools': '工具',
  'unit.milliseconds': '{value} 毫秒',
  'history.loadingEarlier': '正在加载更早的历史…',
  'history.loadingEarlierAria': '正在加载更早的历史…',
  'history.loadEarlier': '加载更早的历史',
  'history.clickToLoadEarlier': '点击加载更早的历史',
  'timeline.aria': '轨迹时间线',
  'timeline.overviewAria': '时间线概览，可水平拖动聚焦事件',
  'timeline.noTimingData': '无计时数据',
  'timeline.total': '总计 {duration}',
  'timeline.started': '开始于 {time}',
  'timeline.ttftDecoding': '首 token {ttft} · 解码 {decoding}',
};

export type TrajectoryTranslate = (key: keyof typeof labels, values?: Record<string, string>) => string;

export const translate: TrajectoryTranslate = (key, values) =>
  labels[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => values?.[name] ?? placeholder);
