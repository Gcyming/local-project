#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 doc_text.ts 的最小 Office 回归样本（tests/fixtures/office/*.docx|pptx|xlsx）。

为什么不用真实文档当样本：
  1. 真实文档在用户 Downloads 里，CI 与新克隆都拿不到；
  2. 体积大、内容不可控，断言只能写"长度大于 0"这种没信息量的条件。
这里手工拼最小容器（只放提取器真正读的那几个部件），内容固定、可直接断言。

用法：py tests/fixtures/office/_make_fixtures.py
"""
import sys
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent

DOCX_DOCUMENT = """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>第一段：Slime 文档读取测试</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段带</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>制表符</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>分数</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>张三</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>95</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>转义检查 &amp; &lt;标签&gt;</w:t></w:r></w:p>
  </w:body>
</w:document>
"""

PPTX_SLIDE_1 = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>封面：第一页标题</a:t></a:r></a:p>
    <a:p><a:r><a:t>副标题一行</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>
"""

PPTX_SLIDE_2 = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>第二页正文</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>
"""

XLSX_WORKBOOK = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="销量" sheetId="1" r:id="rId1"/>
    <sheet name="汇总" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>
"""

XLSX_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>
"""

XLSX_SHARED = """<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>月份</t></si>
  <si><t>销量</t></si>
  <si><t>一月</t></si>
  <si><t>二月</t></si>
</sst>
"""

# 注意 A1/B1 用共享串（t="s"），C1 起留空验证列跳位；第三行直接是数字
XLSX_SHEET1 = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="C2"><v>123</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>3</v></c>
    </row>
  </sheetData>
</worksheet>
"""

XLSX_SHEET2 = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>内联字符串</t></is></c></row>
    <row r="2"><c r="A2"><v>42</v></c></row>
  </sheetData>
</worksheet>
"""

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>
"""


def write(name: str, parts: dict) -> None:
    path = OUT / name
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for member, data in parts.items():
            z.writestr(member, data)
    print(f"  {name}: {len(parts)} 个部件, {path.stat().st_size} 字节")


def write_evil() -> None:
    """Zip-Slip 样本：归档内路径试图逃出解压目录。

    为什么必须有：`extractZipTo` 的安全规则如果被改坏（或新加的解压路径忘了调用它），
    一个恶意 zip 就能往解压目录之外写文件。守卫断言这些条目必须落在 `skipped` 里，
    且目标文件**不得**在解压目录外出现。
    """
    path = OUT / "evil.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        z.writestr("../escape.txt", "escaped")
        z.writestr("nested/../../escape2.txt", "escaped")
        z.writestr("/abs-escape.txt", "escaped")
        z.writestr("ok/inside.txt", "fine")
    print(f"  evil.zip: 4 个条目（3 个恶意 + 1 个正常）, {path.stat().st_size} 字节")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    print("生成 Office 回归样本：")
    write("sample.docx", {
        "[Content_Types].xml": CONTENT_TYPES,
        "word/document.xml": DOCX_DOCUMENT,
    })
    write("sample.pptx", {
        "[Content_Types].xml": CONTENT_TYPES,
        "ppt/slides/slide1.xml": PPTX_SLIDE_1,
        "ppt/slides/slide2.xml": PPTX_SLIDE_2,
    })
    write("sample.xlsx", {
        "[Content_Types].xml": CONTENT_TYPES,
        "xl/workbook.xml": XLSX_WORKBOOK,
        "xl/_rels/workbook.xml.rels": XLSX_RELS,
        "xl/sharedStrings.xml": XLSX_SHARED,
        "xl/worksheets/sheet1.xml": XLSX_SHEET1,
        "xl/worksheets/sheet2.xml": XLSX_SHEET2,
    })
    write_evil()
    return 0


if __name__ == "__main__":
    sys.exit(main())
