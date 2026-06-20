/**
 * 企港渔叔 · 飞书同步代理 Worker
 * 部署到 Cloudflare Workers（免费，10万次/天）
 * 解决浏览器 CORS 问题
 */
export default {
  async fetch(request) {
    const FEISHU = {
      appId:     'cli_aabf50321cb81bef',
      appSecret:  'PoAcoWez6fsP11jHp72WrgYtOZcXrWkS',
      appToken:   'CTB4bUoRvaaBvZsh7p7cYPI7nEf',
      tableId:    'tbl2dODf9nxi7iOZ',
    };
    const F = {
      category:  '分类',
      name:      '菜品名称',
      desc:      '描述',
      price:     '价格',
      unit:      '单位',
      emoji:     '表情',
      tags:      '标签',
      available: '上架状态',
    };

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Content-Type': 'application/json',
    };

    try {
      // 获取 tenant_access_token
      const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: FEISHU.appId, app_secret: FEISHU.appSecret }),
      });
      const tokenData = await tokenResp.json();
      if (tokenData.code !== 0) {
        return new Response(JSON.stringify({ success: false, error: tokenData.msg }), { status: 500, headers: corsHeaders });
      }
      const token = tokenData.tenant_access_token;
      const base = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU.appToken}/tables/${FEISHU.tableId}`;

      const url = new URL(request.url);
      const path = url.pathname;

      // ===== GET /api/menu — 读取菜单 =====
      if (path.endsWith('/api/menu') && request.method === 'GET') {
        const resp = await fetch(`${base}/records?page_size=500`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await resp.json();
        if (data.code !== 0) {
          return new Response(JSON.stringify({ success: false, error: data.msg }), { status: 500, headers: corsHeaders });
        }

        // 转换为 H5 菜单格式
        const catMap = {};
        for (const rec of data.data.items || []) {
          const f = rec.fields;
          const cat = f[F.category] || '未分类';
          if (!catMap[cat]) catMap[cat] = { name: cat, items: [] };
          const desc = Array.isArray(f[F.desc]) ? f[F.desc].join('. ') : (f[F.desc] || '');
          const tags = Array.isArray(f[F.tags]) ? f[F.tags] : [];
          catMap[cat].items.push({
            id: `i${Math.random().toString(36).slice(2,6)}`,
            name: f[F.name] || '',
            desc,
            price: Number(f[F.price]) || 0,
            unit: f[F.unit] || '份',
            emoji: f[F.emoji] || '🍽',
            tags,
            available: f[F.available] === 'TRUE',
          });
        }

        const menuData = Object.entries(catMap).map(([name, cat], idx) => ({
          id: `c${idx+1}`, name, icon: '📋', items: cat.items,
        }));

        return new Response(JSON.stringify({ success: true, menuData }), { headers: corsHeaders });
      }

      // ===== POST /api/menu/sync — 同步菜单到飞书 =====
      if (path.endsWith('/api/menu/sync') && request.method === 'POST') {
        const body = await request.json();
        const { menuData } = body;
        if (!menuData) {
          return new Response(JSON.stringify({ success: false, error: '缺少 menuData' }), { status: 400, headers: corsHeaders });
        }

        // 读取现有记录
        const existResp = await fetch(`${base}/records?page_size=500`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const existData = await existResp.json();
        const existMap = {};
        for (const rec of existData.data?.items || []) {
          const f = rec.fields;
          existMap[`${f[F.category]}|${f[F.name]}`] = rec.record_id;
        }

        let created = 0, updated = 0;
        for (const cat of menuData) {
          for (const item of cat.items) {
            const key = `${cat.name}|${item.name}`;
            const fields = {};
            fields[F.category]  = cat.name;
            fields[F.name]      = item.name;
            fields[F.desc]      = item.desc ? [item.desc] : [];
            fields[F.price]     = item.price;
            fields[F.unit]      = item.unit;
            fields[F.emoji]    = item.emoji;
            fields[F.tags]      = item.tags || [];
            fields[F.available] = item.available ? 'TRUE' : '';

            if (existMap[key]) {
              await fetch(`${base}/records/${existMap[key]}`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields }),
              });
              updated++;
            } else {
              await fetch(`${base}/records`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields }),
              });
              created++;
            }
          }
        }

        return new Response(JSON.stringify({ success: true, created, updated }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: false, error: 'Not Found' }), { status: 404, headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: corsHeaders });
    }
  }
};
