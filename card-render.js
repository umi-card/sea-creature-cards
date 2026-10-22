// 新しいカードのベース画像（見つけた日・人が空欄の状態）を描く。
// 座標はすべて既存カードと同じ 945×591 の空間。
(function (global) {
  const W = 945, H = 591;
  const JP = '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif';
  const LATIN = '"Helvetica Neue", Helvetica, Arial, sans-serif';

  // 既存カードを計測した配置
  const LAYOUTS = {
    // 縦長の写真：左に写真、右に文字（セミエビなどと同じ）
    portrait: {
      photo: { x: 59, y: 72, w: 248, h: 448 },
      title: { cx: 616, cy: 104, maxW: 570, size: 64 },
      sci: { cx: 616, cy: 171, size: 38, maxW: 570 },
      date: { labelX: 327, x0: 505, x1: 893, y: 272 },
      finder: { labelX: 327, x0: 505, x1: 893, y: 352 },
      feature: { x: 327, top: 393, maxW: 566, maxBottom: 575 },
    },
    // 横長の写真：上に写真、下に文字（カサゴなどと同じ）
    landscape: {
      inlineTitle: true,
      title: { cx: 472, cy: 92, maxW: 800, size: 56 },
      sci: { size: 36 },
      photo: { x: 200, y: 130, w: 545, h: 170 },
      date: { labelX: 190, x0: 368, x1: 755, y: 337 },
      finder: { labelX: 190, x0: 368, x1: 755, y: 417 },
      feature: { x: 114, top: 447, maxW: 746, maxBottom: 578 },
    },
  };

  const FONT_SPECS = [`900 64px ${JP}`, `700 28px ${JP}`];

  async function ensureFonts(text) {
    if (!document.fonts) return;
    const sample = (text || '') + '見つけた日人：特徴の仲間';
    await Promise.all(FONT_SPECS.map(f => document.fonts.load(f, sample).catch(() => {})));
  }

  function drawGrid(ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e6e6e6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 31; x < W; x += 35.25) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 3; y < H; y += 35.25) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  // 枠に合わせて写真を切り抜く。zoom=1 で枠いっぱい（はみ出す部分は切る）、ox/oy は -1〜1 のずらし量
  function drawPhoto(ctx, img, rect, view) {
    if (!img) {
      ctx.fillStyle = '#f1f4f6';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = '#9aa7b0';
      ctx.font = `700 22px ${JP}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('写真', rect.x + rect.w / 2, rect.y + rect.h / 2);
      return;
    }
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const zoom = Math.max(1, view.zoom || 1);
    const s = Math.max(rect.w / iw, rect.h / ih) * zoom;
    const dw = iw * s, dh = ih * s;
    const spareX = dw - rect.w, spareY = dh - rect.h;
    const dx = rect.x - spareX / 2 + (view.ox || 0) * spareX / 2;
    const dy = rect.y - spareY / 2 + (view.oy || 0) * spareY / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  function fitFont(ctx, text, weight, size, family, maxW, min) {
    let s = size;
    ctx.font = `${weight} ${s}px ${family}`;
    while (s > min && ctx.measureText(text).width > maxW) {
      s -= 1;
      ctx.font = `${weight} ${s}px ${family}`;
    }
    return s;
  }

  function drawField(ctx, label, f) {
    ctx.fillStyle = '#111';
    ctx.font = `700 28px ${JP}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.letterSpacing = '1px';
    ctx.fillText(label, f.labelX, f.y - 3);
    ctx.letterSpacing = '0px';
    ctx.fillRect(f.x0, f.y - 0.75, f.x1 - f.x0, 1.5);
  }

  // 行頭に来てはいけない文字（句読点など）は前の行に残す
  const NO_LINE_START = '、。，．,.」』）)]｝}〉》ー…・！？!?ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ';
  function wrap(ctx, text, maxW) {
    const lines = [];
    for (const para of text.replace(/\r/g, '').split('\n')) {
      let line = '';
      for (const ch of Array.from(para)) {
        if (line && ctx.measureText(line + ch).width > maxW && !NO_LINE_START.includes(ch)) {
          lines.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function drawFeature(ctx, text, f) {
    ctx.fillStyle = '#111';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 27px ${JP}`;
    ctx.letterSpacing = '1.5px';
    ctx.fillText('特徴', f.x, f.top);
    const body = (text || '').trim();
    if (!body) { ctx.letterSpacing = '0px'; return { overflow: false }; }
    // はみ出す場合は文字を小さくする
    for (let size = 27; size >= 16; size--) {
      ctx.font = `700 ${size}px ${JP}`;
      const lh = Math.round(size * 1.48);
      const lines = wrap(ctx, body, f.maxW);
      const firstY = f.top + lh;
      const lastY = firstY + (lines.length - 1) * lh;
      if (lastY + size / 2 <= f.maxBottom || size === 16) {
        lines.forEach((l, i) => ctx.fillText(l, f.x, firstY + i * lh));
        ctx.letterSpacing = '0px';
        return { overflow: lastY + size / 2 > f.maxBottom };
      }
    }
  }

  // data: { name, sci, feature, photo(Image|null), layout, view:{zoom,ox,oy}, preview }
  // 和名・学名は空でもよい。preview のときだけ、和名の場所にうすく「（和名）」を出す
  function render(ctx, data) {
    const L = LAYOUTS[data.layout] || LAYOUTS.portrait;
    const typed = (data.name || '').trim();
    const placeholder = !typed && data.preview;
    const name = typed || (placeholder ? '（和名）' : '');
    const sci = (data.sci || '').trim();
    const nameColor = placeholder ? '#c4c4c4' : '#111';

    drawGrid(ctx);
    drawPhoto(ctx, data.photo, L.photo, data.view || {});

    ctx.fillStyle = '#111';
    ctx.textBaseline = 'middle';
    if (L.inlineTitle) {
      // 和名と学名を横に並べて中央寄せ
      const gap = 18;
      let ts = L.title.size, ss = L.sci.size, tw, sw;
      const g = () => (name && sci ? gap : 0);
      for (;;) {
        ctx.font = `900 ${ts}px ${JP}`; tw = name ? ctx.measureText(name).width : 0;
        ctx.font = `italic 400 ${ss}px ${LATIN}`; sw = sci ? ctx.measureText(sci).width : 0;
        if (tw + g() + sw <= L.title.maxW || ts <= 30) break;
        ts -= 2; ss = Math.max(20, ss - 1);
      }
      let x = L.title.cx - (tw + g() + sw) / 2;
      ctx.textAlign = 'left';
      if (name) {
        ctx.fillStyle = nameColor;
        ctx.font = `900 ${ts}px ${JP}`;
        ctx.fillText(name, x, L.title.cy);
        ctx.fillStyle = '#111';
      }
      if (sci) {
        ctx.font = `italic 400 ${ss}px ${LATIN}`;
        ctx.fillText(sci, x + tw + g(), L.title.cy + ts * 0.06);
      }
    } else {
      ctx.textAlign = 'center';
      if (name) {
        fitFont(ctx, name, 900, L.title.size, JP, L.title.maxW, 28);
        ctx.fillStyle = nameColor;
        ctx.fillText(name, L.title.cx, L.title.cy);
        ctx.fillStyle = '#111';
      }
      if (sci) {
        fitFont(ctx, sci, 'italic 400', L.sci.size, LATIN, L.sci.maxW, 18);
        ctx.fillText(sci, L.sci.cx, L.sci.cy);
      }
    }

    drawField(ctx, '見つけた日：', L.date);
    drawField(ctx, '見つけた人：', L.finder);
    const res = drawFeature(ctx, data.feature, L.feature) || {};

    return {
      overflow: !!res.overflow,
      date: { x0: L.date.x0, x1: L.date.x1, y: L.date.y },
      finder: { x0: L.finder.x0, x1: L.finder.x1, y: L.finder.y },
    };
  }

  global.CardRender = { W, H, LAYOUTS, render, ensureFonts };
})(window);
