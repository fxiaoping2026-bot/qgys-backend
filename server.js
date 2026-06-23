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
  analyticsTableId: process.env.FEISHU_ANALYTICS_TABLE_ID || 'tblnRZZ8ikYvkPMf',  // 用户行为统计表ID
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
  minOrderAmount: '换购门槛(元)', // 数字（换购品最低订单金额）
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

// 飞书用户行为表字段映射
const ANALYTICS_FIELDS = {
  'userId':     '用户ID',
  'phone':      '手机号',
  'eventType':  '事件类型',
  'eventData':  '事件数据',
  'timestamp':  '时间戳',
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
    const existingRecords = await fetchAllRecords(baseUrl, token);
    const existRec = existingRecords.find(r =>
      r.fields[ORDER_FIELDS.orderNo] === no
    );

    const fields = {};
    fields[ORDER_FIELDS.orderNo] = no;
    fields[ORDER_FIELDS.phone]   = phone;
    fields[ORDER_FIELDS.status]  = status || 'accepted';  // 付款后默认已接单
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
// 通用：循环获取飞书所有页记录（处理分页）
// ============================================================
async function fetchAllRecords(baseUrl, token) {
  let allRecords = [];
  let pageToken = '';
  do {
    const url = pageToken
      ? `${baseUrl}/records?page_size=500&page_token=${pageToken}`
      : `${baseUrl}/records?page_size=500`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(data.msg);
    allRecords = allRecords.concat(data.data.items || []);
    pageToken = data.data?.next_page_token || '';
  } while (pageToken);
  return allRecords;
}

// ============================================================
// API：获取所有订单（商家后台用）— 必须在 /:phone 前面
// GET /api/orders/all
// ============================================================
app.get('/api/orders/all', async (req, res) => {
  try {
    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.orderTableId}`;
    const records = await fetchAllRecords(baseUrl, token);

    const orders = records.map(r => ({
      _recordId: r.record_id,
      no:      r.fields[ORDER_FIELDS.orderNo]  || '',
      phone:   r.fields[ORDER_FIELDS.phone]    || '',
      status:  r.fields[ORDER_FIELDS.status]   || 'accepted',
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
    const records = await fetchAllRecords(baseUrl, token);

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

    // 查找记录（处理分页）
    const records = await fetchAllRecords(baseUrl, token);
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
// API：查询订单状态（轻量级，前端轮询用）
// GET /api/orders/:orderNo/status
// 只返回状态，不返回完整订单详情
// ============================================================
app.get('/api/orders/:orderNo/status', async (req, res) => {
  try {
    const orderNo = req.params.orderNo;
    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.orderTableId}`;

    const records = await fetchAllRecords(baseUrl, token);
    const target = records.find(r => r.fields[ORDER_FIELDS.orderNo] === orderNo);
    if (!target) return res.status(404).json({ success: false, error: '订单不存在' });

    const status = target.fields[ORDER_FIELDS.status] || 'accepted';
    res.json({ success: true, orderNo, status });
  } catch (err) {
    console.error('查询订单状态失败:', err);
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
      minOrderAmount: Number(f[FIELDS.minOrderAmount]) || 0,  // 直接从飞书读取换购门槛
    });
  }

  // 转为 menuData 格式（与 H5 index.html 的 menuData 结构一致）
  // 换购品识别：名称含"换购"或 desc 含"满"+"元" → 自动补 minOrderAmount
  function isPromoItem(name, desc) {
    if (name && name.includes('换购')) return true;
    if (desc && (desc.includes('换购') || /满\s*\d+\s*元/.test(desc))) return true;
    return false;
  }
  const iconMap = { '招牌生蚝': '🦪', '海鲜小炒': '🍳', '主食': '🍚', '酒水饮料': '🥤', '未分类': '📋' };
  const menuData = Object.entries(catMap).map(([name, items], idx) => ({
    id: `c${idx + 1}`,
    name,
    icon: iconMap[name] || '📋',
    items: items.map((item, i) => {
      const base = {
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
      };
      // 识别换购品，补上 minOrderAmount（优先用飞书字段，否则自动识别）
      if (item.minOrderAmount && item.minOrderAmount > 0) {
        base.minOrderAmount = item.minOrderAmount;
      } else if (isPromoItem(item.name, item.desc)) {
        base.minOrderAmount = 39;
      }
      return base;
    }),
  }));
  return menuData;
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
  // 换购门槛：数字字段，识别为换购品但无字段时默认 39
  if (item.minOrderAmount && item.minOrderAmount > 0) {
    fields[FIELDS.minOrderAmount] = item.minOrderAmount;
  } else if (
    (item.name && item.name.includes('换购')) ||
    (item.desc && (item.desc.includes('换购') || /满\s*\d+\s*元/.test(item.desc)))
  ) {
    fields[FIELDS.minOrderAmount] = 39;
  }
  return fields;
}

// ============================================================
// 收钱吧对接 · 预下单（固定金额收款码，金额锁定防少付）
// ============================================================

const crypto = require('crypto');

// 收钱吧配置（优先读环境变量，未配置时预下单接口会返回友好错误）
const SKB_CONFIG = {
  // 收钱吧 API 域名（生产环境，文档P13明确指定）
  apiDomain:   process.env.SKB_API_DOMAIN   || 'https://vsi-api.shouqianba.com',
  // 开发者序列号（vendor_sn）和密钥 — 收钱吧邮件提供（2026-06）
  vendorSn:   process.env.SKB_VENDOR_SN  || '91803657',
  vendorKey:  process.env.SKB_VENDOR_KEY || '33622997611999cd3a7f5c6e30375da0',
  // 终端号（terminal_sn）和终端密钥 — 激活后获得，直接写死避免重复激活
  // 激活响应在 biz_response 里：result.biz_response.terminal_sn / terminal_key
  terminalSn:  process.env.SKB_TERMINAL_SN || '100118780056071075',
  terminalKey: process.env.SKB_TERMINAL_KEY || '58d3d9659cb8138be2076a936af8b8e4',
  // 应用编号（app_id）— C扫B 场景
  appId:      process.env.SKB_APP_ID      || '2026062300011878',
};

// MD5 签名：请求 body 原始字符串 + key → 32位小写
// 适用于：激活/签到/查询/退款 等非支付接口（文档P15）
function skpSign(bodyStr, key) {
  return crypto.createHash('md5').update(bodyStr + key, 'utf8').digest('hex').toLowerCase();
}

// ============================================================
// 跳转支付接口签名（文档P27）
// 规则：URL参数按ASCII排序 → 拼成 key=value&... → 加 &key=密钥 → MD5大写
// 适用于：WAP支付URL拼接（前端跳转支付用）
// ============================================================
function signWapParams(params, key) {
  // 1. 过滤 sign、sign_type 和空值
  const filtered = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'sign' && k !== 'sign_type' && v !== undefined && v !== null && String(v) !== '') {
      filtered[k] = String(v);
    }
  }
  // 2. 按ASCII升序排序
  const sortedKeys = Object.keys(filtered).sort();
  // 3. 拼成 key=value&key2=value2
  let str = '';
  for (const k of sortedKeys) {
    str += (str ? '&' : '') + k + '=' + filtered[k];
  }
  // 4. 加 &key=密钥
  str += '&key=' + key;
  // 5. MD5 → 转大写
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

// ============================================================
// 终端激活（用 vendor_sn 获取 terminal_sn + terminal_key）
// 收钱吧规则：支付接口必须用 terminal_sn 签名，vendor_sn 不能直接用于收款
// ============================================================
let _cachedTerminal = { sn: null, key: null, expireAt: 0 };
const TERMINAL_CACHE_HRS = 23;  // 缓存23小时（收钱吧terminal有有效期）

/**
 * 获取可用的 terminal_sn / terminal_key
 * 优先用配置的值；若未配置则自动调激活接口获取并缓存
 */
function getTerminalCredentialsSync() {
  // 已配置了 terminal → 直接返回（同步）
  if (SKB_CONFIG.terminalSn && SKB_CONFIG.terminalKey) {
    return { sn: SKB_CONFIG.terminalSn, key: SKB_CONFIG.terminalKey };
  }
  throw new Error('终端凭证未配置（terminal_sn/terminal_key为空），请在server.js中SKB_CONFIG填写激活后的值');
}

async function getTerminalCredentials() {
  // 1. 已配置了 terminal → 直接返回
  if (SKB_CONFIG.terminalSn && SKB_CONFIG.terminalKey) {
    return { sn: SKB_CONFIG.terminalSn, key: SKB_CONFIG.terminalKey };
  }
  // 2. 内存缓存还有效
  if (_cachedTerminal.sn && Date.now() < _cachedTerminal.expireAt) {
    return { sn: _cachedTerminal.sn, key: _cachedTerminal.key };
  }
  // 3. 需要自动激活
  if (!SKB_CONFIG.vendorSn || !SKB_CONFIG.vendorKey) {
    throw new Error('缺少 vendor_sn/vendor_key，无法激活终端');
  }

  console.log('[收钱吧] 正在自动激活终端... code=44645586');
  const activateBody = {
    vendor_sn:   SKB_CONFIG.vendorSn,
    app_id:      '20282623G00D018178',
    device_id:   'QGYS_WEB_H5PAY',
    device_type: 'WEB',
    os_info:     'Node.js',
    code:        '44645586',  // 收钱吧提供的终端激活码
  };
  const bodyStr = JSON.stringify(activateBody);
  const sign    = skpSign(bodyStr, SKB_CONFIG.vendorKey);

  const apiRes = await fetch(`${SKB_CONFIG.apiDomain}/terminal/activate`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `${SKB_CONFIG.vendorSn} ${sign}`,
    },
    body: bodyStr,
  });
  const result = await apiRes.json();
  console.log('[收钱吧] 激活响应:', JSON.stringify(result));

  if (result.result === 'OK' || result.code === '0' || result.terminal_sn) {
    const tSn  = result.terminal_sn || result.sn || result.data?.terminal_sn;
    const tKey = result.terminal_key || result.key || result.data?.terminal_key;
    if (tSn && tKey) {
      _cachedTerminal = {
        sn: tSn,
        key: tKey,
        expireAt: Date.now() + TERMINAL_CACHE_HRS * 3600 * 1000,
      };
      console.log(`[收钱吧] ✅ 终端激活成功: ${tSn}`);
      return { sn: tSn, key: tKey };
    }
  }

  // 激活失败，抛出详细错误
  const errMsg = result.error_msg || result.message || result.msg || JSON.stringify(result);
  throw new Error(`终端激活失败(${errMsg})`);
}

// ============================================================
// 收钱吧：跳转支付URL生成（POST + GET双支持）
// GET版本用于避免浏览器CORS预检问题（简单请求无需预检）
// 返回：{ success, payUrl, sn }
// ============================================================

// 核心逻辑：提取参数 → 签名 → 生成支付URL
function generateWapPayUrl(params) {
  const amount = Number(params.totalAmount || params.totalAmountYuan);
  if (!amount || !params.clientSn) {
    throw new Error('缺少金额(totalAmount)或订单号(clientSn)');
  }
  if (amount <= 0) {
    throw new Error('金额必须大于0');
  }

  const cred = getTerminalCredentialsSync();
  const totalAmountFen = String(Math.round(amount * 100));

  const payParams = {
    terminal_sn: cred.sn,
    client_sn:    String(params.clientSn),
    total_amount: totalAmountFen,
    subject:      params.subject  || '企港渔叔-海鲜点餐',
    operator:     params.operator || '企港渔叔',
    return_url:   params.returnUrl || '',
  };

  const sign = signWapParams(payParams, cred.key);
  payParams.sign = sign;

  return `${SKB_CONFIG.apiDomain}/upay/v2/pay?${new URLSearchParams(payParams).toString()}`;
}

// POST 版本（从body取参数）
app.post('/api/shoukuanba/wap-pay-url', async (req, res) => {
  try {
    const payUrl = generateWapPayUrl(req.body);
    console.log(`✅ [POST] 收钱吧支付URL: clientSn=${req.body.clientSn}`);
    res.json({ success: true, payUrl, sn: '' });
  } catch (err) {
    console.error('[POST] 收钱吧支付URL失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET 版本（从query取参数，避免CORS预检）
app.get('/api/shoukuanba/wap-pay-url', async (req, res) => {
  try {
    const payUrl = generateWapPayUrl(req.query);
    console.log(`✅ [GET] 收钱吧支付URL: clientSn=${req.query.clientSn}`);
    res.json({ success: true, payUrl, sn: '' });
  } catch (err) {
    console.error('[GET] 收钱吧支付URL失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 收钱吧：支付跳转页（后端调用API，拿到pay_url后302重定向）
// 解决问题：表单直接POST到收钱吧返回JSON，浏览器显示白屏
// 新方案：后端fetch调用收钱吧API → 解析JSON拿到pay_url → 302重定向
// ============================================================
app.get('/api/shoukuanba/pay-redirect', async (req, res) => {
  try {
    const amount = Number(req.query.totalAmount || req.query.totalAmountYuan);
    if (!amount || !req.query.clientSn) {
      return res.status(400).send('缺少金额或订单号');
    }

    const cred = getTerminalCredentialsSync();
    const totalAmountFen = String(Math.round(amount * 100));

    const payParams = {
      terminal_sn:  cred.sn,
      client_sn:     String(req.query.clientSn),
      total_amount:  totalAmountFen,
      subject:       req.query.subject  || '企港渔叔-海鲜点餐',
      operator:      req.query.operator || '企港渔叔',
    };
    // return_url 非空才加（空值会导致签名错误或API报错）
    if (req.query.returnUrl && String(req.query.returnUrl).trim()) {
      payParams.return_url = String(req.query.returnUrl).trim();
    }

    const sign = signWapParams(payParams, cred.key);
    payParams.sign = sign;

    // 调试：打印完整请求参数（不含key）
    const debugParams = { ...payParams };
    delete debugParams.sign;
    console.log(`[PAY-REDIRECT] 请求参数:`, JSON.stringify(debugParams));
    console.log(`[PAY-REDIRECT] 签名: ${sign}`);

    // 后端直接调用收钱吧API（server-side fetch）
    const apiUrl = `${SKB_CONFIG.apiDomain}/upay/v2/pay`;
    const formData = Object.entries(payParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    console.log(`[PAY-REDIRECT] 调用收钱吧API: clientSn=${req.query.clientSn}, amount=${totalAmountFen}分`);

    const apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData
    });

    const responseText = await apiRes.text();
    console.log(`[PAY-REDIRECT] 收钱吧API响应: ${responseText.substring(0, 500)}`);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('[PAY-REDIRECT] API返回非JSON:', responseText.substring(0, 200));
      return res.status(500).send(`支付API返回格式异常，请稍后重试。<br><small>${responseText.substring(0, 200)}</small>`);
    }

    // 收钱吧成功响应：result_code === '200' 或 '000000'（不同接口可能不同）
    // 成功时会返回 pay_url 或类似字段，需要重定向到该URL
    if (data.result_code === '200' || data.result_code === '000000' || data.code === 200) {
      // 尝试获取支付跳转URL（字段名可能是 pay_url / data.pay_url / url 等）
      const payUrl = data.pay_url || (data.data && data.data.pay_url) || data.url || (data.data && data.data.url);
      if (payUrl) {
        console.log(`[PAY-REDIRECT] 获取到支付URL，重定向: ${payUrl}`);
        return res.redirect(302, payUrl);
      } else {
        // 没有pay_url，可能是直接返回HTML（某些收钱吧接口直接返回支付页面）
        // 直接把API响应返回给浏览器
        console.log('[PAY-REDIRECT] 无pay_url字段，直接返回API响应');
        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.send(responseText);
      }
    } else {
      // 请求失败：把完整请求和响应都返回，方便调试
      const debugInfo = {
        request_params: debugParams,
        signature: sign,
        api_response: data,
      };
      console.error(`[PAY-REDIRECT] 收钱吧API错误:`, data);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>支付失败 - 调试信息</title></head>
        <body style="font-family:sans-serif;padding:20px;background:#fff;max-width:600px;margin:0 auto;">
          <h2 style="color:#e53935;">⚠️ 支付请求失败</h2>
          <p><b>错误代码:</b> ${data.result_code || data.code || '未知'}</p>
          <p><b>错误信息:</b> ${errorMsg}</p>
          <hr>
          <h3>调试信息（供开发者排查）</h3>
          <p><b>请求参数:</b></p>
          <pre style="background:#f5f5f5;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;">${JSON.stringify(debugParams, null, 2)}</pre>
          <p><b>签名:</b> <code>${sign}</code></p>
          <p><b>API完整响应:</b></p>
          <pre style="background:#f5f5f5;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;">${responseText}</pre>
          <br>
          <button onclick="window.history.back()" style="padding:12px 24px;background:#f5a623;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;">返回重新下单</button>
        </body>
        </html>
      `);
    }
  } catch (err) {
    console.error('[PAY-REDIRECT] 支付跳转失败:', err.message);
    res.status(500).send(`支付跳转失败: ${err.message}`);
  }
});

// ====== POST /api/shoukuanba/query
app.post('/api/shoukuanba/query', async (req, res) => {
  try {
    const { clientSn } = req.body;
    if (!clientSn) return res.status(400).json({ success: false, error: '缺少 clientSn' });

    // 获取终端凭证（自动激活或用配置值）
    let useSn, useKey;
    try {
      const cred = await getTerminalCredentials();
      useSn  = cred.sn;
      useKey = cred.key;
    } catch (e) {
      return res.status(500).json({ success: false, error: `获取终端凭证失败: ${e.message}` });
    }

    const body    = { terminal_sn: useSn, client_sn: String(clientSn) };
    const bodyStr = JSON.stringify(body);
    const sign    = skpSign(bodyStr, useKey);

    const apiRes  = await fetch(`${SKB_CONFIG.apiDomain}/upay/v2/query`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `${useSn} ${sign}`,
      },
      body: bodyStr,
    });
    const apiData = await apiRes.json();

    if (apiData.result_code !== '200') {
      return res.status(500).json({ success: false, error: apiData.error_message || '查询失败' });
    }

    const data        = (apiData.biz_response && apiData.biz_response.data) || {};
    const orderStatus = data.order_status || '';   // "CREATED" | "PAID" | "CANCELLED"
    const payStatus   = data.status       || '';   // "IN_PROG" | "SUCCESS" | "FAILED"

    res.json({ success: true, orderStatus, payStatus, raw: data });
  } catch (err) {
    console.error('收钱吧查询异常:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 用户行为追踪系统（基于飞书多维表格，数据持久化不丢失）
// ============================================================

// 接收追踪事件 — 直接写入飞书
app.post('/api/track', async (req, res) => {
  try {
    const { userId, eventType, eventData, phone } = req.body;

    if (!userId || !eventType) {
      return res.status(400).json({ error: '缺少必需参数' });
    }

    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.analyticsTableId}`;

    const fields = {};
    fields[ANALYTICS_FIELDS.userId] = userId;
    fields[ANALYTICS_FIELDS.phone] = (phone || '').trim();
    fields[ANALYTICS_FIELDS.eventType] = eventType;
    fields[ANALYTICS_FIELDS.eventData] = JSON.stringify(eventData || {});
    fields[ANALYTICS_FIELDS.timestamp] = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ');

    const resp = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(data.msg);

    res.json({ success: true, id: data.data?.record?.record_id });
  } catch (err) {
    console.error('❌ 追踪事件写入飞书失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取统计数据（商家后台用）— 从飞书读取
app.get('/api/analytics', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.analyticsTableId}`;

    // 获取全部记录（用分页函数）
    const records = await fetchAllRecords(baseUrl, token);

    // 今日独立访客数（基于 page_view 事件去重）
    const todayVisitorIds = new Set();
    // 今日事件统计
    const todayStats = {};
    // 全量用户（所有时间，用于复购等跨天统计）
    const allUserIds = new Set();
    const submitOrderUsers = {}; // user_id -> 下单次数

    records.forEach(r => {
      const f = r.fields;
      const uid = f[ANALYTICS_FIELDS.userId];
      const etype = f[ANALYTICS_FIELDS.eventType];
      const ts = f[ANALYTICS_FIELDS.timestamp] || '';

      allUserIds.add(uid);

      // 是否是今天
      const isToday = ts.startsWith(today);

      if (isToday) {
        // 统计今日访客（有 page_view 事件的独立用户）
        if (etype === 'page_view') {
          todayVisitorIds.add(uid);
        }
        if (!todayStats[etype]) todayStats[etype] = { users: new Set(), events: 0 };
        todayStats[etype].users.add(uid);
        todayStats[etype].events++;
      }

      // 统计下单次数（用于复购计算）
      if (etype === 'submit_order') {
        const day = ts.split('T')[0];
        const key = `${uid}_${day}`;
        submitOrderUsers[key] = (submitOrderUsers[key] || 0) + 1;
      }
    });

    // 复购用户：同一天内下单超过1次的用户
    let repeatCount = 0;
    const repeatUidSet = new Set();
    Object.entries(submitOrderUsers).forEach(([key, count]) => {
      if (count > 1) {
        const uid = key.split('_')[0]; // user_id部分
        repeatUidSet.add(uid);
      }
    });
    repeatCount = repeatUidSet.size;

    // 格式化输出（Set转数字）
    const events = {};
    Object.keys(todayStats).forEach(k => {
      events[k] = { users: todayStats[k].users.size, events: todayStats[k].events };
    });

    res.json({
      date: today,
      totalUsers: todayVisitorIds.size,    // 今日独立访客（基于page_view去重）
      allTimeUsers: allUserIds.size,       // 全量累积用户（供参考）
      repeatUsers: repeatCount,
      events,
      conversionRate: events.page_view && events.submit_order
        ? (events.submit_order.users / events.page_view.users * 100).toFixed(2) + '%'
        : '0%'
    });
  } catch (err) {
    console.error('❌ 统计查询失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取详细统计数据（从飞书读取）
app.get('/api/analytics/detail', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const token = await getTenantToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.analyticsTableId}`;

    const records = await fetchAllRecords(baseUrl, token);

    // 过滤日期范围
    let filtered = records;
    if (startDate || endDate) {
      filtered = records.filter(r => {
        const ts = r.fields[ANALYTICS_FIELDS.timestamp] || '';
        const d = ts.split('T')[0];
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
      });
    }

    // 每日统计
    const dailyStats = {};
    filtered.forEach(r => {
      const ts = r.fields[ANALYTICS_FIELDS.timestamp] || '';
      const date = ts.split('T')[0];
      const etype = r.fields[ANALYTICS_FIELDS.eventType];
      const uid = r.fields[ANALYTICS_FIELDS.userId];

      if (!dailyStats[date]) dailyStats[date] = {};
      if (!dailyStats[date][etype]) dailyStats[date][etype] = { users: new Set(), events: 0 };
      dailyStats[date][etype].users.add(uid);
      dailyStats[date][etype].events++;
    });

    // 热门菜品统计
    const itemMap = {};
    filtered.filter(r => r.fields[ANALYTICS_FIELDS.eventType] === 'item_view').forEach(r => {
      let itemName = '未知菜品';
      try {
        const ed = JSON.parse(r.fields[ANALYTICS_FIELDS.eventData] || '{}');
        itemName = ed.itemName || '未知菜品';
      } catch(e) {}

      if (!itemMap[itemName]) itemMap[itemName] = { views: 0, users: new Set() };
      itemMap[itemName].views++;
      itemMap[itemName].users.add(r.fields[ANALYTICS_FIELDS.userId]);
    });

    const hotItems = Object.entries(itemMap)
      .map(([name, data]) => ({ name, views: data.views, users: data.users.size }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 20);

    // 将Set转为数字以便JSON序列化
    const dailyOutput = {};
    const aggregatedEvents = {}; // 聚合所有日期的事件（给漏斗图用）
    Object.keys(dailyStats).forEach(date => {
      dailyOutput[date] = {};
      Object.keys(dailyStats[date]).forEach(etype => {
        dailyOutput[date][etype] = {
          users: dailyStats[date][etype].users.size,
          events: dailyStats[date][etype].events
        };
        // 聚合到全局events
        if (!aggregatedEvents[etype]) aggregatedEvents[etype] = { users: new Set(), events: 0 };
        dailyStats[date][etype].users.forEach(u => aggregatedEvents[etype].users.add(u));
        aggregatedEvents[etype].events += dailyStats[date][etype].events;
      });
    });

    // 将聚合的Set也转为数字
    const eventsOutput = {};
    Object.keys(aggregatedEvents).forEach(k => {
      eventsOutput[k] = { users: aggregatedEvents[k].users.size, events: aggregatedEvents[k].events };
    });

    res.json({
      dailyStats: dailyOutput,
      hotItems,
      events: eventsOutput  // 兼容前端 renderFunnelChart
    });
  } catch (err) {
    console.error('❌ 详细统计查询失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 同步统计数据到飞书（兼容前端按钮，数据已实时写入无需额外操作）
app.post('/api/analytics/sync-to-feishu', async (req, res) => {
  res.json({ success: true, message: '数据已实时同步到飞书' });
});

// ============================================================
// 启动服务
// ============================================================

app.listen(PORT, () => {
  console.log(`✅ 企港渔叔后端服务已启动：http://localhost:${PORT}`);
  console.log(`   H5 前端：http://localhost:${PORT}/`);
  console.log(`   菜单 API：http://localhost:${PORT}/api/menu`);
  console.log(`   同步 API：http://localhost:${PORT}/api/menu/sync`);
  console.log(`   订单 API：http://localhost:${PORT}/api/orders`);
  console.log(`   追踪 API：http://localhost:${PORT}/api/track`);
  console.log(`   统计 API：http://localhost:${PORT}/api/analytics`);
  console.log(`   订单表ID：${FEISHU_CONFIG.orderTableId}`);
});
