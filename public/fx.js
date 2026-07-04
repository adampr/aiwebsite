/* xl-dust — ambient drifting light motes (Tron/Dune dust).
   <xl-dust density="40" color="auto"></xl-dust>
   Fills its parent (position it absolutely). Respects prefers-reduced-motion. */
(function () {
  class XLDust extends HTMLElement {
    connectedCallback() {
      if (this._started) return;
      this._started = true;
      this.style.display = 'block';
      this.style.pointerEvents = 'none';
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block';
      this.appendChild(canvas);
      this._canvas = canvas;
      this._ctx = canvas.getContext('2d');
      this._particles = [];
      this._resize = this._resize.bind(this);
      this._tick = this._tick.bind(this);
      this._ro = new ResizeObserver(this._resize);
      this._ro.observe(this);
      this._resize();
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) this._raf = requestAnimationFrame(this._tick);
      else this._drawStatic();
    }
    disconnectedCallback() {
      cancelAnimationFrame(this._raf);
      if (this._ro) this._ro.disconnect();
    }
    _colors() {
      const cs = getComputedStyle(document.documentElement);
      const light = cs.getPropertyValue('--xl-light').trim() || 'rgb(160,215,235)';
      const sand = cs.getPropertyValue('--xl-sand').trim() || 'rgb(215,190,150)';
      return [light, light, light, sand]; // mostly light, occasional sand
    }
    _resize() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const w = this.clientWidth, h = this.clientHeight;
      this._canvas.width = w * dpr;
      this._canvas.height = h * dpr;
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._w = w; this._h = h;
      const density = parseInt(this.getAttribute('density') || '36', 10);
      const n = Math.round(density * (w * h) / (1200 * 600));
      const colors = this._colors();
      while (this._particles.length < n) this._particles.push(this._spawn(colors, true));
      this._particles.length = Math.min(this._particles.length, Math.max(n, 4));
    }
    _spawn(colors, anywhere) {
      return {
        x: Math.random() * this._w,
        y: anywhere ? Math.random() * this._h : this._h + 4,
        r: 0.6 + Math.random() * 1.6,
        vy: -(0.04 + Math.random() * 0.12),
        vx: (Math.random() - 0.5) * 0.06,
        tw: Math.random() * Math.PI * 2,
        tws: 0.004 + Math.random() * 0.01,
        a: 0.15 + Math.random() * 0.45,
        c: colors[(Math.random() * colors.length) | 0]
      };
    }
    _drawStatic() { this._draw(0); }
    _tick() {
      this._draw(1);
      this._raf = requestAnimationFrame(this._tick);
    }
    _draw(dt) {
      const ctx = this._ctx;
      ctx.clearRect(0, 0, this._w, this._h);
      const colors = this._colors();
      for (let i = 0; i < this._particles.length; i++) {
        let p = this._particles[i];
        p.y += p.vy * dt * 2;
        p.x += p.vx * dt * 2;
        p.tw += p.tws;
        if (p.y < -6 || p.x < -6 || p.x > this._w + 6) {
          this._particles[i] = p = this._spawn(colors, false);
        }
        const alpha = p.a * (0.55 + 0.45 * Math.sin(p.tw));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.c;
        ctx.shadowColor = p.c;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
  }
  if (!customElements.get('xl-dust')) customElements.define('xl-dust', XLDust);
})();
