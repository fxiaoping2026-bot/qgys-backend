// ============================================================
// 企港渔叔 · 点餐系统后端服务
// 功能：代理飞书多维表格 API（解决浏览器 CORS 限制）
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 飞书配置（优先读环境变量，本地调试可用默认值）
const FEISHU_CONFIG = {
  appId:     process.env.FEISHU_APP_ID      || 'cli_aabf50321cb81bef',
  appSecret:  process.env.FEISHU_APP_SECRET  || 'PoAcoWez6fsP11jHp72WrgYtOZcXrWkS',
  appToken:   process.env.FEISHU_APP_TOKEN    || 'CTB4bUoRvaaBvZsh7p7cYPI7nEf',
  tableId:    process.env.FEISHU_TABLE_ID     || 'tbl2dODf9nxi7iOZ',
  orderTableId: process.env.FEISHU_ORDER_TABLE_ID || 'tblIXCshUqK2VnHU',
};

// 飞书字段名映射（API 默认返回字段名作为 key）
const FIELDS = {
  category:    '分类',      // 单行文本
  name:        '菜品名称',  // 单行文本
  desc:        '描述',      // 多选
  price:       '价格',      // 数字
  unit:        '单位',      // 单选
  emoji:       '表情',      // 单选
  tags:        '标签',      // 多选
  available:   '上架状态',  // 单行文本，"TRUE"=上架
};

// 中间件
app.use(cors());
app.use(express.json());

// 静态文件服务（托管 H5 前端）
app.use(express.static(__dirname));

// ============================================================
// 获取飞书 tenant_access_token
// ============================================================
async function getTenantToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: FEISHU_CONFIG.appId,
      app_secret: FEISHU_CONFIG.appSecret,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取token失败: ${data.msg}`);
  return data.tenant_access_token;
}

// ============================================================
// API：从飞书读取菜单
// GET /api/menu
// ============================================================
app.get('/api/menu', async (req, res) => {
  try {
    const token = await getTenantToken();
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records?page_size=500`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();

    if (data.code !== 0) {
      return res.status(500).json({ success: false, error: data.msg });
    }

    // 将飞书记录转换为 H5 菜单格式
    const records = data.data.items || [];
    const menuData = convertFeishuToMenu(records);

    res.json({ success: true, menuData });
  } catch (err) {
    console.error('读取菜单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// API：同步菜单到飞书（全量覆盖）
// POST /api/menu/sync
// Body: { menuData: [...] }
// ============================================================
app.post('/api/menu/sync', async (req, res) => {
  try {
    const { menuData } = req.body;
    if (!menuData) return res.status(400).json({ success: false, error: '缺少 menuData' });

    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}`;

    // 1. 读取飞书现有记录
    const existingResp = await fetch(`${baseUrl}/records?page_size=500`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const existingData = await existingResp.json();
    if (existingData.code !== 0) throw new Error(existingData.msg);

    const existingRecords = existingData.data.items || [];
    const existingMap = {};  // { "分类|菜名": record_id }
    for (const rec of existingRecords) {
      const cat = rec.fields[FIELDS.category] || '';
      const name = rec.fields[FIELDS.name] || '';
      existingMap[`${cat}|${name}`] = rec.record_id;
    }

    // 2. 转换 H5 菜单为飞书记录格式
    const { toCreate, toUpdate, toDelete } = diffMenuWithFeishu(menuData, existingMap, existingRecords);

    let created = 0, updated = 0, deleted = 0;

    // 3. 新增
    for (const item of toCreate) {
      const record = buildFeishuRecord(item);
      const r = await fetch(`${baseUrl}/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: record }),
      });
      const result = await r.json();
      if (result.code === 0) created++;
      else console.warn('新增失败:', item.name, result.msg);
    }

    // 4. 更新
    for (const { recordId, item } of toUpdate) {
      const record = buildFeishuRecord(item);
      const r = await fetch(`${baseUrl}/records/${recordId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: record }),
      });
      const result = await r.json();
      if (result.code === 0) updated++;
      else console.warn('更新失败:', item.name, result.msg);
    }

    // 5. 删除（飞书有但 H5 里没有的菜品）
    for (const recordId of toDelete) {
      const r = await fetch(`${baseUrl}/records/${recordId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await r.json();
      if (result.code === 0) deleted++;
    }

    res.json({ success: true, created, updated, deleted });
  } catch (err) {
    console.error('同步失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 订单字段映射（飞书"订单"表）
// ============================================================
const ORDER_FIELDS = {
  orderNo:  '订单号',    // 文本
  phone:    '手机号',    // 文本
  status:   '状态',      // 文本
  items:    '菜品详情',  // 文本（JSON字符串）
  total:    '总金额',    // 数字
  remark:   '备注',      // 文本
  time:     '下单时间',  // 文本
};

// ============================================================
// API：提交新订单
// POST /api/orders
// Body: { no, phone, status, items, total, remark, time }
// ============================================================
app.post('/api/orders', async (req, res) => {
  try {
    const { no, phone, status, items, total, remark, time } = req.body;
    if (!no || !phone) return res.status(400).json({ success: false, error: '缺少订单号或手机号' });

    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.orderTableId}`;

    // 检查是否已存在（相同订单号覆盖）
    const existResp = await fetch(`${baseUrl}/records?page_size=500`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const existData = await existResp.json();
    if (existData.code !== 0) throw new Error('读取订单表失败: ' + existData.msg);

    const existingRecords = existData.data.items || [];
    const existRec = existingRecords.find(r =>
      r.fields[ORDER_FIELDS.orderNo] === no
    );

    const fields = {};
    fields[ORDER_FIELDS.orderNo] = no;
    fields[ORDER_FIELDS.phone]   = phone;
    fields[ORDER_FIELDS.status]  = status || 'pending';
    fields[ORDER_FIELDS.items]   = JSON.stringify(items || []);
    fields[ORDER_FIELDS.total]   = Number(total) || 0;
    fields[ORDER_FIELDS.remark]  = remark || '';
    fields[ORDER_FIELDS.time]    = time || new Date().toLocaleString('zh-CN');

    if (existRec) {
      // 更新已有订单
      const r = await fetch(`${baseUrl}/records/${existRec.record_id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      const result = await r.json();
      if (result.code !== 0) throw new Error(result.msg);
      res.json({ success: true, action: 'updated', recordId: existRec.record_id });
    } else {
      // 新建
      const r = await fetch(`${baseUrl}/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      const result = await r.json();
      if (result.code !== 0) throw new Error(result.msg);
      res.json({ success: true, action: 'created', recordId: result.data.record.record_id });
    }
  } catch (err) {
    console.error('提交订单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// API：获取所有订单（商家后台用）— 必须在 /:phone 前面
// GET /api/orders/all
// ============================================================
app.get('/api/orders/all', async (req, res) => {
  try {
    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.orderTableId}`;
    const resp = await fetch(`${baseUrl}/records?page_size=500`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(data.msg);

    const records = data.data.items || [];
    const orders = records.map(r => ({
      _recordId: r.record_id,
      no:      r.fields[ORDER_FIELDS.orderNo]  || '',
      phone:   r.fields[ORDER_FIELDS.phone]    || '',
      status:  r.fields[ORDER_FIELDS.status]   || 'pending',
      items:   safeParseJSON(r.fields[ORDER_FIELDS.items], []),
      total:   Number(r.fields[ORDER_FIELDS.total]) || 0,
      remark:  r.fields[ORDER_FIELDS.remark]   || '',
      time:    r.fields[ORDER_FIELDS.time]     || '',
    }));
    // 按时间倒序
    orders.sort((a, b) => b.time.localeCompare(a.time));

    res.json({ success: true, orders });
  } catch (err) {
    console.error('获取全部订单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// API：根据手机号查订单
// GET /api/orders/:phone
// ============================================================
app.get('/api/orders/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.orderTableId}`;
    const resp = await fetch(`${baseUrl}/records?page_size=500`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(data.msg);

    const records = data.data.items || [];
    const orders = records
      .filter(r => r.fields[ORDER_FIELDS.phone] === phone)
      .map(r => ({
        _recordId: r.record_id,
        no: r.fields[ORDER_FIELDS.orderNo] || '',
        phone: r.fields[ORDER_FIELDS.phone] || '',
        status: r.fields[ORDER_FIELDS.status] || 'pending',
        items: safeParseJSON(r.fields[ORDER_FIELDS.items], []),
        total: Number(r.fields[ORDER_FIELDS.total]) || 0,
        remark: r.fields[ORDER_FIELDS.remark] || '',
        time: r.fields[ORDER_FIELDS.time] || '',
      }));

    res.json({ success: true, orders });
  } catch (err) {
    console.error('查订单失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// API：更新订单状态
// PUT /api/orders/:orderNo
// Body: { status }
// ============================================================
app.put('/api/orders/:orderNo', async (req, res) => {
  try {
    const orderNo = req.params.orderNo;
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, error: '缺少状态值' });

    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.orderTableId}`;

    // 查找记录
    const resp = await fetch(`${baseUrl}/records?page_size=500`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(data.msg);

    const records = data.data.items || [];
    const target = records.find(r => r.fields[ORDER_FIELDS.orderNo] === orderNo);
    if (!target) return res.status(404).json({ success: false, error: '订单不存在' });

    // 更新状态
    const fields = { [ORDER_FIELDS.status]: status };
    const r = await fetch(`${baseUrl}/records/${target.record_id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const result = await r.json();
    if (result.code !== 0) throw new Error(result.msg);

    res.json({ success: true, orderNo, status });
  } catch (err) {
    console.error('更新订单状态失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 辅助：安全解析 JSON（用于菜品详情字段）
// ============================================================
function safeParseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ============================================================
// 辅助：飞书记录 → H5 菜单格式
// ============================================================
function convertFeishuToMenu(records) {
  const catMap = {};

  for (const rec of records) {
    const f = rec.fields;
    const cat = f[FIELDS.category] || '未分类';
    if (!catMap[cat]) catMap[cat] = [];

    // desc 是多选字段，API 返回数组，需 join 成字符串
    const descRaw = f[FIELDS.desc];
    const desc = Array.isArray(descRaw) ? descRaw.join('. ') : (descRaw || '');

    // tags 是多选字段，API 返回数组
    const tagsRaw = f[FIELDS.tags];
    const tags = Array.isArray(tagsRaw) ? tagsRaw : (tagsRaw ? String(tagsRaw).split(/[,，、]/).map(t => t.trim()).filter(Boolean) : []);

    // 上架状态：单行文本字段，值为 "TRUE" 表示上架
    const available = f[FIELDS.available] === 'TRUE';

    catMap[cat].push({
      // 用 record_id 作为唯一 ID，同步时用于匹配
      _recordId: rec.record_id,
      name: f[FIELDS.name] || '',
      desc,
      price: Number(f[FIELDS.price]) || 0,
      unit: f[FIELDS.unit] || '份',
      emoji: f[FIELDS.emoji] || '🍽',
      tags,
      available,
    });
  }

  // 转为 menuData 格式（与 H5 index.html 的 menuData 结构一致）
  const iconMap = { '招牌生蚝': '🦪', '海鲜小炒': '🍳', '主食': '🍚', '酒水饮料': '🥤', '未分类': '📋' };
  return Object.entries(catMap).map(([name, items], idx) => ({
    id: `c${idx + 1}`,
    name,
    icon: iconMap[name] || '📋',
    items: items.map((item, i) => ({
      // 保留 _recordId 以便后续同步匹配
      _fid: item._recordId,
      id: `i${idx * 100 + i + 1}`,
      name: item.name,
      desc: item.desc,
      price: item.price,
      unit: item.unit,
      emoji: item.emoji || '🍽',
      tags: item.tags,
      available: item.available,
    })),
  }));
}

// ============================================================
// 辅助：比对 H5 菜单与飞书记录，返回增/改/删列表
// ============================================================
function diffMenuWithFeishu(menuData, existingMap, existingRecords) {
  const toCreate = [];
  const toUpdate = [];
  const toDelete = [];

  // 遍历 H5 菜单，判断新增或更新
  for (const cat of menuData) {
    for (const item of cat.items) {
      const key = `${cat.name}|${item.name}`;
      const recordId = existingMap[key];
      if (!recordId) {
        toCreate.push({ ...item, _cat: cat.name });
      } else {
        // 检查是否需要更新（简化：有 recordId 就更新）
        toUpdate.push({ recordId, item: { ...item, _cat: cat.name } });
      }
    }
  }

  // 遍历飞书记录，判断删除
  const h5KeySet = new Set();
  for (const cat of menuData) {
    for (const item of cat.items) {
      h5KeySet.add(`${cat.name}|${item.name}`);
    }
  }
  for (const rec of existingRecords) {
    const cat = rec.fields[FIELDS.category] || '';
    const name = rec.fields[FIELDS.name] || '';
    if (!h5KeySet.has(`${cat}|${name}`)) {
      toDelete.push(rec.record_id);
    }
  }

  return { toCreate, toUpdate, toDelete };
}

// ============================================================
// 辅助：构建飞书记录字段（写入格式）
// ============================================================
function buildFeishuRecord(item) {
  const fields = {};
  if (item._cat)    fields[FIELDS.category]  = item._cat;
  if (item.name)     fields[FIELDS.name]      = item.name;
  // 描述：多选字段，API 需接收数组；将描述文本作为一个选项传入
  if (item.desc)     fields[FIELDS.desc]      = [String(item.desc)];
  if (item.price != null) fields[FIELDS.price] = item.price;
  if (item.unit)     fields[FIELDS.unit]      = item.unit;
  if (item.emoji)   fields[FIELDS.emoji]    = item.emoji;
  // 标签：多选字段，直接传数组
  if (item.tags && item.tags.length > 0) fields[FIELDS.tags] = item.tags;
  // 上架状态：文本字段，"TRUE" = 上架，空字符串 = 下架
  fields[FIELDS.available] = item.available ? 'TRUE' : '';
  return fields;
}

// ============================================================
// 启动服务
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ 企港渔叔后端服务已启动：http://localhost:${PORT}`);
  console.log(`   H5 前端：http://localhost:${PORT}/`);
  console.log(`   菜单 API：http://localhost:${PORT}/api/menu`);
  console.log(`   同步 API：http://localhost:${PORT}/api/menu/sync`);
  console.log(`   订单 API：http://localhost:${PORT}/api/orders`);
  console.log(`   订单表ID：${FEISHU_CONFIG.orderTableId}`);
});
