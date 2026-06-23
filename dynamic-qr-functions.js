
// === 动态收款码相关函数（收钱吧预下单）===

// 轮询定时器
let _payPollTimer = null;

// 调用收钱吧预下单接口，生成动态收款二维码
async function generateDynamicQr(totalAmount, clientSn) {
  // 重置UI
  const dynamicArea  = document.getElementById('dynamicQrArea');
  const qrLoading    = document.getElementById('qrLoading');
  const dynamicImg   = document.getElementById('dynamicQrImg');
  const qrError      = document.getElementById('qrError');
  const staticFallback = document.getElementById('staticQrFallback');

  if (dynamicArea)  dynamicArea.style.display  = 'flex';
  if (qrLoading)    qrLoading.style.display    = '';
  if (dynamicImg)  { dynamicImg.style.display = 'none'; dynamicImg.src = ''; }
  if (qrError)      qrError.style.display      = 'none';
  if (staticFallback) staticFallback.style.display = 'none';

  try {
    const res  = await fetch(API_BASE + '/api/shoukuanba/precreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalAmountYuan: totalAmount, clientSn: clientSn })
    });
    const data = await res.json();

    if (!data.success || !data.qrCode) {
      console.error('预下单失败:', data.error);
      showStaticQrFallback();
      return;
    }

    // 用 qrserver.com 生成二维码图片
    const qrImgUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=' + encodeURIComponent(data.qrCode);
    if (dynamicImg) {
      dynamicImg.onload = () => {
        if (qrLoading) qrLoading.style.display = 'none';
        dynamicImg.style.display = 'block';
      };
      dynamicImg.onerror = () => { showStaticQrFallback(); };
      dynamicImg.src = qrImgUrl;
    }

    // 启动轮询检测支付状态
    startPaymentPolling(clientSn);

  } catch (err) {
    console.error('生成动态收款码失败:', err);
    showStaticQrFallback();
  }
}

// 启动轮询
function startPaymentPolling(clientSn) {
  stopPaymentPolling();
  _payPollTimer = setInterval(async () => {
    try {
      const res  = await fetch(API_BASE + '/api/shoukuanba/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientSn: clientSn })
      });
      const data = await res.json();
      if (data.success && (data.orderStatus === 'PAID' || data.payStatus === 'SUCCESS')) {
        stopPaymentPolling();
        onPaymentDetected(clientSn);
      }
    } catch (e) { /* 忽略单次轮询错误 */ }
  }, 3000);
}

// 停止轮询
function stopPaymentPolling() {
  if (_payPollTimer) { clearInterval(_payPollTimer); _payPollTimer = null; }
}

// 动态码失败时显示静态备用码
function showStaticQrFallback() {
  const dynamicArea  = document.getElementById('dynamicQrArea');
  const qrError      = document.getElementById('qrError');
  const staticFallback = document.getElementById('staticQrFallback');
  if (dynamicArea)  dynamicArea.style.display  = 'none';
  if (qrError)      qrError.style.display      = '';
  if (staticFallback) staticFallback.style.display = '';
}

// 检测到付款成功
function onPaymentDetected(clientSn) {
  // 自动解锁勾选框
  const checkbox = document.getElementById('payConfirmCheck');
  if (checkbox) {
    checkbox.disabled = false;
    checkbox.style.opacity = '1';
    checkbox.style.cursor  = 'pointer';
  }
  showToast('✅ 已检测到付款，请勾选确认');
}

// 关闭支付页时停止轮询
const _origHidePayPage = hidePayPage || function(){};
function hidePayPage() {
  stopPaymentPolling();
  if (_origHidePayPage) _origHidePayPage();
}
