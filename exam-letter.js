(() => {
  const key = 'study-guokao-letter-2027-seen';
  const dialog = document.createElement('dialog');
  dialog.id = 'examLetter';
  dialog.setAttribute('aria-labelledby', 'examLetterTitle');
  dialog.innerHTML = `<form method="dialog"><button class="exam-letter-close" aria-label="关闭考前来信" autofocus>×</button><small class="exam-letter-kicker">一封考前来信 · 致努力的你</small><h2 id="examLetterTitle">写给即将走进<br>国考考场的你</h2><div class="exam-letter-copy"><p>这一路，你翻过的书、做过的题，<br>还有那些累了也没有放弃的晚上，<br>都算数。</p><p>最后的这段时间，按自己的节奏查漏补缺，<br>也记得好好吃饭、好好睡觉。<br>不必因为还有不会的题，就否定一路走来的自己。</p><p>走进考场时，把注意力放在眼前这一题。<br>会的稳稳拿下，难的从容取舍。</p><p class="exam-letter-wish">愿你落笔有底气，收笔无遗憾。<br>愿你的努力，在这个冬天收到回响。</p></div><div class="exam-letter-sign">小松鼠和学习资源库，<br>陪你走到考前最后一程。<span class="exam-letter-squirrel" aria-hidden="true"></span></div><button class="exam-letter-accept">收下祝福，稳稳向前</button><p class="exam-letter-poem">春风得意马蹄疾，一日看尽长安花</p></form>`;
  document.body.append(dialog);
  let returnFocus;
  const open = () => { if (dialog.open) return; returnFocus = document.activeElement; dialog.showModal(); };
  dialog.addEventListener('close', () => { try { localStorage.setItem(key, '1'); } catch (_) {} returnFocus?.focus?.(); });
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  const entry = document.createElement('button');
  entry.type = 'button'; entry.className = 'exam-letter-entry'; entry.textContent = '✉ 考前来信'; entry.addEventListener('click', open);
  (document.querySelector('.hero-copy .hero-actions') || document.querySelector('.hero-copy')).append(entry);
  const attempt = () => {
    try { if (localStorage.getItem(key)) return; } catch (_) {}
    if (document.hidden || document.querySelector('dialog[open], .shore-letter-modal:not(.is-hidden)')) { setTimeout(attempt, 1500); return; }
    open();
  };
  setTimeout(attempt, 2000);
})();
