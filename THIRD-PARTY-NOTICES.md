# 第三方声明（THIRD-PARTY-NOTICES）

本文件列出 slime 发布产物中随附、链接或再分发的第三方组件及其许可证。

- **主项目（slime）的许可证见根目录 `LICENSE`（Apache-2.0）**。
- 下列第三方组件**保留其各自的原始许可证**，不因主项目采用 Apache-2.0 而改变。
- 其中 `gui/vendor/` 下的 4 个压缩文件被**直接打进发布产物**（随安装包 / 便携版分发），是附带的第三方代码，须随包附相应许可文本。

## 1. 再分发的压缩文件（`gui/vendor/`，重点）

下表 4 个文件位于 `gui/vendor/`，是被直接再分发的第三方压缩产物。每个文件的许可均按其文件头版权横幅与 `node_modules` 中对应包的 LICENSE / package.json 交叉核对得出。

| 文件 | 对应包 / 版本 | 许可证 | 查证依据（文件头 + node_modules 交叉核对） |
| --- | --- | --- | --- |
| `gui/vendor/docx-preview.min.js` | docx-preview 0.4.1 | Apache-2.0 | 文件头 `@license` 横幅明确写「Apache License 2.0 / Copyright Volodymyr Baydalka」；`node_modules/docx-preview`（0.4.1）LICENSE 为 Apache-2.0 全文，package.json `license` 为 `Apache-2.0` |
| `gui/vendor/jszip.min.js` | jszip 3.10.2 | 双许可：MIT 或 GPL-3.0（任选其一） | 文件头横幅写「Dual licenced under the MIT license or GPLv3」；`node_modules/jszip`（3.10.2）LICENSE.markdown 载明 MIT 或 GPL-3.0 双许可，任选其一使用 |
| `gui/vendor/pptx-preview.umd.js` | pptx-preview 1.0.7 | ISC（**已人工核验，2026-10-06**） | 文件头**仅**为 UMD 包装代码，**无任何许可 / 版权注释**；`node_modules/pptx-preview`（1.0.7）package.json `license` 字段为 `ISC`，但包内**未捆绑 LICENSE 文件**（已复核官方 tarball 47 个文件，确认无 LICENSE/COPYING/NOTICE）。**已补**：`gui/vendor/pptx-preview.LICENSE.txt`（ISC 标准文本 + README 授权要点照录 + 核验记录）——随发布产物一并分发 |
| `gui/vendor/xlsx.full.min.js` | xlsx (SheetJS) 0.18.5 | Apache-2.0 | 文件头为「`/*! xlsx.js (C) 2013-present SheetJS */`」版权标记（未附许可证全文）；`node_modules/xlsx`（0.18.5）package.json `version`=0.18.5、`license`=`Apache-2.0`，且其 LICENSE 文件为 Apache-2.0 全文。**版本落在 0.18.x，尚未切换 SheetJS 自有协议，故本产物按 Apache-2.0 处理** |

> 关于 xlsx 的特别说明：SheetJS 在 0.19 及以后改用其自有协议（非 Apache-2.0）。本仓库 vendor 文件对应的是 **0.18.5**（Apache-2.0），已按 0.18.x 取证。**若日后升级 xlsx 至 0.19+，本条许可证必须重查，不得沿用 Apache-2.0。**

## 2. JS 运行时依赖（npm / pnpm，11 个）

| 组件 | 版本 | 许可证 | 来源 |
| --- | --- | --- | --- |
| `@fastify/cors` | 10.0.0 | MIT | npm |
| `@lancedb/lancedb` | 0.37.1 | Apache-2.0 | npm |
| `better-sqlite3` | 13.0.3 | MIT | npm |
| `docx-preview` | 0.4.1 | Apache-2.0 | npm |
| `electron-updater` | 6.8.9 | MIT | npm |
| `fastify` | 5.12.0 | MIT | npm |
| `pptx-preview` | 1.0.7 | ISC | npm |
| `react-markdown` | 10.1.0 | MIT | npm |
| `remark-gfm` | 4.0.1 | MIT | npm |
| `shared` | 0.1.0 | 内部工作区包，随主项目 Apache-2.0 | 本仓库 pnpm workspace（`shared/`） |
| `xlsx` (SheetJS) | 0.18.5 | Apache-2.0 | npm |

上表许可证 / 版本逐条取自 `node_modules` 内对应包的 package.json（`license` 与 `version` 字段）及随附 LICENSE 文件。

## 3. Python 依赖（`requirements.txt`，14 个）

> **核对方式（2026-10-06 实测，A-1195）**：对每个包执行 `pip download --no-deps <pkg>`，
> 解包 wheel 后**逐字读取** `*.dist-info/METADATA`（License 字段 / License-Expression）
> 与 `licenses/` 下的 LICENSE 原文（含首行与条款数核对）。
> ⚠️ 「实测版本」为当次解析到的最新版本；`requirements.txt` 是**版本范围**约束，
> 实际安装版本可能不同 ⇒ **更新依赖或锁版本时应按同法重跑本核对**。
> ⚠️ 本轮实测**纠正了旧表 4 处偏差**（旧值来自二手声明，未读原文）：
> beautifulsoup4（BSD-3 → **MIT**）、prompt_toolkit（MIT → **BSD-3-Clause**）、
> python-multipart（BSD-3 → **Apache-2.0**）、cryptography 的 BSD 分支（BSD-2 → **BSD-3**）。

| 组件 | 版本范围 | 实测版本 | 许可证（逐字核对） | 证据（wheel 内） |
| --- | --- | --- | --- | --- |
| fastapi | `>=0.111.0` | 0.142.2 | MIT | `License-Expression: MIT`；`licenses/LICENSE`（"The MIT License (MIT)"） |
| uvicorn[standard] | `>=0.29.0` | 0.54.0 | BSD-3-Clause | `License-Expression: BSD-3-Clause`；`licenses/LICENSE.md`（Encode OSS Ltd） |
| pydantic | `>=2.0.0` | 2.13.5 | MIT | `License-Expression: MIT`；`licenses/LICENSE` |
| python-multipart | `>=0.0.9` | 0.0.32 | **Apache-2.0** | `License-Expression: Apache-2.0`；`licenses/LICENSE.txt`（Apache 全文） |
| cryptography | `>=42.0.0` | 50.0.2 | Apache-2.0 OR BSD-3-Clause（双许可取一） | `License-Expression: Apache-2.0 OR BSD-3-Clause`；`LICENSE.BSD` 为 BSD-3 三条款 |
| click | `>=8.1.0` | 8.5.0 | BSD-3-Clause | `License-Expression: BSD-3-Clause`；`licenses/LICENSE.txt`（Pallets） |
| rich | `>=13.7.0` | 15.0.0 | MIT | `licenses/LICENSE`（Will McGugan） |
| httpx | `>=0.27.0` | 0.28.1 | BSD-3-Clause | `licenses/LICENSE.md`（Encode OSS Ltd） |
| beautifulsoup4 | `>=4.12.0` | 4.15.0 | **MIT** | `licenses/LICENSE`（"made available under the MIT license"） |
| prompt_toolkit | `>=3.0.0` | 3.0.53 | **BSD-3-Clause** | `licenses/LICENSE`（Jonathan Slenders，三条款） |
| wcwidth | `>=0.2.13` | 0.9.2 | MIT | `licenses/LICENSE`（"The MIT License (MIT)"） |
| pyyaml | `>=6.0` | 6.0.3 | MIT | `licenses/LICENSE`（Ingy döt Net） |
| lancedb | `>=0.37.0` | 0.39.0 | Apache-2.0 | `licenses/LICENSE`（Apache 全文 11558B） |
| pytest | `>=8.0` | 9.1.1 | MIT | `License-Expression: MIT`；`licenses/LICENSE` |

> **边界说明**：`uvicorn[standard]` 的 extras 组成包与上述包的**传递依赖**（由 pip 解析产生）
> 未逐个入表；如需全树核对，可在锁定版本的虚拟环境中执行
> `pip-licenses --with-license-file --with-urls` 复核。

## 4. 分发时的行动指引

**分发二进制 / 发布产物时，必须随包附带上述第三方许可文本。** 具体建议：

1. `gui/vendor/` 的 4 个压缩文件已内嵌各自版权横幅，但仍应在安装包内保留一份完整许可文本目录（建议 `dist/licenses/`），覆盖 Apache-2.0、MIT、GPL-3.0、ISC 全文各一份。
2. 对 `pptx-preview.umd.js`（vendor 文件本身无许可文本），**已放入** `gui/vendor/pptx-preview.LICENSE.txt`（ISC 文本 + 来源核验记录）——分发时随包携带该文件。
3. 主项目 `LICENSE`（Apache-2.0）按其第 4(d) 条要求，若以 NOTICE 形式分发，须一并附本文件的第三方归因信息。
