// Контейнер 1С:Предприятие 8 (.epf/.cf): чтение и запись (формат как у v8unpack).
const zlib = require('zlib');

const END32 = 0x7fffffff;

function detect(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === END32) return 32;
  if (buf.length >= 8 && buf.readBigUInt64LE(0) === 0xffffffffffffffffn) return 64;
  return 0;
}

function readChain(buf, addr, fmt) {
  const hexLen = fmt === 32 ? 8 : 16;
  const hdrLen = 2 + 3 * (hexLen + 1) + 2;
  let out = [];
  let total = null;
  let got = 0;
  let cur = addr;
  const endMark = fmt === 32 ? END32 : Number.MAX_SAFE_INTEGER;
  while (true) {
    const h = buf.toString('latin1', cur, cur + hdrLen);
    if (h.slice(0, 2) !== '\r\n') throw new Error('плохой заголовок блока @' + cur + ': ' + JSON.stringify(h));
    const p = h.slice(2).split(' ');
    const docLen = parseInt(p[0], 16), blockLen = parseInt(p[1], 16);
    const nextRaw = p[2];
    const next = /^f+$/i.test(nextRaw) || parseInt(nextRaw, 16) === END32 ? -1 : parseInt(nextRaw, 16);
    if (total == null) total = docLen;
    const take = Math.min(blockLen, total - got);
    out.push(buf.subarray(cur + hdrLen, cur + hdrLen + take));
    got += take;
    if (got >= total || next < 0) break;
    cur = next;
  }
  void endMark;
  return Buffer.concat(out);
}

function parse(buf) {
  const fmt = detect(buf);
  if (!fmt) throw new Error('не контейнер');
  const fhLen = fmt === 32 ? 16 : 20;
  const pageSize = fmt === 32 ? buf.readUInt32LE(4) : buf.readUInt32LE(8);
  const toc = readChain(buf, fhLen, fmt);
  const entrySize = fmt === 32 ? 12 : 24;
  const files = [];
  for (let i = 0; i + entrySize <= toc.length; i += entrySize) {
    const ha = fmt === 32 ? toc.readUInt32LE(i) : Number(toc.readBigUInt64LE(i));
    const da = fmt === 32 ? toc.readUInt32LE(i + 4) : Number(toc.readBigUInt64LE(i + 8));
    const header = readChain(buf, ha, fmt);
    const data = readChain(buf, da, fmt);
    const nameBuf = header.subarray(20);
    let name = nameBuf.toString('utf16le');
    name = name.replace(/\u0000+$/, '');
    files.push({ name, header, data });
  }
  return { fmt, pageSize, header: buf.subarray(0, fhLen), files };
}

function blockHeader(fmt, docLen, blockLen, next) {
  const w = fmt === 32 ? 8 : 16;
  const hx = (n) => n.toString(16).padStart(w, '0');
  const nx = next < 0 ? (fmt === 32 ? '7fffffff' : 'f'.repeat(16)) : hx(next);
  return Buffer.from(`\r\n${hx(docLen)} ${hx(blockLen)} ${nx} \r\n`, 'latin1');
}

// Каждый документ — один блок (как v8unpack: данные — не меньше страницы, заголовок — впритык).
function build(c, opts = {}) {
  const fmt = c.fmt;
  const page = c.pageSize || 512;
  const fhLen = fmt === 32 ? 16 : 20;
  const hdrLen = fmt === 32 ? 31 : 55;
  const entrySize = fmt === 32 ? 12 : 24;
  const tocLen = c.files.length * entrySize;
  const tocBlock = opts.tocPad === false ? tocLen : Math.max(tocLen, page);
  let addr = fhLen + hdrLen + tocBlock;
  const parts = [];
  const toc = Buffer.alloc(tocLen);
  const body = [];
  c.files.forEach((f, i) => {
    const ha = addr;
    body.push(blockHeader(fmt, f.header.length, f.header.length, -1), f.header);
    addr += hdrLen + f.header.length;
    const da = addr;
    const bl = Math.max(f.data.length, page);
    const pad = Buffer.alloc(bl - f.data.length);
    body.push(blockHeader(fmt, f.data.length, bl, -1), f.data, pad);
    addr += hdrLen + bl;
    if (fmt === 32) {
      toc.writeUInt32LE(ha, i * 12); toc.writeUInt32LE(da, i * 12 + 4); toc.writeUInt32LE(END32, i * 12 + 8);
    } else {
      toc.writeBigUInt64LE(BigInt(ha), i * 24); toc.writeBigUInt64LE(BigInt(da), i * 24 + 8); toc.writeBigUInt64LE(0xffffffffffffffffn, i * 24 + 16);
    }
  });
  parts.push(c.header, blockHeader(fmt, tocLen, tocBlock, -1), toc, Buffer.alloc(tocBlock - tocLen), ...body);
  return Buffer.concat(parts);
}

function inflate(b) { return zlib.inflateRawSync(b); }
function deflate(b) { return zlib.deflateRawSync(b, { level: 9 }); }

module.exports = { detect, parse, build, inflate, deflate };
