// DEFLATE is a complex format; to read this code, you should probably check the RFC first:
// https://tools.ietf.org/html/rfc1951

// Much of the following code is similar to that of UZIP.js:
// https://github.com/photopea/UZIP.js
// Many optimizations have been made, so the bundle size is ultimately smaller but performance is similar.

// Sometimes 0 will appear where -1 would be more appropriate. This is because using a uint
// is better for memory in most engines (I *think*).

// aliases for shorter compressed code (most minifers don't do this)
const u8 = Uint8Array, u16 = Uint16Array, u32 = Uint32Array;

// fixed length extra bits
const fleb = new u8([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, /* unused */ 0, 0, /* impossible */ 0]);

// fixed distance extra bits
// see fleb note
const fdeb = new u8([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, /* unused */ 0, 0]);

// code length index map
const clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

// get base, reverse index map from extra bits
const freb = (eb: Uint8Array, start: number) => {
  const b = new u16(31);
  for (let i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  // numbers here are at max 18 bits
  const r = new u32(b[30]);
  for (let i = 1; i < 30; ++i) {
    for (let j = b[i]; j < b[i + 1]; ++j) {
      r[j] = ((j - b[i]) << 5) | i;
    }
  }
  return [b, r] as const;
}

const [fl, revfl] = freb(fleb, 2);
// we can ignore the fact that the other numbers are wrong; they never happen anyway
fl[28] = 258;
revfl[258] = 28;
const [fd, revfd] = freb(fdeb, 0);

// map of value to reverse (assuming 16 bits)
const rev = new u16(32768);
for (let i = 0; i < 32768; ++i) {
  // reverse table algorithm from UZIP.js
  let x = i;
  x = ((x & 0xaaaaaaaa) >>> 1) | ((x & 0x55555555) << 1);
  x = ((x & 0xcccccccc) >>> 2) | ((x & 0x33333333) << 2);
  x = ((x & 0xf0f0f0f0) >>> 4) | ((x & 0x0f0f0f0f) << 4);
  x = ((x & 0xff00ff00) >>> 8) | ((x & 0x00ff00ff) << 8);
  rev[i] = ((x >>> 16) | (x << 16)) >>> 17;
}

// create huffman tree from u8 "map": index -> code length for code index
// mb (max bits) must be at most 15
// TODO: optimize/split up?
const hMap = ((cd: Uint8Array, mb: number, r: 0 | 1) => {
  const s = cd.length;
  // index
  let i = 0;
  // u8 "map": index -> # of codes with bit length = index
  const l = new u8(mb);
  // length of cd must be 288 (total # of codes)
  for (; i < s; ++i) ++l[cd[i] - 1];
  // u16 "map": index -> minimum code for bit length = index
  const le = new u16(mb);
  for (i = 0; i < mb; ++i) {
    le[i] = (le[i - 1] + l[i - 1]) << 1;
  }
  let co: Uint16Array;
  if (r) {
    co = new u16(s);
    for (i = 0; i < s; ++i) co[i] = rev[le[cd[i] - 1]++] >>> (15 - cd[i]);
  } else {
    // u16 "map": index -> number of actual bits, symbol for code
    co = new u16(1 << mb);
    // bits to remove for reverser
    const rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      // ignore 0 lengths
      if (cd[i]) {
        // num encoding both symbol and bits read
        const sv = (i << 4) | cd[i];
        // free bits
        const r = mb - cd[i];
        // start value
        let v = le[cd[i] - 1]++ << r;
        // m is end value
        for (const m = v | ((1 << r) - 1); v <= m; ++v) {
          // every 16 bit value starting with the code yields the same result
          co[rev[v] >>> rvb] = sv;
        }
      }
    }
  }
  return co;
});

// fixed length tree
const flt = new u8(286);
for (let i = 0; i < 144; ++i) flt[i] = 8;
for (let i = 144; i < 256; ++i) flt[i] = 9;
for (let i = 256; i < 280; ++i) flt[i] = 7;
for (let i = 280; i < 286; ++i) flt[i] = 8;
// fixed distance tree
const fdt = new u8(30);
for (let i = 0; i < 30; ++i) fdt[i] = 5;
// fixed length map
const flm = hMap(flt, 9, 0), flnm = hMap(flt, 9, 1);
// fixed distance map
const fdm = hMap(fdt, 5, 0), fdnm = hMap(fdt, 5, 1);

// find max of array
const max = (a: Uint8Array | number[]) => {
  let m = a[0];
  for (let i = 0; i < a.length; ++i) {
    if (a[i] > m) m = a[i];
  }
  return m;
};

// read d, starting at bit p continuing for l bits
const bits = (d: Uint8Array, p: number, l: number) => {
  const o = p >>> 3;
  return ((d[o] | (d[o + 1] << 8)) >>> (p & 7)) & ((1 << l) - 1);
}

// read d, starting at bit p continuing for at least 16 bits
const bits16 = (d: Uint8Array, p: number) => {
  const o = p >>> 3;
  return ((d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> (p & 7));
}


// expands raw DEFLATE data
const inflate = (dat: Uint8Array, outSize?: number) => {
  let buf = outSize && new u8(outSize);
  // have to estimate size
  const noBuf = !buf;
  // Slightly less than 2x - assumes ~60% compression ratio
  if (noBuf) buf = new u8((dat.length >>> 2) << 3);
  // ensure buffer can fit at least l elements
  const cbuf = (l: number) => {
    let bl = buf.length;
    // need to increase size to fit
    if (l > bl) {
      // Double or set to necessary, whichever is greater
      const nbuf = new u8(Math.max(bl << 1, l));
      nbuf.set(buf);
      buf = nbuf;
    }
  }
  //  last chunk     chunktype literal   dist       lengths    lmask   dmask
  let final = 0, type = 0, hLit = 0, hDist = 0, hcLen = 0, ml = 0, md = 0;
  //  bitpos   bytes
  let pos = 0, bt = 0;
  //  len                dist
  let lm: Uint16Array, dm: Uint16Array;
  while (!final) {
    // BFINAL - this is only 1 when last chunk is next
    final = bits(dat, pos, 1);
    // type: 0 = no compression, 1 = fixed huffman, 2 = dynamic huffman
    type = bits(dat, pos + 1, 2);
    pos += 3;
    if (!type) {
      // go to end of byte boundary
      if (pos & 7) pos += 8 - (pos & 7);
      const s = (pos >>> 3) + 4, l = dat[s - 4] | (dat[s - 3] << 8);
      // ensure size
      if (noBuf) cbuf(bt + l);
      // Copy over uncompressed data
      buf.set(dat.subarray(s, s + l), bt);
      // Get new bitpos, update byte count
      pos = (s + l) << 3, bt += l;
      continue;
    }
    // Make sure the buffer can hold this + the largest possible addition
    // maximum chunk size (practically, theoretically infinite) is 2^17;
    if (noBuf) cbuf(bt + 131072);
    if (type == 1) {
      lm = flm;
      dm = fdm;
      ml = 511;
      md = 31;
    }
    else if (type == 2) {
      hLit = bits(dat, pos, 5) + 257;
      hDist = bits(dat, pos + 5, 5) + 1;
      hcLen = bits(dat, pos + 10, 4) + 4;
      pos += 14;
      // length+distance tree
      const ldt = new u8(hLit + hDist);
      // code length tree
      const clt = new u8(19);
      for (let i = 0; i < hcLen; ++i) {
        // use index map to get real code
        clt[clim[i]] = bits(dat, pos + i * 3, 3);
      }
      pos += hcLen * 3;
      // code lengths bits
      const clb = max(clt);
      // code lengths map
      const clm = hMap(clt, clb, 0);
      for (let i = 0; i < ldt.length;) {
        const r = clm[bits(dat, pos, clb)];
        // bits read
        pos += r & 15;
        // symbol
        const s = r >>> 4;
        // code length to copy
        if (s < 16) {
          ldt[i++] = s;
        } else {
          //  copy   count
          let c = 0, n = 0;
          if (s == 16) n = 3 + bits(dat, pos, 2), pos += 2, c = ldt[i - 1];
          else if (s == 17) n = 3 + bits(dat, pos, 3), pos += 3;
          else if (s == 18) n = 11 + bits(dat, pos, 7), pos += 7;
          while (n--) ldt[i++] = c;
        }
      }
      //    length tree                 distance tree
      const lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
      // max length bits
      const mlb = max(lt)
      // max dist bits
      const mdb = max(dt);
      ml = (1 << mlb) - 1;
      lm = hMap(lt, mlb, 0);
      md = (1 << mdb) - 1;
      dm = hMap(dt, mdb, 0);
    }
    for (;;) {
      // bits read, code
      const c = lm[bits16(dat, pos) & ml];
      pos += c & 15;
      // code
      const sym = c >>> 4;
      if (sym < 256) buf[bt++] = sym;
      else if (sym == 256) break;
      else {
        let end = bt + sym - 254;
        // no extra bits needed if less
        if (sym > 264) {
          // index
          const i = sym - 257;
          end = bt + bits(dat, pos, fleb[i]) + fl[i];
          pos += fleb[i];
        }
        // dist
        const d = dm[bits16(dat, pos) & md];
        pos += d & 15;
        const dsym = d >>> 4;
        let dt = fd[dsym];
        if (dsym > 3) {
          dt += bits16(dat, pos) & ((1 << fdeb[dsym]) - 1);
          pos += fdeb[dsym];
        }
        if (noBuf) cbuf(bt + 131072);
        while (bt < end) {
          buf[bt] = buf[bt++ - dt];
          buf[bt] = buf[bt++ - dt];
          buf[bt] = buf[bt++ - dt];
          buf[bt] = buf[bt++ - dt];
        }
        bt = end;
      }
    }
  }
  return buf.slice(0, bt);
}

// starting at p, write the minimum number of bits that can hold v to ds
const wbits = (d: Uint8Array, p: number, v: number) => {
  v <<= p & 7;
  const o = p >>> 3;
  d[o] |= v;
  d[o + 1] |= v >>> 8;
}

// starting at p, write the minimum number of bits (>8) that can hold v to ds
const wbits16 = (d: Uint8Array, p: number, v: number) => {
  v <<= p & 7;
  const o = p >>> 3;
  d[o] |= v;
  d[o + 1] |= v >>> 8;
  d[o + 2] |= v >>> 16;
}

type HuffNode = {
  // symbol
  s: number;
  // frequency
  f: number;
  // left child
  l?: HuffNode;
  // right child
  r?: HuffNode;
};

// creates code lengths from a frequency table
const hTree = (d: Uint16Array, mb: number) => {
  // Need extra info to make a tree
  const t: HuffNode[] = [];
  for (let i = 0; i < d.length; ++i) {
    if (d[i]) {
      t.push({ s: i, f: d[i] });
    }
  }
  const s = t.length;
  const t2 = t.slice();
  // after i2 reaches last ind, will be stopped
  t.push({ s: -1, f: 32768 });
  if (s == 0) return [new u8(0), 0] as const;
  if (s == 1) return [new u8([!t[0].s as unknown as number]), 1] as const;
  t.sort((a, b) => a.f - b.f);
  let l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  // complex algorithm from UZIP.js
  // i0 is lookbehind, i2 is lookahead - after processing two low-freq
  // symbols that combined have high freq, will start processing i2 (high-freq,
  // non-composite) symbols instead
  // see https://reddit.com/r/photopea/comments/ikekht/uzipjs_questions/
	while (i1 != s - 1) {
    if (t[i0].f < t[i2].f) l = t[i0++];
    else l = t[i2++];
    if (i0 != i1 && t[i0].f < t[i2].f) r = t[i0++];
    else r = t[i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  let maxSym = t2[0].s;
  for (let i = 0; i < s; ++i) {
    if (t2[i].s > maxSym) maxSym = t2[i].s;
  }
  // code lengths
  const tr = new u16(maxSym + 1);
  // max bits in tree
  let mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    // more algorithms from UZIP.js
    // TODO: find out how this code works (debt)
    //  ind    debt
    let i = 0, dt = 0;
    // cost
    const cst = 1 << (mbt - mb);
    t2.sort((a, b) => tr[b.s] - tr[a.s] || a.f - b.f);
    for (; i < s; ++i) {
      const i2 = t2[i].s;
      if (tr[i2] > mb) {
        dt += cst - (1 << (mbt - tr[i2]));
        tr[i2] = mb;
      } else break;
    }
    dt >>>= (mbt - mb);
    while (dt > 0) {
      const i2 = t2[i].s;
      if (tr[i2] < mb) dt -= 1 << (mb - tr[i2]++ - 1);
      else ++i;
    }
    for (; i >= 0 && !dt; --i) {
      const i2 = t2[i].s;
      if (tr[i2] == mb) {
        --tr[i2];
        ++dt;
      }
    }
    mbt = mb;
  }
  return [new u8(tr), mbt] as const;
}
// get the max length and assign length codes
const ln = (n: HuffNode, l: Uint16Array, d: number): number => {
  return n.s == -1
    ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1))
    : (l[n.s] = d);
}

// length codes generation
const lc = (c: Uint8Array) => {
  let s = c.length;
  // Note that the semicolon was intentional
  while (s && !c[--s]);
  ++s;
  const cl = new u16(s);
  //  ind      num      streak
  let cli = 0, cln = c[0], cls = 1;
  const w = (v: number) => { cl[cli++] = v; }
  for (let i = 1; i < s; ++i) {
    if (c[i] == cln && i != s - 1)
      ++cls;
    else {
      if (!cln && cls > 3) {
        for (; cls > 138; cls -= 138) w(4082);
        if (cls > 3) {
          w(cls > 10 ? ((cls - 11) << 5) | 18 : ((cls - 3) << 5) | 17);
          cls = 0;
        }
      } else if (cls > 4) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6) w(112);
        if (cls > 3) w(((cls - 3) << 5) | 16), cls = 0;
      }
      cl.fill(cln, cli, cli += cls);
      cls = 1;
      cln = c[i];
    }
  }
  w(cln);
  return [cl.slice(0, cli), s] as const;
}

// calculate the length of output from tree, code lengths
const clen = (cf: Uint16Array, cl: Uint8Array) => {
  let l = 0;
  for (let i = 0; i < cl.length; ++i) l += cf[i] * cl[i];
  return l;
}

// writes a fixed block
// returns the new bit pos
const wfblk = (out: Uint8Array, pos: number, dat: Uint8Array) => {
  // no need to write 00 as type: TypedArray defaults to 0
  const s = dat.length;
  const o = (pos + 2) >>> 3;
  out[o + 1] = s & 255;
  out[o + 2] = s >>> 8;
  out[o + 3] = out[o + 1] ^ 255;
  out[o + 4] = out[o + 2] ^ 255;
  out.set(dat, o + 5);
  return (o + 4 + s) << 3;
}

// writes a block
const wblk = (dat: Uint8Array, out: Uint8Array, final: number, syms: Uint32Array, lf: Uint16Array, df: Uint16Array, eb: number, li: number, bs: number, bl: number, p: number) => {
  wbits(out, p++, final);
  ++lf[256];
  const [dlt, mlb] = hTree(lf, 15);
  const [ddt, mdb] = hTree(df, 15);
  const [lclt, nlc] = lc(dlt);
  const [lcdt, ndc] = lc(ddt);
  const lcfreq = new u16(19);
  for (let i = 0; i < lclt.length; ++i) lcfreq[lclt[i] & 31]++;
  for (let i = 0; i < lcdt.length; ++i) lcfreq[lcdt[i] & 31]++;
  const [lct, mlcb] = hTree(lcfreq, 7);
  let nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc);
  const flen = (bl + 5) << 3;
  const ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  const dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + (2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18]);
  if (flen < ftlen && flen < dtlen) return wfblk(out, p, dat.subarray(bs, bs + bl));
  let lm: Uint16Array, ll: Uint8Array, dm: Uint16Array, dl: Uint8Array;
  wbits(out, p, 1 + (dtlen < ftlen as unknown as number)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 1), ll = dlt, dm = hMap(ddt, mdb, 1), dl = ddt;
    const llm = hMap(lct, mlcb, 1);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (let i = 0; i < nlcc; ++i) wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    const lcts = [lclt, lcdt];
    for (let it = 0; it < 2; ++it) {
      const clct = lcts[it];
      for (let i = 0; i < clct.length; ++i) {
        const len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15) {
          wbits(out, p, clct[i] >>> 5), p += len == 16 ? 2 : len == 17 ? 3 : 7;
        }
      }
    }
  } else {
    lm = flnm, ll = flt, dm = fdnm, dl = fdt;
  }
  for (let i = 0; i < li; ++i) {
    if (syms[i] > 255) {
      const len = syms[i] & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7) wbits(out, p, (syms[i] >>> 5) & 31), p += fleb[len];
      const dst = (syms[i] >>> 10) & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3) wbits16(out, p, (syms[i] >>> 15) & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[syms[i]]), p += ll[syms[i]];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
}

// deflate options (nice << 13) | chain
const deo = new u32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);

// compresses data into a raw DEFLATE buffer
const deflate = (dat: Uint8Array, lvl: number, pre = 0, post = 0) => {
  const s = dat.length;
  const o = new u8(pre + s + 5 * Math.ceil(s / 16384) + post);
  // writing to this writes to the output buffer
  const w = o.subarray(pre, o.length - post);
  if (!lvl || dat.length < 4) {
    for (let i = 0, pos = 0; i < s; i += 65535) {
      // end
      const e = i + 65535;
      if (e < s) {
        // write full block
        pos = wfblk(w, pos, dat.subarray(i, e));
      } else {
        // write final block
        w[i] = 1;
        wfblk(w, pos, dat.subarray(i, s));
      }
    }
    return o;
  }
  const opt = deo[lvl - 1];
  const n = opt >>> 13, c = opt & 8191;
  //    prev 2-byte val map    curr 2-byte val map
  const prev = new u16(32768), head = new u16(32768);
  // 12288 is an arbitrary choice for max num of symbols per block
  // 112 extra to never need to create a tiny huffman block near the end
  const syms = new u32(12400);
  // length/literal freq   distance freq
  const lf = new u16(286), df = new u16(30);
  // punishment for missing a value
  const pnsh = Math.floor(lvl / 2)
  //  l/lcnt  exbits  index  l/lind  waitdx  bitpos
  let lc = 0, eb = 0, i = 0, li = 0, wi = 0, bs = 0, pos = 0;
  for (; i < s; ++i) {
    // first 2 bytes
    const b2 = dat[i] | (dat[i + 1] << 8);
    // index mod 32768
    let imod = i & 32767;
    // previous index with this value
    let pimod = head[b2];
    prev[imod] = pimod;
    head[b2] = imod;
    // We always should modify head and prev, but only add symbols if
    // this data is not yet processed ("wait" for wait index)
    if (wi <= i) {
      // 24573 arbitrary: 24576 - 3
      if ((li > 12288 || lc > 24573) && s - i > 111) {
        pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
        li = lc = eb = 0, bs = i;
        for (let j = 0; j < 286; ++j) lf[j] = 0;
        for (let j = 0; j < 30; ++j) df[j] = 0;
      }
      // bytes remaining
      const rem = s - i;
      //  len    dist   chain
      let l = 2, d = 0, ch = c, dif = (imod - pimod + 32768) & 32767;
      const maxn = Math.min(n, rem);
      const maxd = Math.min(32767, i);
      // max possible max length
      const ml = Math.min(258, rem);
      while (dif <= maxd && --ch && imod != pimod) {
        if (dat[i + l] == dat[i + l - dif]) {
          let nl = 0;
          // const ml = Math.min(mml, dif);
          for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl);
          if (nl > l) {
            l = nl;
            d = dif;
            // break out early when we reach "nice" (we are satisfied enough)
            if (nl >= maxn) break;
            // now, find the rarest 2-byte sequence within this
            // length of literals and search for that instead.
            // Much faster than just using the start
            const mmd = nl - 2;
            let md = 0;
            for (let j = 0; j < mmd; ++j) {
              const ti = (i - dif + j + 32768) & 32767;
              const pti = prev[ti];
              const cd = (ti - pti + 32768) & 32767;
              if (cd > md) md = cd, pimod = ti;
            }
          } else if (nl < 2) ch >>>= pnsh; // this is cheating, but we need performance :/
        }
        // check the previous match
        imod = pimod, pimod = prev[pimod];
        dif += (imod - pimod + 32768) & 32767;
      }
      // d will be nonzero only when a match was found
      if (d) {
        // store both dist and len data in one Uint32
        // Make sure this is recognized as a len/dist with 28th bit (2^28)
        syms[li++] = 268435456 | (revfd[d] << 10) | revfl[l];
        const lin = revfl[l] & 31, din = revfd[d] & 31;
        eb += fleb[lin] + fdeb[din];
        ++lf[257 + lin];
        ++df[din];
        wi = i + l;
      } else {
        syms[li++] = dat[i];
        ++lf[dat[i]];
      }
      ++lc;
    }
  }
  if (bs != i) pos = wblk(dat, w, 1, syms, lf, df, eb, li, bs, i - bs, pos);
  return o.subarray(0, (pos >>> 3) + 1 + post);
}


export { inflate, deflate };