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
  // 收钱吧 API 域名（生产环境）
  apiDomain:   process.env.SKB_API_DOMAIN   || 'https://api.shouqianba.com',
  // 终端号（terminal_sn）：收钱吧商户后台 → 终端管理 查看
  terminalSn:  process.env.SKB_TERMINAL_SN || '',
  // 终端密钥（terminal_key）：激活/签到后获得，或联系收钱吧客服获取
  terminalKey: process.env.SKB_TERMINAL_KEY || '',
};

// MD5 签名：请求 body 原始字符串 + terminalKey → 32位小写
function skpSign(bodyStr, key) {
  return crypto.createHash('md5').update(bodyStr + key, 'utf8').digest('hex').toLowerCase();
}

// ============================================================
// POST /api/shoukuanba/precreate
// 请求：{ totalAmountYuan: number, clientSn: string, subject?: string, payway?: string }
// 返回：{ success, qrCode, sn }  （qrCode 为支付平台二维码链接，金额已锁定）
// ============================================================
app.post('/api/shoukuanba/precreate', async (req, res) => {
  try {
    let { totalAmountYuan, clientSn, subject, payway } = req.body;

    // —— 参数校验 ——
    if (!totalAmountYuan || !clientSn) {
      return res.status(400).json({ success: false, error: '缺少 totalAmountYuan 或 clientSn' });
    }
    if (Number(totalAmountYuan) <= 0) {
      return res.status(400).json({ success: false, error: '金额必须大于0' });
    }
    if (!SKB_CONFIG.terminalSn || !SKB_CONFIG.terminalKey) {
      return res.status(500).json({
        success: false,
        error: '收钱吧配置未填写（SKB_TERMINAL_SN / SKB_TERMINAL_KEY）',
        needConfig: true,   // 前端可据此提示用户联系管理员
      });
    }

    // —— 金额转分（收钱吧要求单位为分，字符串） ——
    const totalAmountFen = String(Math.round(Number(totalAmountYuan) * 100));

    // —— 构造收钱吧预下单请求 body ——
    const body = {
      terminal_sn: SKB_CONFIG.terminalSn,
      client_sn: String(clientSn),
      total_amount: totalAmountFen,       // 单位：分，字符串
      payway:      payway || '3',         // 默认微信（3=微信，1=支付宝，4=百度钱包…）
      subject:     subject || '企港渔叔下单',
      operator:    '企港渔叔',
    };
    const bodyStr = JSON.stringify(body);
    const sign    = skpSign(bodyStr, SKB_CONFIG.terminalKey);

    // —— 发起预下单请求 ——
    const apiRes  = await fetch(`${SKB_CONFIG.apiDomain}/upay/v2/precreate`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `${SKB_CONFIG.terminalSn} ${sign}`,
      },
      body: bodyStr,
    });
    const apiData = await apiRes.json();

    // —— 解析返回 ——
    // 通讯层失败（参数错误、签名错误等）
    if (apiData.result_code !== '200') {
      return res.status(500).json({
        success: false,
        error: apiData.error_message || '收钱吧通讯失败',
        errorCode: apiData.error_code || '',
      });
    }
    // 业务层失败（商户订单号重复、余额不足等）
    if (!apiData.biz_response || apiData.biz_response.result_code !== 'PRECREATE_SUCCESS') {
      return res.status(500).json({
        success: false,
        error: (apiData.biz_response && apiData.biz_response.error_message) || '预下单失败',
        errorCode: apiData.biz_response ? apiData.biz_response.result_code : '',
      });
    }

    // —— 成功：返回 qr_code（支付平台二维码链接，金额已锁定） ——
    const data   = apiData.biz_response.data || {};
    const qrCode = data.qr_code;   // 如 "https://qr.alipay.com/..."
    const sn     = data.sn;         // 收钱吧唯一订单号

    if (!qrCode) {
      return res.status(500).json({ success: false, error: '收钱吧未返回二维码链接' });
    }

    console.log(`✅ 收钱吧预下单成功：clientSn=${clientSn}, sn=${sn}, amount=${totalAmountYuan}元`);
    res.json({ success: true, qrCode, sn });
  } catch (err) {
    console.error('收钱吧预下单异常:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/shoukuanba/query
// 查询订单支付状态（用于前端轮询）
// 请求：{ clientSn: string }
// 返回：{ success, orderStatus, payStatus }
//   orderStatus: "CREATED"=待支付, "PAID"=已支付, "CANCELLED"=已取消
// ============================================================
app.post('/api/shoukuanba/query', async (req, res) => {
  try {
    const { clientSn } = req.body;
    if (!clientSn) return res.status(400).json({ success: false, error: '缺少 clientSn' });
    if (!SKB_CONFIG.terminalSn || !SKB_CONFIG.terminalKey) {
      return res.status(500).json({ success: false, error: '收钱吧配置未填写' });
    }

    const body    = { terminal_sn: SKB_CONFIG.terminalSn, client_sn: String(clientSn) };
    const bodyStr = JSON.stringify(body);
    const sign    = skpSign(bodyStr, SKB_CONFIG.terminalKey);

    const apiRes  = await fetch(`${SKB_CONFIG.apiDomain}/upay/v2/query`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `${SKB_CONFIG.terminalSn} ${sign}`,
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
// 用户行为追踪系统
// ============================================================
const sqlite3 = require('sqlite3').verbose();
const DB_PATH = path.join(__dirname, 'analytics.db');

// 初始化数据库
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ 数据库连接失败:', err);
  } else {
    console.log('✅ 用户行为数据库已连接');
  }
});

// 创建追踪事件表
db.run(`
  CREATE TABLE IF NOT EXISTS track_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT,
    phone TEXT DEFAULT '',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) {
    console.error('❌ 创建追踪表失败:', err);
  } else {
    console.log('✅ 追踪事件表已就绪');
    // 如果 phone 字段不存在则添加（兼容旧数据）
    db.run(`ALTER TABLE track_events ADD COLUMN phone TEXT DEFAULT ''`, [], (alterErr) => {
      if (alterErr && !alterErr.message.includes('duplicate column')) {
        // 忽略已存在的错误
      }
    });
  }
});

// 创建索引（加速查询）
db.run(`CREATE INDEX IF NOT EXISTS idx_user_id ON track_events(user_id)`, () => {});
db.run(`CREATE INDEX IF NOT EXISTS idx_event_type ON track_events(event_type)`, () => {});
db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON track_events(timestamp)`, () => {});

// 接收追踪事件
app.post('/api/track', (req, res) => {
  const { userId, eventType, eventData, phone } = req.body;

  if (!userId || !eventType) {
    return res.status(400).json({ error: '缺少必需参数' });
  }

  const data = eventData ? JSON.stringify(eventData) : null;
  const phoneStr = (phone || '').trim();

  db.run(
    'INSERT INTO track_events (user_id, event_type, event_data, phone) VALUES (?, ?, ?, ?)',
    [userId, eventType, data, phoneStr],
    function(err) {
      if (err) {
        console.error('❌ 追踪事件存储失败:', err);
        return res.status(500).json({ error: '存储失败' });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// 获取统计数据（商家后台用）
app.get('/api/analytics', (req, res) => {
  // 获取今日数据
  const today = new Date().toISOString().split('T')[0];

  db.all(`
    SELECT
      event_type,
      COUNT(DISTINCT user_id) as user_count,
      COUNT(*) as event_count
    FROM track_events
    WHERE DATE(timestamp) = ?
    GROUP BY event_type
  `, [today], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: '查询失败' });
    }

    // 计算转化率
    const stats = {};
    rows.forEach(row => {
      stats[row.event_type] = {
        users: row.user_count,
        events: row.event_count
      };
    });

    // 获取总用户数
    db.get(`SELECT COUNT(DISTINCT user_id) as total_users FROM track_events`, [], (err, result) => {
      if (err) {
        return res.status(500).json({ error: '查询失败' });
      }

      // 获取复购用户数（下单超过1次的用户）
      db.all(`
        SELECT user_id, COUNT(DISTINCT DATE(timestamp)) as order_days
        FROM track_events
        WHERE event_type = 'submit_order'
        GROUP BY user_id
        HAVING order_days > 1
      `, [], (err, repeatUsers) => {
        if (err) {
          return res.status(500).json({ error: '查询失败' });
        }

        res.json({
          date: today,
          totalUsers: result.total_users || 0,
          repeatUsers: repeatUsers.length,
          events: stats,
          conversionRate: stats.page_view && stats.submit_order
            ? (stats.submit_order.users / stats.page_view.users * 100).toFixed(2) + '%'
            : '0%'
        });
      });
    });
  });
});

// 获取详细统计数据
app.get('/api/analytics/detail', (req, res) => {
  const { startDate, endDate } = req.query;

  let dateFilter = '';
  let params = [];

  if (startDate && endDate) {
    dateFilter = 'WHERE DATE(timestamp) BETWEEN ? AND ?';
    params = [startDate, endDate];
  } else if (startDate) {
    dateFilter = 'WHERE DATE(timestamp) >= ?';
    params = [startDate];
  }

  // 每日统计
  db.all(`
    SELECT
      DATE(timestamp) as date,
      event_type,
      COUNT(DISTINCT user_id) as user_count,
      COUNT(*) as event_count
    FROM track_events
    ${dateFilter}
    GROUP BY DATE(timestamp), event_type
    ORDER BY date DESC
  `, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: '查询失败' });
    }

    // 热门菜品统计
    db.all(`
      SELECT
        json_extract(event_data, '$.itemName') as item_name,
        COUNT(*) as view_count,
        COUNT(DISTINCT user_id) as user_count
      FROM track_events
      WHERE event_type = 'item_view' ${startDate ? 'AND DATE(timestamp) >= ?' : ''}
      GROUP BY item_name
      ORDER BY view_count DESC
      LIMIT 20
    `, startDate ? [startDate] : [], (err, hotItems) => {
      if (err) {
        return res.status(500).json({ error: '查询失败' });
      }

      res.json({
        dailyStats: rows,
        hotItems: hotItems
      });
    });
  });
});

// ============================================================
// 启动服务
// ============================================================

// ============================================================
// 同步追踪数据到飞书多维表格
// POST /api/analytics/sync-to-feishu
// ============================================================
app.post('/api/analytics/sync-to-feishu', (req, res) => {
  // 读取所有追踪数据
  db.all('SELECT * FROM track_events ORDER BY timestamp DESC', [], (err, rows) => {
    if (err) {
      console.error('读取追踪数据失败:', err);
      return res.status(500).json({ success: false, error: '读取数据失败' });
    }

    if (rows.length === 0) {
      return res.json({ success: true, message: '没有数据需要同步', synced: 0 });
    }

    // 检查是否配置了飞书表格ID
    if (!FEISHU_CONFIG.analyticsTableId) {
      return res.status(400).json({
        success: false,
        error: '未配置飞书表格ID，请在环境变量中设置 FEISHU_ANALYTICS_TABLE_ID'
      });
    }

    // 异步同步到飞书
    (async () => {
      try {
        const token = await getTenantToken();
        const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.analyticsTableId}`;

        // 1. 读取飞书现有记录（用于去重）
        const existResp = await fetch(`${baseUrl}/records?page_size=500`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const existData = await existResp.json();
        if (existData.code !== 0) {
          throw new Error(`读取飞书失败: ${existData.msg}`);
        }

        // 构建已存在记录的 ID 集合（用 user_id + timestamp 作为唯一键）
        const existSet = new Set();
        (existData.data?.items || []).forEach(rec => {
          const f = rec.fields;
          const key = `${f['用户ID'] || ''}_${f['时间戳'] || ''}`;
          existSet.add(key);
        });

        // 2. 逐条同步（跳过已存在的）
        let created = 0, skipped = 0;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const key = `${row.user_id}_${row.timestamp}`;
          if (existSet.has(key)) {
            skipped++;
            continue;
          }

          // 解析 event_data
          let eventData = {};
          try { eventData = JSON.parse(row.event_data || '{}'); } catch(e) {}

          const fields = {
            '用户ID': row.user_id,
            '手机号': row.phone || '',
            '事件类型': row.event_type,
            '事件数据': JSON.stringify(eventData),
            '时间戳': row.timestamp,
          };

          await fetch(`${baseUrl}/records`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields }),
          });
          created++;

          // 每 10 条暂停一下，避免频率限制
          if (created % 10 === 0) await new Promise(r => setTimeout(r, 500));
        }

        res.json({ success: true, created, skipped, total: rows.length });
      } catch (feishuErr) {
        console.error('同步到飞书失败:', feishuErr);
        res.status(500).json({ success: false, error: feishuErr.message });
      }
    })();
  });
});



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
