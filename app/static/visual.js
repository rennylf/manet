/* ============ 视觉化渲染:语义 blocks → 1080 宽 SVG ============
 * 设计令牌集中在 VIS;换主题只改令牌与少量版式参数。
 * 版式:概览条 / 分项 / 对比 / 2×2 矩阵 / 流程 / 数字 / 引文 / 结论。
 */
const VIS = {
  W: 1080,
  pad: 90,
  gap: 26,
  serif: `'Songti SC','STSong','Noto Serif CJK SC',serif`,
  sans: `-apple-system,'PingFang SC','Helvetica Neue',sans-serif`,
  c: {
    bg: "#F7F5F0", paper: "#FFFFFF", ink: "#292824",
    sub: "#858176", weak: "#ABA69A",
    accent: "#806B50", accentSoft: "#EFEBE1", border: "#E4E0D7",
    pos: "#6E8B5E", posSoft: "#EFF3EC",
    neg: "#A6503C", negSoft: "#F6EDEA",
    neutralSoft: "#F5F2EA",
  },
};

const _visCanvas = document.createElement("canvas");
const _visCtx = _visCanvas.getContext("2d");

function visEsc(s) {
  return String(s ?? "").replace(/[&<>"]/g,
    ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function visFont(size, family, weight = "400", italic = false) {
  return `${italic ? "italic " : ""}${weight} ${size}px ${family}`;
}
function visWrap(text, maxW, font) {
  text = String(text ?? "").trim();
  if (!text) return [];
  _visCtx.font = font;
  const lines = [];
  let line = "";
  for (const ch of Array.from(text)) {
    if (ch === "\n") { lines.push(line); line = ""; continue; }
    const next = line + ch;
    if (line && _visCtx.measureText(next).width > maxW) {
      const sp = line.lastIndexOf(" ");
      if (/[A-Za-z0-9]/.test(ch) && sp > line.length * 0.55) {
        lines.push(line.slice(0, sp));
        line = line.slice(sp + 1) + ch;
      } else {
        lines.push(line);
        line = ch;
      }
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function visText(lines, x, top, o = {}) {
  const size = o.size || 18, lh = o.lh || Math.round(size * 1.55);
  const attrs = [
    `font-family="${o.family || VIS.sans}"`,
    `font-size="${size}"`,
    `fill="${o.fill || VIS.c.ink}"`,
  ];
  if (o.weight) attrs.push(`font-weight="${o.weight}"`);
  if (o.italic) attrs.push(`font-style="italic"`);
  if (o.ls) attrs.push(`letter-spacing="${o.ls}"`);
  if (o.anchor) attrs.push(`text-anchor="${o.anchor}"`);
  const y0 = top + size * 0.8;
  return `<text ${attrs.join(" ")}>` + lines.map((ln, i) =>
    `<tspan x="${x}" y="${y0 + i * lh}">${visEsc(ln)}</tspan>`).join("") + "</text>";
}
function visCard(x, y, w, h, fill) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ` +
    `fill="${fill || VIS.c.paper}" stroke="${VIS.c.border}"/>`;
}
function visTone(t) {
  if (t === "positive") return { line: VIS.c.pos, soft: VIS.c.posSoft, mark: "✓" };
  if (t === "negative") return { line: VIS.c.neg, soft: VIS.c.negSoft, mark: "✗" };
  return { line: VIS.c.accent, soft: VIS.c.neutralSoft, mark: "·" };
}

/* ---------- 版式块 ---------- */
const VIS_BLOCKS = {
  /* 顶部概览条:2~4 个结论短句 */
  highlights: {
    measure(b, w) {
      const items = b.items || [];
      const gap = 14, cw = (w - gap * (items.length - 1)) / Math.max(1, items.length);
      const font = visFont(18, VIS.sans);
      let lines = 1;
      items.forEach(it => { lines = Math.max(lines, visWrap(it, cw - 32, font).length); });
      return Math.max(62, lines * 28 + 32);
    },
    draw(b, y, w) {
      const items = b.items || [];
      const gap = 14, cw = (w - gap * (items.length - 1)) / Math.max(1, items.length);
      const h = this.measure(b, w);
      return items.map((it, i) => {
        const x = VIS.pad + i * (cw + gap);
        const lines = visWrap(it, cw - 32, visFont(18, VIS.sans));
        const top = y + (h - lines.length * 28) / 2;
        return `<rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="4" ` +
          `fill="${VIS.c.accentSoft}" stroke="${VIS.c.border}"/>` +
          visText(lines, x + cw / 2, top, {
            size: 18, fill: VIS.c.accent, lh: 28, anchor: "middle",
          });
      }).join("");
    },
  },

  /* 分项:每章一张白卡,▎章节标签 + 要点 */
  sections: {
    _sec(b) {
      return (b.items || []).map(s => {
        const label = s.label || "";
        const pts = (s.points || s.items || []).map(p => String(p));
        const padX = 30, padTop = 24;
        const pointW = VIS.W - VIS.pad * 2 - padX * 2 - 24;
        const font = visFont(19.5, VIS.sans);
        const lines = pts.map(p => visWrap(p, pointW, font));
        const bodyH = lines.reduce((a, l) => a + l.length * 31, 0) + Math.max(0, pts.length - 1) * 9;
        return { label, pts, lines, padX, padTop, h: padTop + 24 + 14 + bodyH + 24 };
      });
    },
    measure(b) {
      return this._sec(b).reduce((a, s, i) => a + s.h + (i ? 16 : 0), 0);
    },
    draw(b, y, w) {
      let cy = y, out = "";
      this._sec(b).forEach((s, si) => {
        const x = VIS.pad, cw = w;
        out += visCard(x, cy, cw, s.h);
        out += `<rect x="${x + s.padX}" y="${cy + s.padTop}" width="4" height="20" rx="1" fill="${VIS.c.accent}"/>`;
        out += visText([s.label], x + s.padX + 16, cy + s.padTop - 1, {
          size: 20, fill: VIS.c.accent, ls: 4,
        });
        let py = cy + s.padTop + 24 + 14;
        s.pts.forEach((p, pi) => {
          out += `<rect x="${x + s.padX + 4}" y="${py + 9}" width="4" height="4" rx="1" fill="${VIS.c.accent}"/>`;
          out += visText(s.lines[pi], x + s.padX + 20, py, { size: 19.5, lh: 31, fill: VIS.c.ink });
          py += s.lines[pi].length * 31 + 9;
        });
        cy += s.h + 16;
      });
      return out;
    },
  },

  /* 对比:左右两栏,绿=正向、砖红=负向 */
  compare: {
    _sides(b, w) {
      const gap = 30, cw = (w - gap) / 2, pad = 20;
      const inner = cw - pad * 2;
      return [b.left, b.right].map(side => {
        const t = visTone(side.tone);
        const font = visFont(18, VIS.sans);
        const lines = (side.items || []).map(it => visWrap(`${t.mark} ${it}`, inner, font));
        const bodyH = lines.reduce((a, l) => a + l.length * 28, 0) +
          Math.max(0, lines.length - 1) * 7;
        return { side, t, lines, pad, cw, h: pad * 2 + 26 + 12 + bodyH };
      });
    },
    measure(b, w) {
      return Math.max(...this._sides(b, w).map(s => s.h));
    },
    draw(b, y, w) {
      const gap = 30, cw = (w - gap) / 2;
      const sides = this._sides(b, w);
      const h = Math.max(...sides.map(s => s.h));
      return sides.map((s, i) => {
        const x = VIS.pad + i * (cw + gap);
        let out = `<rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="4" ` +
          `fill="${s.t.soft}" stroke="${VIS.c.border}"/>` +
          `<rect x="${x}" y="${y}" width="${cw}" height="3" rx="1.5" fill="${s.t.line}"/>`;
        out += visText([s.side.label], x + s.pad, y + s.pad, {
          size: 20, fill: s.t.line, weight: "700", ls: 2,
        });
        let py = y + s.pad + 26 + 12;
        s.lines.forEach(lines => {
          out += visText(lines, x + s.pad, py, { size: 18, fill: s.t.line, lh: 28 });
          py += lines.length * 28 + 7;
        });
        return out;
      }).join("");
    },
  },

  /* 2×2 矩阵 */
  matrix: {
    _geo(b, w) {
      const axis = 58, gap = 10, cw = (w - axis - gap * 2) / 2;
      const pad = 16;
      const cells = (b.cells || []).slice(0, 4);
      const rowH = [0, 0];
      const info = cells.map((c, i) => {
        const row = Math.floor(i / 2);
        const title = visWrap(c.title || "", cw - pad * 2, visFont(18, VIS.sans, "700"));
        const desc = visWrap(c.desc || "", cw - pad * 2, visFont(15.5, VIS.sans));
        const action = visWrap(c.action || "", cw - pad * 2, visFont(14.5, VIS.sans));
        const h = pad * 2 + title.length * 25 +
          (desc.length ? 6 + desc.length * 22 : 0) +
          (action.length ? 8 + action.length * 20 : 0);
        rowH[row] = Math.max(rowH[row], h);
        return { c, title, desc, action };
      });
      return { axis, gap, cw, pad, rowH, info };
    },
    measure(b, w) {
      const g = this._geo(b, w);
      return 26 + g.rowH[0] + 10 + g.rowH[1] + 10;
    },
    draw(b, y, w) {
      const g = this._geo(b, w);
      const { axis, gap, cw, pad } = g;
      const x0 = VIS.pad + axis + gap;
      const out = [];
      out.push(visText([b.x?.label || ""], VIS.pad, y, { size: 11, fill: VIS.c.weak }));
      out.push(visText([b.x?.low || ""], x0 + cw / 2, y, {
        size: 11, fill: VIS.c.weak, anchor: "middle",
      }));
      out.push(visText([b.x?.high || ""], x0 + cw + gap + cw / 2, y, {
        size: 11, fill: VIS.c.weak, anchor: "middle",
      }));
      let cy = y + 26;
      g.rowH.forEach((rh, row) => {
        out.push(visText([row === 0 ? (b.y?.high || "") : (b.y?.low || "")],
          VIS.pad + axis / 2, cy + rh / 2 - 8, {
            size: 11, fill: VIS.c.weak, anchor: "middle",
          }));
        for (let col = 0; col < 2; col++) {
          const idx = row * 2 + col;
          const it = g.info[idx];
          if (!it) continue;
          const x = x0 + col * (cw + gap);
          const t = visTone(it.c.tone);
          out.push(`<rect x="${x}" y="${cy}" width="${cw}" height="${rh}" rx="4" ` +
            `fill="${t.soft}" stroke="${VIS.c.border}"/>`);
          out.push(visText(it.title, x + pad, cy + pad, {
            size: 18, weight: "700", fill: t.line,
          }));
          let py = cy + pad + it.title.length * 25 + 6;
          if (it.desc.length) {
            out.push(visText(it.desc, x + pad, py, { size: 15.5, fill: VIS.c.sub, lh: 22 }));
            py += it.desc.length * 22 + 8;
          }
          if (it.action.length) {
            out.push(visText(it.action, x + pad, py, { size: 14.5, fill: VIS.c.weak, lh: 20 }));
          }
        }
        cy += rh + 10;
      });
      if (b.y?.label) {
        const ty = y + 26 + (g.rowH[0] + 10 + g.rowH[1]) / 2;
        out.push(`<text transform="translate(${VIS.pad + 10},${ty}) rotate(-90)" ` +
          `font-family="${VIS.sans}" font-size="11" fill="${VIS.c.weak}" ` +
          `text-anchor="middle">${visEsc(b.y.label)}</text>`);
      }
      return out.join("");
    },
  },

  /* 流程:带编号的步骤卡 */
  process: {
    _geo(b, w) {
      const steps = (b.steps || []).slice(0, 4), gap = 36;
      const cw = (w - gap * (steps.length - 1)) / Math.max(1, steps.length);
      const pad = 18;
      const info = steps.map(st => {
        const label = visWrap(st.label || "", cw - pad * 2, visFont(18.5, VIS.sans, "700"));
        const desc = visWrap(st.desc || "", cw - pad * 2, visFont(15.5, VIS.sans));
        const h = pad * 2 + 24 + 10 + label.length * 24 +
          (desc.length ? 8 + desc.length * 22 : 0);
        return { st, label, desc, h };
      });
      return { cw, gap, pad, info, h: Math.max(...info.map(i => i.h)) };
    },
    measure(b, w) { return this._geo(b, w).h; },
    draw(b, y, w) {
      const g = this._geo(b, w);
      return g.info.map((it, i) => {
        const x = VIS.pad + i * (g.cw + g.gap);
        let out = visCard(x, y, g.cw, g.h);
        out += `<rect x="${x + g.pad}" y="${y + g.pad}" width="24" height="24" rx="3" fill="${VIS.c.accent}"/>`;
        out += visText([String(i + 1)], x + g.pad + 12, y + g.pad + 3, {
          size: 12, fill: VIS.c.paper, weight: "700", anchor: "middle",
        });
        out += visText(it.label, x + g.pad, y + g.pad + 24 + 10, {
          size: 18.5, weight: "700", fill: VIS.c.ink, lh: 24,
        });
        if (it.desc.length) {
          out += visText(it.desc, x + g.pad, y + g.pad + 24 + 10 + it.label.length * 24 + 8, {
            size: 15.5, fill: VIS.c.sub, lh: 22,
          });
        }
        if (i < g.info.length - 1) {
          out += visText(["▸"], x + g.cw + g.gap / 2, y + g.h / 2 - 12, {
            size: 20, fill: VIS.c.weak, anchor: "middle",
          });
        }
        return out;
      }).join("");
    },
  },

  /* 关键数字:值较长时自动改用 2 列 × 2 行,避免挤压与溢出 */
  stats: {
    _geo(b, w) {
      const items = (b.items || []).slice(0, 4), gap = 28;
      const long = items.some(it => String(it.value || "").length > 7);
      const cols = items.length <= 2 ? Math.max(1, items.length)
        : (long ? 2 : Math.min(3, items.length));
      const cw = (w - gap * (cols - 1)) / cols;
      const maxW = cw - 12;
      const info = items.map(it => {
        const value = String(it.value || "");
        let vs = 40;
        _visCtx.font = visFont(vs, VIS.serif, "700");
        while (vs > 24 && _visCtx.measureText(value).width > maxW) {
          vs -= 4;
          _visCtx.font = visFont(vs, VIS.serif, "700");
        }
        const vlines = visWrap(value, maxW, visFont(vs, VIS.serif, "700")).slice(0, 2);
        const label = visWrap(it.label || "", maxW, visFont(15, VIS.sans));
        const vh = vlines.length * Math.round(vs * 1.12);
        return { it, vlines, vs, label, vh, h: vh + 10 + label.length * 21 };
      });
      const rowH = [];
      info.forEach((it, i) => {
        const r = Math.floor(i / cols);
        rowH[r] = Math.max(rowH[r] || 0, it.h);
      });
      const totalH = rowH.reduce((a, h) => a + h, 0) + Math.max(0, rowH.length - 1) * 22;
      return { cw, gap, cols, info, rowH, h: totalH + 14 };
    },
    measure(b, w) { return this._geo(b, w).h; },
    draw(b, y, w) {
      const g = this._geo(b, w);
      let out = "", cy = y;
      g.rowH.forEach((rh, r) => {
        for (let c = 0; c < g.cols; c++) {
          const it = g.info[r * g.cols + c];
          if (!it) continue;
          const x = VIS.pad + c * (g.cw + g.gap);
          out += visText(it.vlines, x, cy, {
            size: it.vs, family: VIS.serif, weight: "700", fill: VIS.c.accent,
            lh: Math.round(it.vs * 1.12),
          });
          out += visText(it.label, x, cy + it.vh + 10, {
            size: 15, fill: VIS.c.sub, lh: 21,
          });
        }
        cy += rh + 22;
      });
      return out;
    },
  },

  /* 引文 */
  quote: {
    _geo(b, w) {
      const textW = w - 52;
      const lines = visWrap(b.text || "", textW, visFont(24, VIS.serif, "400", true));
      const src = b.source ? visWrap(b.source, textW, visFont(15, VIS.sans)) : [];
      return { lines, src, h: 10 + lines.length * 36 + (src.length ? 10 + src.length * 20 : 0) + 8 };
    },
    measure(b, w) { return this._geo(b, w).h; },
    draw(b, y, w) {
      const g = this._geo(b, w);
      let out = `<rect x="${VIS.pad}" y="${y}" width="3" height="${g.h - 8}" rx="1.5" fill="${VIS.c.accent}"/>`;
      out += visText(g.lines, VIS.pad + 28, y + 2, {
        size: 24, family: VIS.serif, italic: true, fill: VIS.c.ink, lh: 36,
      });
      if (g.src.length) {
        out += visText(g.src, VIS.pad + 28, y + 2 + g.lines.length * 36 + 10, {
          size: 15, fill: VIS.c.weak,
        });
      }
      return out;
    },
  },

  /* 结论 callout */
  takeaway: {
    _geo(b, w) {
      const textW = w - 56;
      const lines = visWrap(b.text || "", textW, visFont(20, VIS.serif));
      return { lines, h: 24 + 20 + 10 + lines.length * 32 + 24 };
    },
    measure(b, w) { return this._geo(b, w).h; },
    draw(b, y, w) {
      const g = this._geo(b, w);
      let out = `<rect x="${VIS.pad}" y="${y}" width="${w}" height="${g.h}" rx="3" ` +
        `fill="${VIS.c.accentSoft}" stroke="${VIS.c.border}"/>` +
        `<rect x="${VIS.pad}" y="${y}" width="3" height="${g.h}" rx="1.5" fill="${VIS.c.accent}"/>`;
      out += visText([b.title || "结论"], VIS.pad + 28, y + 22, {
        size: 13, fill: VIS.c.accent, ls: 3,
      });
      out += visText(g.lines, VIS.pad + 28, y + 24 + 20 + 10, {
        size: 20, family: VIS.serif, fill: VIS.c.ink, lh: 32,
      });
      return out;
    },
  },
};

/* ---------- 兼容旧格式 & 兜底 ---------- */
function visNormalize(spec) {
  spec = spec || {};
  let blocks = Array.isArray(spec.blocks) ? spec.blocks.filter(b => b && VIS_BLOCKS[b.type]) : [];
  if (!blocks.length && Array.isArray(spec.sections)) {
    blocks = [{ type: "sections", items: spec.sections }];
  }
  return {
    title: spec.title || "视觉化",
    kicker: spec.kicker || "",
    footer: spec.footer || "",
    blocks,
  };
}

/* ---------- 组合成一张卡片 ---------- */
function visualSVG(spec) {
  spec = visNormalize(spec);
  const { c: C, W, pad } = VIS;
  const inner = W - pad * 2;

  const titleLines = visWrap(spec.title, inner, visFont(46, VIS.serif, "700")).slice(0, 2);
  const kickerLines = spec.kicker
    ? visWrap(spec.kicker, inner, visFont(20, VIS.sans)).slice(0, 2) : [];

  let y = 150;
  let head = "";
  // 品牌标记 + 字标
  head += `<g fill="none" stroke="${C.accent}" stroke-width="1.5" stroke-linecap="round" ` +
    `transform="translate(${pad},62) scale(1.5)">` +
    `<path d="M8 11.5a4 4 0 0 1 8 0"/><path d="M3 15.5q2.25 -3 4.5 0t4.5 0t4.5 0t4.5 0"/></g>`;
  head += visText(["Manet"], pad + 46, 66, {
    size: 24, family: VIS.serif, fill: C.ink, ls: 3,
  });
  head += visText(["VISUALISATION"], W - pad, 64, {
    size: 15, fill: C.weak, ls: 3, anchor: "end",
  });

  head += visText(titleLines, pad, y, {
    size: 46, family: VIS.serif, weight: "700", fill: C.ink, lh: 60,
  });
  y += titleLines.length * 60;
  if (kickerLines.length) {
    head += visText(kickerLines, pad, y + 4, {
      size: 20, fill: C.sub, lh: 30,
    });
    y += 4 + kickerLines.length * 30;
  }
  const ruleY = y + 18;
  head += `<line x1="${pad}" y1="${ruleY}" x2="${W - pad}" y2="${ruleY}" stroke="${C.ink}" stroke-width="1"/>`;

  let cursor = ruleY + 30;
  const body = [];
  spec.blocks.forEach(b => {
    const h = VIS_BLOCKS[b.type].measure(b, inner);
    body.push(VIS_BLOCKS[b.type].draw(b, cursor, inner));
    cursor += h + VIS.gap;
  });
  const lastBottom = spec.blocks.length ? cursor - VIS.gap : ruleY + 10;

  const footLines = spec.footer
    ? visWrap(spec.footer, inner - 280, visFont(18, VIS.serif, "400", true)).slice(0, 2) : [];
  const footTop = lastBottom + 34;
  const H = footTop + Math.max(footLines.length * 28, 20) + 64;

  let foot = "";
  if (footLines.length) {
    foot += visText(footLines, pad, footTop, {
      size: 18, family: VIS.serif, italic: true, fill: C.sub, lh: 28,
    });
  }
  foot += visText(["QUOD MANET, MANET."], W - pad, footTop + 2, {
    size: 13, fill: C.weak, ls: 2, anchor: "end",
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
    `width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>` +
    head + body.join("") + foot + `</svg>`;
}
