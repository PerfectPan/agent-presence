/* dev-grab — tiny element grabber for design fine-tuning.
 * Active only on localhost. Hold Alt/Option to highlight, Alt-click any element
 * to copy a compact context blurb (selector + computed styles + box + text) to
 * the clipboard. Paste it to the agent to tune that exact element. */
(() => {
  const host = location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return;
  if (window.__apGrab) return;
  window.__apGrab = true;

  const PROPS = [
    'color', 'background-color', 'border-top-width', 'border-style', 'border-color',
    'border-radius', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'padding', 'margin', 'box-shadow', 'display', 'gap',
    'width', 'height', 'text-align', 'opacity',
  ];

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563eb;' +
    'background:rgba(37,99,235,.10);border-radius:4px;display:none;transition:all .04s;';
  const hint = document.createElement('div');
  hint.textContent = '⌥ Alt + 点 = 抓取元素';
  hint.style.cssText =
    'position:fixed;left:14px;bottom:14px;z-index:2147483647;font:600 12px/1 ui-monospace,monospace;' +
    'color:#fff;background:#2563eb;padding:8px 12px;border-radius:999px;box-shadow:0 6px 20px -6px rgba(37,99,235,.6);' +
    'opacity:.55;transition:opacity .15s;user-select:none;';
  const toast = document.createElement('div');
  toast.style.cssText =
    'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:2147483647;' +
    'font:600 13px/1.4 ui-monospace,monospace;color:#fff;background:#0e1018;padding:10px 16px;' +
    'border-radius:10px;box-shadow:0 10px 30px -8px rgba(0,0,0,.5);display:none;max-width:80vw;';
  addEventListener('DOMContentLoaded', () => {
    document.body.append(overlay, hint, toast);
  });
  if (document.body) document.body.append(overlay, hint, toast);

  let target = null;
  const ignore = (el) => el === overlay || el === hint || el === toast;

  addEventListener('mousemove', (e) => {
    if (!e.altKey) { overlay.style.display = 'none'; target = null; hint.style.opacity = '.55'; return; }
    hint.style.opacity = '1';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || ignore(el)) return;
    target = el;
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }, true);

  addEventListener('keyup', (e) => { if (e.key === 'Alt') { overlay.style.display = 'none'; hint.style.opacity = '.55'; } });

  addEventListener('click', (e) => {
    if (!e.altKey) return;
    const el = target || document.elementFromPoint(e.clientX, e.clientY);
    if (!el || ignore(el)) return;
    e.preventDefault();
    e.stopPropagation();
    copy(el);
  }, true);

  function cssPath(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n.tagName !== 'BODY' && parts.length < 4) {
      let seg = n.tagName.toLowerCase();
      if (n.id) { seg = '#' + n.id; parts.unshift(seg); break; }
      const cls = (n.className && n.className.toString().trim().split(/\s+/).slice(0, 2).join('.'));
      if (cls) seg += '.' + cls;
      const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      parts.unshift(seg);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  async function copy(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const styles = PROPS.map((p) => `  ${p}: ${cs.getPropertyValue(p).trim()}`).join('\n');
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const blurb =
      `## grabbed element\n` +
      `- page: ${location.pathname}\n` +
      `- selector: \`${cssPath(el)}\`\n` +
      `- tag: <${el.tagName.toLowerCase()}>` +
      (el.id ? ` id="${el.id}"` : '') +
      (el.className ? ` class="${el.className.toString().trim()}"` : '') + `\n` +
      `- box: ${Math.round(r.width)}×${Math.round(r.height)} @ (${Math.round(r.left)}, ${Math.round(r.top)})\n` +
      (text ? `- text: "${text}"\n` : '') +
      `- computed styles:\n${styles}\n`;
    try {
      await navigator.clipboard.writeText(blurb);
      flash('已复制元素 ✓  粘给 agent 即可');
    } catch {
      flash('复制失败(剪贴板权限?)— 见 console');
      console.log(blurb);
    }
  }

  let t;
  function flash(msg) {
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(t);
    t = setTimeout(() => (toast.style.display = 'none'), 1800);
  }
})();
