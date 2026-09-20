/**
 * A-1036 守卫：旧版 Office（OLE2 / CFB）真解析。
 *
 * 用**手工拼的最小 CFB**当夹具（不依赖用户机器上的真实文档）：
 * 把 "PowerPoint Document" 流做成 >4096 字节，从而走普通 FAT 链而不是 mini stream
 * —— 一次覆盖「头解析 / FAT 链 / 目录项 / 流读取 / 文本原子抽取」全链路。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isOle2, openCfb } from "../../core-ts/src/cfb.js";
import { extractOleText, oleKindFromExt, legacyBinaryName } from "../../core-ts/src/doc_text.js";

const ROOT = resolve(__dirname, "../..");
const SECTOR = 512;

/** 拼一个只含单条流的 CFB（流大小 ≥ 4096 → 普通 FAT 链） */
function buildCfb(streamName: string, streamData: Buffer): Buffer {
  const dataSectors = Math.ceil(streamData.length / SECTOR);
  const totalSectors = 1 + 1 + dataSectors;          // FAT + 目录 + 数据
  const buf = Buffer.alloc((totalSectors + 1) * SECTOR, 0);

  // ── 头（512B）──
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  buf.writeUInt16LE(0x003e, 24);                     // minor
  buf.writeUInt16LE(0x0003, 26);                     // major
  buf.writeUInt16LE(0xfffe, 28);                     // byte order
  buf.writeUInt16LE(9, 30);                          // sector shift → 512
  buf.writeUInt16LE(6, 32);                          // mini sector shift → 64
  buf.writeUInt32LE(1, 44);                          // FAT 扇区数
  buf.writeUInt32LE(1, 48);                          // 首个目录扇区
  buf.writeUInt32LE(4096, 56);                       // mini cutoff
  buf.writeUInt32LE(0xfffffffe, 60);                 // 首个 miniFAT = ENDOFCHAIN
  buf.writeUInt32LE(0, 64);                          // miniFAT 数
  buf.writeUInt32LE(0xfffffffe, 68);                 // 首个 DIFAT = ENDOFCHAIN
  buf.writeUInt32LE(0, 72);
  buf.writeUInt32LE(0, 76);                          // DIFAT[0] = 扇区 0（FAT 自己）

  const sectorOff = (n: number): number => (n + 1) * SECTOR;

  // ── FAT（扇区 0）──
  const fat = sectorOff(0);
  buf.writeUInt32LE(0xfffffffd, fat + 0 * 4);        // 扇区 0 = FATSECT
  buf.writeUInt32LE(0xfffffffe, fat + 1 * 4);        // 扇区 1 = 目录，链尾
  for (let i = 0; i < dataSectors; i += 1) {
    const next = i === dataSectors - 1 ? 0xfffffffe : 2 + i + 1;
    buf.writeUInt32LE(next, fat + (2 + i) * 4);
  }
  for (let i = 2 + dataSectors; i < SECTOR / 4; i += 1) { buf.writeUInt32LE(0xffffffff, fat + i * 4); }

  // ── 目录（扇区 1）：根 + 一条流 ──
  const dir = sectorOff(1);
  const writeEntry = (off: number, name: string, type: number, start: number, size: number): void => {
    const nameBuf = Buffer.from(`${name}\0`, "utf16le");
    nameBuf.copy(buf, off);
    buf.writeUInt16LE(nameBuf.length, off + 64);
    buf[off + 66] = type;
    buf[off + 67] = 1;                               // color
    buf.writeUInt32LE(0xffffffff, off + 68);         // left
    buf.writeUInt32LE(0xffffffff, off + 72);         // right
    buf.writeUInt32LE(0xffffffff, off + 76);         // child
    buf.writeUInt32LE(start >>> 0, off + 116);
    buf.writeBigUInt64LE(BigInt(size) & 0xffffffffn, off + 120);
  };
  writeEntry(dir, "Root Entry", 5, 0xfffffffe, 0);
  writeEntry(dir + 128, streamName, 2, 2, streamData.length);

  // ── 数据（扇区 2 起）──
  streamData.copy(buf, sectorOff(2));
  return buf;
}

/** PPT 记录：recVer(2) + recType(2) + recLen(4) + 数据 */
function pptRecord(type: number, payload: Buffer, ver = 0): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(ver, 0);
  head.writeUInt16LE(type, 2);
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

describe("A-1036 ① CFB 容器读取", () => {
  it("认得 OLE2 签名；非 OLE2 输入不误判", () => {
    const cfb = buildCfb("Test", Buffer.alloc(5000));
    expect(isOle2(cfb)).toBe(true);
    expect(isOle2(Buffer.from("PK\x03\x04不是OLE2"))).toBe(false);
    expect(isOle2(Buffer.alloc(4))).toBe(false);
  });

  it("能列出流并读出正确字节（走普通 FAT 链）", () => {
    const payload = Buffer.alloc(5000, 0x41);        // >4096 → 不进 mini stream
    const cfb = buildCfb("PowerPoint Document", payload);
    const f = openCfb(cfb);
    const streams = f.listStreams();
    expect(streams.map((s) => s.name)).toContain("PowerPoint Document");
    expect(streams.find((s) => s.name === "PowerPoint Document")?.size).toBe(5000);
    const read = f.readStream("PowerPoint Document");
    expect(read?.length).toBe(5000);
    expect(read?.[4999]).toBe(0x41);
  });

  it("流名大小写不敏感；读不到的流返回 null（不抛、不返回半截）", () => {
    const f = openCfb(buildCfb("Workbook", Buffer.alloc(4500, 1)));
    expect(f.readStream("workbook")?.length).toBe(4500);
    expect(f.readStream("不存在的流")).toBeNull();
  });

  it("非 OLE2 输入 → 明确抛错", () => {
    expect(() => openCfb(Buffer.from("这不是 OLE2"))).toThrow(/不是 OLE2/);
  });
});

describe("A-1036 ② 旧版格式文本抽取（.ppt 文本原子）", () => {
  it("从合成 CFB 里抽出 TextCharsAtom 的文字", () => {
    const text = "第一页标题\u000d正文一句话";
    const atom = pptRecord(0x0fa0, Buffer.from(text, "utf16le"));
    // ⚠️ 必须把整个流撑到 >4096：CFB 规定小于 miniCutoff 的流存在 **mini stream** 里，
    // 而本夹具只造了普通 FAT 链（没造 mini stream）→ 太短会读到空。
    const pad = pptRecord(0x0fa8, Buffer.from("padding".repeat(900), "latin1"));
    const cfb = buildCfb("PowerPoint Document", Buffer.concat([atom, pad]));
    expect(cfb.length).toBeGreaterThan(4096);
    const r = extractOleText(cfb, "ppt");
    expect(r.text).toContain("第一页标题");
    expect(r.text).toContain("正文一句话");
    expect(r.info.join()).toContain("ppt");
  });

  it("容器记录（recVer=0xF）必须下钻而不是整体跳过", () => {
    // 把原子包在 Document 容器里：容器 recLen 覆盖子记录 —— 若实现把容器整块跳过，
    // 就一个文本块都抽不到（这正是实测踩到的 bug，故用夹具钉死）。
    const inner = pptRecord(0x0fa0, Buffer.from("容器内的文字", "utf16le"));
    const container = pptRecord(0x03e8, inner, 0x0f);
    const pad = pptRecord(0x0fa8, Buffer.from("x".repeat(5000), "latin1"));
    const r = extractOleText(buildCfb("PowerPoint Document", Buffer.concat([container, pad])), "ppt");
    expect(r.text).toContain("容器内的文字");
  });

  it("缺关键流 / 非 OLE2 → 明确报错（不吐乱码）", () => {
    expect(() => extractOleText(buildCfb("Workbook", Buffer.alloc(5000)), "ppt"))
      .toThrow(/缺少 PowerPoint Document 流/);
    expect(() => extractOleText(Buffer.from("naive"), "doc")).toThrow(/不是 OLE2/);
  });
});

describe("A-1036 ③ 路由与格式判定", () => {
  it("扩展名 → 解析种类", () => {
    expect(oleKindFromExt(".DOC")).toBe("doc");
    expect(oleKindFromExt(".xls")).toBe("xls");
    expect(oleKindFromExt(".PPT")).toBe("ppt");
    expect(oleKindFromExt(".docx")).toBeNull();
    expect(oleKindFromExt(".txt")).toBeNull();
  });

  it("旧版格式的可读名仍在（错误信息里要说得清是什么格式）", () => {
    expect(legacyBinaryName(".doc")).toBe("Word 97-2003");
    expect(legacyBinaryName(".xls")).toBe("Excel 97-2003");
    expect(legacyBinaryName(".ppt")).toBe("PowerPoint 97-2003");
  });

  it("file_read 真的接了旧版解析（不再只是报「暂不支持」）", () => {
    const src = readFileSync(join(ROOT, "core-ts/src/tools/builtin.ts"), "utf8");
    expect(src).toMatch(/extractOleText\(await readFile\(p\), oleKind\)/);
    expect(src).toMatch(/oleKindFromExt\(ext\)/);
    // 反向承诺：旧的"直接拒绝"分支必须消失
    expect(src.includes("暂不支持 ${legacy} 二进制格式")).toBe(false);
  });

  it("[反例] 上一条正则必须能抓到没接线的写法（守卫自检）", () => {
    const bad = 'return `[错误] 暂不支持 ${legacy} 二进制格式（${ext}）`;';
    expect(/extractOleText\(await readFile\(p\), oleKind\)/.test(bad)).toBe(false);
  });
});

describe("A-1036 ④ .xls 单元格网格（BIFF8：标签 + 数字 + 表名）", () => {
  /** BIFF 记录：type(2) + len(2) + data */
  const biff = (type: number, payload: Buffer): Buffer => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0);
    h.writeUInt16LE(payload.length, 2);
    return Buffer.concat([h, payload]);
  };
  /** SST（共享字符串表）：cstTotal + cstUnique + 每条 cch/grbit/字符
   *  ⚠️ grbit 位 0 = 16 位字符。**非 ASCII 必须置位**，否则读回来是乱码
   *  （真写入器就是这么做的）。 */
  const sstRec = (strings: string[]): Buffer => {
    const parts: Buffer[] = [Buffer.alloc(8)];
    parts[0].writeUInt32LE(strings.length, 0);
    parts[0].writeUInt32LE(strings.length, 4);
    for (const s of strings) {
      const wide = /[^\x00-\x7f]/.test(s);
      const b = wide ? Buffer.from(s, "utf16le") : Buffer.from(s, "latin1");
      const h = Buffer.alloc(3);
      h.writeUInt16LE(s.length, 0);
      h[2] = wide ? 0x01 : 0;
      parts.push(h, b);
    }
    return biff(0x00fc, Buffer.concat(parts));
  };
  /** BOUNDSHEET：lbPlyPos(4) + grbit(2) + cch(1) + nameGrbit(1) + 名字
   *  ⚠️ nameGrbit 位 0 = 名字是 16 位字符。**非 ASCII 必须走 16 位** ——
   *  真实 .xls 的日文表名（作業リスト）就是靠这个标志解出来的；夹具里用 latin1 写中文会得到乱码。 */
  const boundsheet = (name: string, pos: number): Buffer => {
    const wide = /[^\x00-\x7f]/.test(name);
    const nb = wide ? Buffer.from(name, "utf16le") : Buffer.from(name, "latin1");
    const p = Buffer.alloc(8);
    p.writeUInt32LE(pos, 0);
    p.writeUInt16LE(0, 4);
    p[6] = wide ? name.length : nb.length;
    p[7] = wide ? 1 : 0;
    return biff(0x0085, Buffer.concat([p, nb]));
  };
  /** 单元格记录（row/col/xf 都在前 6 字节） */
  const cellHead = (row: number, col: number): Buffer => {
    const b = Buffer.alloc(6);
    b.writeUInt16LE(row, 0);
    b.writeUInt16LE(col, 2);
    return b;
  };
  const labelSst = (row: number, col: number, isst: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(isst, 0);
    return biff(0x00fd, Buffer.concat([cellHead(row, col), b]));
  };
  const numberCell = (row: number, col: number, v: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v, 0);
    return biff(0x0203, Buffer.concat([cellHead(row, col), b]));
  };
  /** RK 整数编码：位 1 = 整数，位 0 = 除以 100 */
  const rkCell = (row: number, col: number, v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE((v << 2) | 0x02, 0);
    return biff(0x027e, Buffer.concat([cellHead(row, col), b]));
  };

  function buildXls(): Buffer {
    // 全局区：BOF + BOUNDSHEET(pos=0，单表场景下等价"从流首开始") + SST + EOF
    const globals = Buffer.concat([
      biff(0x0809, Buffer.alloc(4)),
      boundsheet("数据表", 0),
      sstRec(["名称", "数量", "苹果"]),
      biff(0x000a, Buffer.alloc(0)),
    ]);
    // 表数据区
    const sheet = Buffer.concat([
      biff(0x0809, Buffer.alloc(4)),
      labelSst(0, 0, 0),          // A1 = 名称
      labelSst(0, 1, 1),          // B1 = 数量
      labelSst(1, 0, 2),          // A2 = 苹果
      numberCell(1, 1, 10.52),    // B2 = 10.52（NUMBER）
      rkCell(2, 1, 42),           // B3 = 42（RK 整数编码）
      biff(0x000a, Buffer.alloc(0)),
    ]);
    return buildCfb("Workbook", Buffer.concat([globals, sheet, Buffer.alloc(6000)]));
  }

  it("抽出的网格含表名、行标签与**数值**（数值此前完全拿不到）", () => {
    const r = extractOleText(buildXls(), "xls");
    expect(r.info.join()).toContain("数据表");
    expect(r.text).toContain("## 表：数据表");
    expect(r.text).toContain("名称");
    expect(r.text).toContain("苹果");
    // 关键：NUMBER 与 RK 两条路径都要出数（只抽 SST 的话这两格是空的）
    expect(r.text, "NUMBER 单元格必须解出").toContain("10.52");
    expect(r.text, "RK 单元格必须解出").toContain("42");
    // 列头与行号让模型能定位
    expect(r.text).toContain("A | B");
    expect(r.text).toMatch(/\n1\t/);
  });

  it("RK 编码：整数位与除 100 位都要正确", () => {
    const rk = (v: number): number => (v << 2) | 0x02;
    expect(rk(42)).toBe(170);
    // 除 100 的情形：(1052<<2)|0x03 → 10.52
    const p = Buffer.alloc(4);
    p.writeUInt32LE((1052 << 2) | 0x03, 0);
    expect(Math.abs(((p.readUInt32LE(0) >> 2) / 100) - 10.52) < 1e-9).toBe(true);
  });

  it("空表如实标注，不假装有内容", () => {
    const globals = Buffer.concat([
      biff(0x0809, Buffer.alloc(4)),
      boundsheet("空表", 0),
      sstRec([]),
      biff(0x000a, Buffer.alloc(0)),
    ]);
    const r = extractOleText(buildCfb("Workbook", Buffer.concat([globals, Buffer.alloc(6000)])), "xls");
    // 没有任何单元格 → 走共享字符串表回退路径，并在 info 里说明
    expect(r.info.join()).toMatch(/回退|0 条/);
  });

  it("缺 Workbook 流 → 明确报错", () => {
    expect(() => extractOleText(buildCfb("Book1", Buffer.alloc(5000)), "xls"))
      .toThrow(/缺少 Workbook 流/);
  });
});
