// 内网穿透脚本 - 将本地3000端口暴露到公网
const localtunnel = require('localtunnel');

(async () => {
  console.log('🔄 正在创建隧道，暴露端口 3000...');
  try {
    const tunnel = await localtunnel({ port: 3000 });
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ 隧道创建成功！');
    console.log(`🔗 公网地址: ${tunnel.url}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('📱 手机上复制以下地址到"后端设置"：');
    console.log(`   ${tunnel.url}`);
    console.log('');
    console.log('💡 隧道会持续运行，按 Ctrl+C 停止');
    console.log('');

    tunnel.on('close', () => {
      console.log('❌ 隧道已关闭');
      process.exit(0);
    });

    tunnel.on('error', (err) => {
      console.error('❌ 隧道错误:', err.message);
    });
  } catch (err) {
    console.error('❌ 创建隧道失败:', err.message);
    process.exit(1);
  }
})();
