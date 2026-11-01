(() => {
  const font = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  let preview, image, feedback, currentUrl = '', filename = '';
  function fullDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    return [h ? `${h} 小时` : '', m ? `${m} 分钟` : '', s ? `${s} 秒` : ''].filter(Boolean).join(' ') || '0 分钟';
  }
  function download() {
    const link = document.createElement('a');
    link.href = currentUrl; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    feedback.textContent = '已发起 PNG 下载；手机也可长按图片保存。';
  }
  function ensurePreview() {
    if (preview) return;
    preview = document.createElement('dialog');
    preview.className = 'squirrel-study-card-dialog';
    preview.setAttribute('aria-labelledby', 'squirrelStudyCardTitle');
    const heading = document.createElement('div'); heading.className = 'study-card-heading';
    const title = document.createElement('h2'); title.id = 'squirrelStudyCardTitle'; title.textContent = '今日学习卡片';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
    close.addEventListener('click', () => preview.close());
    image = document.createElement('img');
    feedback = document.createElement('p'); feedback.setAttribute('role', 'status');
    const save = document.createElement('button'); save.type = 'button'; save.className = 'study-card-save'; save.textContent = '保存 PNG 卡片'; save.addEventListener('click', download);
    heading.append(title, close); preview.append(heading, image, feedback, save); document.body.append(preview);
    preview.addEventListener('close', () => document.querySelector('#focusExport')?.focus({ preventScroll: true }));
    preview.addEventListener('click', event => { if (event.target === preview) { const rect = preview.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) preview.close(); } });
  }
  function squirrelImage() {
    return new Promise(resolve => {
      const picture = new Image();
      const timeout = setTimeout(() => resolve(null), 2500);
      picture.onload = () => { clearTimeout(timeout); resolve(picture); };
      picture.onerror = () => { clearTimeout(timeout); resolve(null); };
      picture.src = 'assets/archive-squirrel-actions-v1-optimized.webp?v=20261101';
    });
  }
  window.exportSquirrelStudyCard = async summary => {
    const canvas = document.createElement('canvas');
    const rows = Math.max(2, Math.ceil(summary.items.length / 2));
    canvas.width = 1080; canvas.height = 800 + rows * 145;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    const W = canvas.width, H = canvas.height;
    function box(x, y, width, height, radius, fill) {
      ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fillStyle = fill; ctx.fill();
    }
    function text(value, x, y, size, color = '#244535', weight = 400) {
      ctx.fillStyle = color; ctx.font = `${weight} ${size}px ${font}`; ctx.fillText(value, x, y);
    }
    ctx.fillStyle = '#eef2e7'; ctx.fillRect(0, 0, W, H);
    const gradient = ctx.createLinearGradient(0, 0, W, H); gradient.addColorStop(0, '#f9f8ed'); gradient.addColorStop(1, '#e3ebd9');
    box(28, 28, W - 56, H - 56, 40, gradient);
    ctx.fillStyle = '#d8e4ca'; ctx.beginPath(); ctx.arc(987, 90, 200, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e3e9d7'; ctx.beginPath(); ctx.arc(20, H - 30, 130, 0, Math.PI * 2); ctx.fill();
    text('小松鼠陪学', 80, 112, 29, '#547257', 650);
    text('今日学习卡片', 80, 198, 64, '#244535', 700);
    text(summary.date.replaceAll('-', ' / '), 83, 254, 26, '#73846b');
    text('你认真学，我陪你看书。', 83, 310, 26, '#8d7950');
    const squirrel = await squirrelImage();
    if (squirrel) {
      const sw = squirrel.naturalWidth / 4, sh = squirrel.naturalHeight / 2;
      ctx.drawImage(squirrel, sw * 3, 0, sw, sh, 766, 84, 217, 260);
    }
    box(72, 370, 936, 200, 25, '#294c39');
    text('今日累计专注', 104, 418, 23, '#c7d6b8');
    const total = fullDuration(summary.totalMs);
    text(total, 100, 499, total.length > 15 ? 45 : 59, '#f6f5df', 650);
    text(`完成 ${summary.completed} 轮   ·   学习 ${summary.items.length} 项内容`, 104, 542, 23, '#c7d6b8');
    text('今天学了什么', 80, 639, 32, '#244535', 650);
    text('每一小步，都算数', 745, 638, 22, '#8d7950');
    if (summary.items.length) {
      summary.items.forEach((item, index) => {
        const x = 72 + index % 2 * 478, y = 670 + Math.floor(index / 2) * 145;
        box(x, y, 458, 124, 18, '#ffffffb3');
        box(x + 22, y + 27, 5, 69, 3, '#c5a45c');
        text(item.subject, x + 43, y + 48, 27, '#244535', 650);
        text(fullDuration(item.ms), x + 43, y + 91, 25, '#647c59');
      });
    } else {
      box(72, 670, 936, rows * 145 - 21, 20, '#ffffffb3');
      text('今日还没有学习记录', 126, 760, 36, '#547257', 650);
      text('选一项内容，从第一轮专注开始。', 126, 821, 28, '#73846b');
    }
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(summary.generatedAt));
    text(`截至 ${time} · ${summary.active ? '包含本轮已学时长' : '今日学习记录'}`, 82, H - 91, 21, '#647c59');
    text('不含暂停与休息 · 以北京时间统计', 82, H - 52, 19, '#73846b');
    text('学习资源库', 832, H - 57, 23, '#547257', 650);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG unavailable')), 'image/png'));
    ensurePreview();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(blob); filename = `小松鼠陪学-${summary.date}.png`;
    image.src = currentUrl;
    image.alt = `${summary.date} 今日学习卡片，累计专注 ${total}，完成 ${summary.completed} 轮。${summary.items.map(item => `${item.subject} ${fullDuration(item.ms)}`).join('；')}`;
    if (!preview.open) preview.showModal();
    download();
  };
})();
