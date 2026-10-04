






import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isOle2, openCfb } from "../../core-ts/src/cfb.js";
import { extractOleText, oleKindFromExt, legacyBinaryName, cleanWordText } from "../../core-ts/src/doc_text.js";

const ROOT = resolve(__dirname, "../..");
const SECTOR = 512;


function buildCfb(streamName: string, streamData: Buffer): Buffer {
  const dataSectors = Math.ceil(streamData.length / SECTOR);
  const totalSectors = 1 + 1 + dataSectors;          
  const buf = Buffer.alloc((totalSectors + 1) * SECTOR, 0);

  
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  buf.writeUInt16LE(0x003e, 24);                     
  buf.writeUInt16LE(0x0003, 26);                     
  buf.writeUInt16LE(0xfffe, 28);                     
  buf.writeUInt16LE(9, 30);                          
  buf.writeUInt16LE(6, 32);                          
  buf.writeUInt32LE(1, 44);                          
  buf.writeUInt32LE(1, 48);                          
  buf.writeUInt32LE(4096, 56);                       
  buf.writeUInt32LE(0xfffffffe, 60);                 
  buf.writeUInt32LE(0, 64);                          
  buf.writeUInt32LE(0xfffffffe, 68);                 
  buf.writeUInt32LE(0, 72);
  buf.writeUInt32LE(0, 76);                          

  const sectorOff = (n: number): number => (n + 1) * SECTOR;

  
  const fat = sectorOff(0);
  buf.writeUInt32LE(0xfffffffd, fat + 0 * 4);        
  buf.writeUInt32LE(0xfffffffe, fat + 1 * 4);        
  for (let i = 0; i < dataSectors; i += 1) {
    const next = i === dataSectors - 1 ? 0xfffffffe : 2 + i + 1;
    buf.writeUInt32LE(next, fat + (2 + i) * 4);
  }
  for (let i = 2 + dataSectors; i < SECTOR / 4; i += 1) { buf.writeUInt32LE(0xffffffff, fat + i * 4); }

  
  const dir = sectorOff(1);
  const writeEntry = (off: number, name: string, type: number, start: number, size: number): void => {
    const nameBuf = Buffer.from(`${name}\0`, "utf16le");
    nameBuf.copy(buf, off);
    buf.writeUInt16LE(nameBuf.length, off + 64);
    buf[off + 66] = type;
    buf[off + 67] = 1;                               
    buf.writeUInt32LE(0xffffffff, off + 68);         
    buf.writeUInt32LE(0xffffffff, off + 72);         
    buf.writeUInt32LE(0xffffffff, off + 76);         
    buf.writeUInt32LE(start >>> 0, off + 116);
    buf.writeBigUInt64LE(BigInt(size) & 0xffffffffn, off + 120);
  };
  writeEntry(dir, "Root Entry", 5, 0xfffffffe, 0);
  writeEntry(dir + 128, streamName, 2, 2, streamData.length);

  
  streamData.copy(buf, sectorOff(2));
  return buf;
}


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
    const payload = Buffer.alloc(5000, 0x41);        
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
  





  it("从合成 CFB 里抽出 Slide 容器内 TextCharsAtom 的文字", () => {
    const text = "第一页标题\u000d正文一句话";
    const atom = pptRecord(0x0fa0, Buffer.from(text, "utf16le"));
    const slide = pptRecord(0x03ee, atom, 0x0f);
    
    
    const pad = pptRecord(0x0fa8, Buffer.from("padding".repeat(900), "latin1"));
    const cfb = buildCfb("PowerPoint Document", Buffer.concat([slide, pad]));
    expect(cfb.length).toBeGreaterThan(4096);
    const r = extractOleText(cfb, "ppt");
    expect(r.text).toContain("第一页标题");
    expect(r.text).toContain("正文一句话");
    expect(r.info.join()).toContain("ppt");
  });

  it("容器记录（recVer=0xF）必须下钻而不是整体跳过", () => {
    
    
    
    const inner = pptRecord(0x0fa0, Buffer.from("容器内的文字", "utf16le"));
    const slide = pptRecord(0x03ee, inner, 0x0f);
    const container = pptRecord(0x03e8, slide, 0x0f);
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

describe("A-1133 ④ Word 控制字符清洗：**换行必须活下来**（.doc 段落结构）", () => {
  










  it("段落标记 → 换行，且**不被后续清理抹掉**（bug 的精确判据）", () => {
    const out = cleanWordText("第一段\r第二段\r第三段");
    expect(out, "段落标记 0x0D 必须变成换行").toBe("第一段\n第二段\n第三段");
    expect(out.split("\n"), "三行就是三行 —— 少了说明换行被后面的字符类清掉了").toHaveLength(3);
  });

  it("单元格结束（0x07）→ 制表符，同样必须存活", () => {
    expect(cleanWordText("甲\x07乙")).toBe("甲\t乙");
  });

  it("软换行 / 分页（0x0B / 0x0C）也算结构 → 换行", () => {
    expect(cleanWordText("上\x0b下")).toBe("上\n下");
    expect(cleanWordText("前\x0c后")).toBe("前\n后");
  });

  it("该清的还是清（域标记 + 真控制字符），别修出新洞", () => {
    expect(cleanWordText("a\x14b\x15c\x13d")).toBe("abcd");   
    expect(cleanWordText("a\x00b\x01c\x02d")).toBe("ab￼cd");  
    expect(cleanWordText("a\x1fb")).toBe("ab");
  });

  it("连续空段落被压到最多一个空行（`\\n{3,}` → `\\n\\n`）", () => {
    expect(cleanWordText("甲\r\r\r\r乙")).toBe("甲\n\n乙");
  });

  it("端到端：合成 .doc 流里抽出的正文**带换行**（不是一整块）", () => {
    



    


    const para = "这是一段足够长的正文内容用来验证段落结构不会消失".repeat(60);
    const text = `${para}\r${para}\r${para}`;
    





    const fibHead = Buffer.alloc(512, 0);
    fibHead.writeUInt16LE(0xa5ec, 0x0000);   
    fibHead.writeUInt16LE(193, 0x0002);      
    fibHead.writeUInt16LE(0, 0x000A);        
    const stream = Buffer.concat([fibHead, Buffer.from(text, "utf16le")]);
    const cfb = buildCfb("WordDocument", stream);
    expect(stream.length).toBeGreaterThan(4096);
    expect(cfb.length).toBeGreaterThan(4096);
    const r = extractOleText(cfb, "doc");
    expect(r.text, "抽出的正文必须保留段落结构").toContain("\n");
    expect(r.text.split("\n").filter((l) => l.trim()).length, "三段就该是三行").toBeGreaterThanOrEqual(3);
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
    
    expect(src.includes("暂不支持 ${legacy} 二进制格式")).toBe(false);
  });

  it("[反例] 上一条正则必须能抓到没接线的写法（守卫自检）", () => {
    const bad = 'return `[错误] 暂不支持 ${legacy} 二进制格式（${ext}）`;';
    expect(/extractOleText\(await readFile\(p\), oleKind\)/.test(bad)).toBe(false);
  });
});

describe("A-1036 ④ .xls 单元格网格（BIFF8：标签 + 数字 + 表名）", () => {
  
  const biff = (type: number, payload: Buffer): Buffer => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0);
    h.writeUInt16LE(payload.length, 2);
    return Buffer.concat([h, payload]);
  };
  


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
  
  const rkCell = (row: number, col: number, v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE((v << 2) | 0x02, 0);
    return biff(0x027e, Buffer.concat([cellHead(row, col), b]));
  };

  function buildXls(): Buffer {
    
    const globals = Buffer.concat([
      biff(0x0809, Buffer.alloc(4)),
      boundsheet("数据表", 0),
      sstRec(["名称", "数量", "苹果"]),
      biff(0x000a, Buffer.alloc(0)),
    ]);
    
    const sheet = Buffer.concat([
      biff(0x0809, Buffer.alloc(4)),
      labelSst(0, 0, 0),          
      labelSst(0, 1, 1),          
      labelSst(1, 0, 2),          
      numberCell(1, 1, 10.52),    
      rkCell(2, 1, 42),           
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
    
    expect(r.text, "NUMBER 单元格必须解出").toContain("10.52");
    expect(r.text, "RK 单元格必须解出").toContain("42");
    
    expect(r.text).toContain("A | B");
    expect(r.text).toMatch(/\n1\t/);
  });

  it("RK 编码：整数位与除 100 位都要正确", () => {
    const rk = (v: number): number => (v << 2) | 0x02;
    expect(rk(42)).toBe(170);
    
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
    
    expect(r.info.join()).toMatch(/回退|0 条/);
  });

  it("缺 Workbook 流 → 明确报错", () => {
    expect(() => extractOleText(buildCfb("Book1", Buffer.alloc(5000)), "xls"))
      .toThrow(/缺少 Workbook 流/);
  });
});
