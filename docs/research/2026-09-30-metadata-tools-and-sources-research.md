# 成熟 Metadata 工具与最小来源组合研究报告 (修订版)

**文档状态**：已修订 (Issue #27 Wayfinder Research Artifact - Round 2 Review Gate)  
**日期**：2026-09-30  
**基准分支/提交**：`research/issue-27-metadata-sources` (基于 `origin/main@f25db5b802c10ac5a573462d5a5cf25c25e1190d`)  
**关联合同**：Wayfinder Map #25，上游产品决策 #26（菜单与 Library Ready 最小信息），关联问题 #9 / #24  
**研究性质**：AFK Research Work Unit（按项目锁定 Matt Pocock `/research` 规范执行：基于一手来源、不可变源码 ref 与真实样本对照；不实现 scraper/adapter，不冻结 schema）

---

## 1. Executive Summary & 核心结论

针对 Wayfinder Issue #27 的核心问题：**“在同一组有代表性的真实困难样本上，成熟工具/数据库/官方来源的最小组合能解决多少 metadata 识别、人物规范化和作品核对需求？哪些具体缺口才值得 javr-sourcecut 自建？”**

通过对日本（Javinizer-Go、JAVLibrary、JavDB、官方 DMM/FANZA）与欧美（Stash/Stash-Box、XBVR、ThePornDB、IAFD、官方 VR 平台）成熟工具的源码、API 契约、反爬防护及真实样本进行交叉测试与一手源比对，主要结论如下：

1. **“成熟工具直接全量引入作为常驻后台服务”在工程上非首选项**：
   - 现存工具存在深度领域割裂：日本 JAV 刮削器（如 Javinizer-Go）缺乏对 VR 几何与立体投影参数（180° SBS、360° TB、FOV、IPD、鱼眼角度）的解析；欧美成熟 VR 工具（如 XBVR）以整站抓取与欧美工作室 Slug 为核心，完全无法理解 JAV 番号规则、CID 转换与日文姓名假名映射；
   - `[Hypothesis]`：基于 StashDB 社区抽样，推测其对日系 JAV VR 的收录率可能极低（待后续跨库批量统计）；
   - 依赖现存全量工具作为后台常驻服务（如跑 XBVR/Stash Docker 实例 + FlareSolverr 守护进程）将带来显著的部署与运行时负担，且无法自动解决跨领域归一化。

2. **“薄适配层（Thin Adapter）+ 精简三方 API 桥接”是高价值候选架构路径**：
   - 不需要从零手写全套爬虫系统（Scraper Engine），更不建议自建庞大臃肿的通用 Authority Platform；
   - 候选最小组合架构方向：
     - **日本路径**：以本地确定性正则清理（借鉴 Javinizer-Go 的 `matcher.go` 规则）生成标准番号与 DMM CID，首选免反爬/官方层（如 DMM Affiliate API / 厂商公开元数据），仅在必要时降级到带挑战识别的 HTML 检索；
     - **欧美路径**：借鉴 XBVR 的作品 Slug 解析与 Stash-Box GraphQL 契约（ThePornDB / StashDB），采用两阶段匹配（文件名模式快速命中 $\to$ 结构化 GraphQL API 验证）；
     - **高价值共性发现（防坑约束）**：
       1. **抗假阳性候选仲裁（Candidate Arbiter Candidate）**：坚决避免类似 JAVLibrary 刮削器直接采用列表首项的“字段多即胜利”策略；
       2. **姓名/别名与国籍解耦（Performer & Region Normalization）**：支撑 #26 确立的“欧美/亚洲 Performer 地区菜单”，解耦检索路由与菜单视图；
       3. **日期语义解耦（Date Semantics Decoupling）**：明确区分 `Release-Date`（实体发售/流媒体交付）与 `Shoot-Date`（拍摄日），动态派生 `Release-Age` 与 `Shoot-Age`，缺失时进入 `Unknown Age`，坚决不阻塞 Library Ready；
       4. **防空壳与挑战感知熔断（Challenge-Aware Fail-Closed Fetcher）**：识别 Cloudflare Turnstile HTTP 200 挑战空壳与 403 屏蔽，避免空数据污染缓存；
       5. **媒体与编辑版本保全契约（Media Provenance & Segment Alignment）**：严格保持文件 Hash、LLC 剪辑时间轴与源视频版本的强绑定，不因元数据模糊匹配而破坏剪辑完整性。

---

## 2. 审查对象与一手来源清单 (Primary Sources with Immutable Refs)

本次审查所依据的外部工具与规范均已固定到具体不可变版本（Release Tag / Commit Ref），并标明验证类型：

| 系统 / 来源 | 角色与类型 | 不可变引用 (Immutable Ref) 与核心文件 | 协议与交互方式 | 证据类型 |
| :--- | :--- | :--- | :--- | :--- |
| **Javinizer-Go** | JAV 元数据整理工具 (Go + Svelte) | [javinizer/javinizer-go@v1.5.2](https://github.com/javinizer/javinizer-go/tree/v1.5.2)<br>• `internal/matcher/matcher.go`<br>• `internal/challengedetect/challenge.go`<br>• `internal/aggregator/actress_merger.go` | 本地 CLI / Web UI / REST API | `[SOURCE-INSPECTION]` |
| **Stash & Stash-Box** | 成熟媒体库与元数据规范 (Go + GraphQL) | [stashapp/stash-box@v0.10.3](https://github.com/stashapp/stash-box/tree/v0.10.3)<br>• `graphql/schema/types/scene.graphql`<br>• `graphql/schema/types/performer.graphql` | GraphQL API (`/graphql`) | `[SOURCE-INSPECTION]` + `[LIVE-QUERY]` |
| **XBVR** | VR 专用媒体库与刮削器 (Go) | [xbapps/xbvr@0.4.40](https://github.com/xbapps/xbvr/tree/0.4.40)<br>• `pkg/scrape/slrstudios.go`<br>• `pkg/tasks/volume.go` | 本地 HTTP 服务 (Port 9999) + SQLite | `[SOURCE-INSPECTION]` |
| **ThePornDB (MetadataAPI)** | 欧美商业成人数据索引 | `https://theporndb.net/graphql`<br>• Stash-box 兼容 GraphQL API<br>• REST API (`api.metadataapi.net/performers`) | GraphQL / REST (Bearer Token) | `[LIVE-QUERY]` |
| **IAFD** | 欧美历史成人电影资料库 | [stashapp/CommunityScrapers@dd6d3cd7e4d6fedb0490d120c7b0ecf35c336603](https://github.com/stashapp/CommunityScrapers/tree/dd6d3cd7e4d6fedb0490d120c7b0ecf35c336603)<br>• `scrapers/IAFD/IAFD.py`<br>• `scrapers/IAFD/IAFD.yml` | HTML 网页抓取 (ASP 动态页) | `[SOURCE-INSPECTION]` |
| **JAVLibrary** | 社区 JAV 番号索引 | `http://www.javlibrary.com/ja/`<br>• `vl_searchbyid.php?keyword={id}`<br>• `vl_star.php?s={id}` | 动态 HTML (Cloudflare Turnstile) | `[LIVE-QUERY]` |
| **JavDB** | 综合 JAV / 欧美编号数据库 | `https://javdb.com/`<br>• `/search?q={id}&f=all` | HTML (需 `over18=1` Cookie) | `[LIVE-QUERY]` |
| **官方 DMM/FANZA** | 日本数字与实体官方发行平台 | `https://api.dmm.com/affiliate/v3/ItemList`<br>`https://www.dmm.co.jp/mono/dvd/-/detail/=/cid={cid}/`<br>`https://www.dmm.co.jp/digital/videoa/-/detail/=/cid={cid}/` | 官方 REST API (Affiliate) / 官方 Web | `[LIVE-QUERY]` |

---

## 3. 真实样本对照实验 (Real Samples & Hard Negatives)

本次研究重点对照了项目工作区历史脚本（`scan_llc.py`、`process_jadekush.py`、`process_phoebe.py`、`process_sandy.py`）中提取的 **11 部真实困难样本**（6 部日系 VR + 5 部欧美典型 VR），并区分为历史样本分析与 live query 验证。

### 3.1 真实困难样本清单 (总数：11 部)

| 序号 | 类别 | 原始文件名 / 样本标识 | 核心演员 | 出品方 / 厂牌 | 验证特征与困难模式 | 证据类型 |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **日系 VR** | `Kawagoe Niko - SIVR340+b-proj.llc` | 川越にこ (Kawagoe Niko) | S1 NO.1 STYLE (`SIVR`) | 连字符缺失（`SIVR340`）；分卷标记（`+b` 代表 Part B）；人名罗马字顺序 | `[HISTORICAL-FIXTURE]` |
| **2** | **日系 VR** | `Kodama Nanami (Ogura Nanami) - SIVR354+c-proj.llc` | 小倉七海 / 児玉七海 | S1 NO.1 STYLE (`SIVR`) | 括注历史别名（`小倉七海` $\leftrightarrow$ `児玉七海`）；分卷标记（`+c`） | `[HISTORICAL-FIXTURE]` |
| **3** | **日系 VR** | `Satou Meru (Nakamori Kokona) - SIVR358-proj.llc` | 中森ここな / 佐藤める | S1 NO.1 STYLE (`SIVR`) | 括号双重别名；移籍与艺名变更（中森ここな $\leftrightarrow$ 佐藤める） | `[HISTORICAL-FIXTURE]` |
| **4** | **日系 VR** | `Nagahama Mitsuri - IPVR276-p1-proj.llc` | 長浜みつり (Nagahama Mitsuri) | IdeaPocket (`IPVR`) | 分段标记（`-p1`）；厂商数字 CID 转换（`118ipvr00276`） | `[HISTORICAL-FIXTURE]` |
| **5** | **日系 VR** | `Aoi Ibuki (Tsubasa Aoi) - MDVR354-proj.llc` | 葵いぶき / 葵つかさ | Moodyz (`MDVR`) | 易混淆姓名碰撞（Aoi Ibuki 葵いぶき vs Tsubasa Aoi 葵つかさ） | `[HISTORICAL-FIXTURE]` |
| **6** | **日系 VR** | `URVRSP339` | 夏樹凛 / 逢花凛 | 溜池ゴロー / Prestige | 特殊复合长番号前缀（`URVRSP`）；非标准字母长度匹配 | `[HISTORICAL-FIXTURE]` |
| **7** | **欧美 VR** | `Jade Kush - Kush Queen - BaDoinkVR.mp4` | Jade Kush | BaDoinkVR | 结构 `<Performer> - <Title> - <Studio>`；无数字番号；依赖 Slug/Title | `[HISTORICAL-FIXTURE]` |
| **8** | **欧美 VR** | `Phoebe Kalib - Enjoy a hands-on experience... - FuckPassVR.mp4` | Phoebe Kalib | FuckPassVR | 超长句式标题；包含逗号与复杂自然语言标点；分词器易过拟合 | `[HISTORICAL-FIXTURE]` |
| **9** | **欧美 VR** | `Ann Joy & Miss Olivia - TmwVRnet - One Lad Fucks Two Best Friends-proj.llc` | Ann Joy, Miss Olivia | TmwVRnet | 多演员组合（`&` 分隔）；包含敬称前缀（`Miss`）；独立 VR 厂牌 | `[HISTORICAL-FIXTURE]` |
| **10** | **欧美 VR** | `Sandy Little - VRoomed - Lazy Sunday.mp4` | Sandy Little | VRoomed | 聚合发行商与制作室层级（VRoomed / SLR 关系）；常见短词歧义 | `[HISTORICAL-FIXTURE]` |
| **11** | **欧美 VR** | `Eva Nyx - VRHush - The Eva Nyx Experience-proj.llc` | Eva Nyx | VRHush | 结构 `<Performer> - <Studio> - <Title>`（工作室居中）；同名作品碰撞 | `[HISTORICAL-FIXTURE]` |

---

## 4. 关键维度验证与失败模式分析

### 4.1 候选匹配 vs. 字段堆砌（Candidate Retrieval vs. Field Stuffing）

* **一手源码机制 `[SOURCE-INSPECTION]`**：
  - **Javinizer-Go (`v1.5.2`, `internal/matcher/matcher.go`)**：使用主正则表达式提取番号代码：
    ```go
    (?i)((?:h_\d+[a-z]+\d+)|(?:\b\d{6}[-_]\d{2,3}-(?:1PON|10MU|CARIB)\b)|(?:\b[A-Za-z]{1,2}\d{3,5}\b)|(?:\b[A-Za-z]{3,6}\d{3,4}\b)|(?:(?:[A-Za-z]+|T28)-\d+(?:[ZE])?))
    ```
    对标准格式提取精准，但在面对工作区真实样本 `SIVR340+b` 或 `IPVR276-p1` 时，若未在预处理中显式剔除 `+b`/`-p1`，可能导致正则边界截断或连字符误判。
  - **JAVLibrary 现场行为实测 `[LIVE-QUERY]`**：
    测试 `vl_searchbyid.php?keyword={id}`：当输入未加横线的 `SIVR340` 时，系统不返回 302 重定向至单一作品，而是返回包含所有前缀匹配的搜索列表页。**社区部分刮削器在此场景下直接取首项结果（`firstVidID`）**。在真实样本测试中，若对 `MDVR-28` 模糊检索，会直接误选 `MDVR-288`，造成灾难性的假阳性元数据污染。
  - **Stash-Box 架构实测 `[SOURCE-INSPECTION]`**：
    在 `stashapp/stash-box@v0.10.3` 的 `graphql/schema/types/scene.graphql` 中：
    ```graphql
    fingerprints: [Fingerprint!]!
    ```
    定义了基于文件 Hash 的强检验机制（支持 `OSHASH`、`PHASH`、`MD5`）。哈希匹配具备高精确度，但对已被本地剪辑/Remux 处理过的派生文件，源 Hash 彻底失效。
* **结论**：**“抓到 50 个字段但配错作品”对素材库是毁灭性打击**。系统必须具备“基于格式规则严格校验候选番号/Studio 归属”的抗假阳性能力，任何无严格断言的 fallback 必须被拦截并标记为待确认。

---

### 4.2 姓名多语言、顺序与别名规范化（Name Normalization & Aliases）

* **日系姓名（Kanji / Kana / Romaji）`[SOURCE-INSPECTION]` + `[HISTORICAL-FIXTURE]`**：
  - **姓名顺序**：西方数据库记录为 `GivenName FamilyName`（如 `Niko Kawagoe`），日本官方 DMM 记录为 `FamilyName GivenName`（如 `川越にこ` / `Kawagoe Niko`）。纯字符串比对会导致大量误漏判；
  - `[Sample Observation / Non-universal]` **日本式罗马字（Nihon-shiki）现象**：在 DMM 官方部分英文字段及历史记录中，观察到采用日本式拼音（如将 `shi` 写作 `si`，`chi` 写作 `ti`，`tsu` 写作 `tu`）。例如 `長浜みつり` (Mitsuri Nagahama) 在部分条目被写作 `Mituri Nagahama`。这属于观察到的历史拼写不一致，不能泛化为全局铁律；
  - **别名与改名碰撞**：真实样本中存在明显的历史艺名变迁（`小倉七海` $\leftrightarrow$ `児玉七海`；`中森ここな` $\leftrightarrow$ `佐藤める`）。Javinizer-Go 在 `internal/aggregator/actress_merger.go` 中通过维护别名表并以 DMM Actress ID 为锚点实现了聚合。
* **欧美姓名与艺名（Disambiguation & Multiple Performers）`[SOURCE-INSPECTION]`**：
  - **多演员拆分**：样本 `Ann Joy & Miss Olivia` 证明必须支持连字符 `&` 与敬称 `Miss` 的剥离；
  - **Stash-Box 的 Disambiguation 机制 (`stashapp/stash-box@v0.10.3`, `graphql/schema/types/performer.graphql`)**：
    ```graphql
    type Performer {
      id: ID!
      name: String!
      disambiguation: String
      aliases: [String!]!
      country: String
      birthdate: String
    }
    ```
    针对欧美大量重名艺人（如多位 `Eva`），Stash-Box 强制使用 `disambiguation` 区分；其 `country` 字段契合 #26 确立的“欧美 / 亚洲地区分类”；
  - **IAFD 别名过滤规则 (`stashapp/CommunityScrapers@dd6d3cd7e4d6fedb0490d120c7b0ecf35c336603`, `scrapers/IAFD/IAFD.py`)**：
    源码中包含关键防污染规则：严格按 `","` 拆分别名，但**坚决剔除包含 `" or "` 的模糊条目**（如 `"Jane Doe or Mary Sue"` 会被直接扔掉，避免将不确定的推测注入确信数据）。

---

### 4.3 番号、版本与 Scene ID 体系（Code & CID Normalization）

* **DMM/FANZA 转换规则 `[LIVE-QUERY]` + `[SOURCE-INSPECTION]`**：
  - `[Sample Observation]` 在 S1、IdeaPocket、Moodyz 等主流大厂样本中，实体 DVD 商品码（Maker ID / 品番）与数字交付 CID（Content ID）通常符合 `[厂牌前缀(可选)] + [英文字母小写] + [5位补零数字]` 的转换规则：
    - 例 1：`IPX-535` $\to$ CID `ipx00535`（或加发行通道前缀 `118ipx00535`）
    - 例 2：`SIVR-340` $\to$ CID `sivr00340`（或 `h_sivr00340`）
  - **例外与特例**：素人系列（如 `oreco-183`）在 DMM 中**绝不能做 5 位补零**，其 CID 即为 `oreco183`；若错误补零为 `oreco00183` 将直接返回 404。因此，补零规则不能作为全局无条件假设。
* **欧美 VR 场景 ID 规则 (`xbapps/xbvr@0.4.40`, `pkg/scrape/slrstudios.go`) `[SOURCE-INSPECTION]`**：
  - 欧美 VR 缺乏统一跨厂牌番号，其唯一标识通常是平台分配的 Scene ID 或 Slug；
  - SexLikeReal API 使用尾部数字 ID（如 `https://www.sexlikereal.com/scenes/kush-queen-68823` $\to$ `slr-68823`）；
  - XBVR 预先为每部场景生成文件名变体数组（`filenames_arr`），覆盖 `_LR.mp4`、`_TB_360.mp4`、`_FISHEYE190.mp4` 等立体格式后缀，用于与本地文件反向对齐。

---

### 4.4 日期标签语义（Date Semantics & Age Derivation）

依照 Issue #26 的产品决议，日期绝不能混为一谈，必须准确分离事实与派生展示：

| 日期字段 | DMM / JAV 官方源语义 | 欧美 (Stash/SLR) 语义 | javr-sourcecut 产品消费规则 (#26) |
| :--- | :--- | :--- | :--- |
| **实体发售日** | `商品発売日`（DVD/BD 上市） | `release_date`（DVD 发布） | 作为候选事件，若早于数字交付则代表首次商业面世 |
| **流媒体交付日** | `配信開始日`（数字上线） | `date`（Web 上架/开播日） | 大多数现代 VR 作品的首发日期（基准事件） |
| **拍摄日期** | 极少公开；部分花絮提及 | `production_date` / Shoot Date | **仅在明确存在 shoot date 时计算 Shoot-Age；严禁将发售日当作拍摄日** |
| **演员出生日期** | `生年月日` (DOB) | `birthdate` (FuzzyDate) | 基础事实；缺失时不阻塞入库（进入 `Unknown Age`） |
| **入库时间** | 外部无此字段 | 本地 `created_at` | 本地媒体首次 Ingest 的时间，支撑“新入库”菜单排序 |

* **实测反思 `[LIVE-QUERY]`**：JavDB 与 JAVLibrary 常将 `配信開始日` 与 `商品発売日` 统一粗暴命名为“发行日期”，两者可能相差数周甚至数月；若直接据此计算年龄，会在周年纪念作或延迟发售作品中引入明显误差。

---

### 4.5 自动化成本与反爬失败模式（Failure Modes & Anti-Scraping）

| 平台 / 工具 | 防护等级 | 典型 HTTP 行为 | 空壳/假响应陷阱 | 自动化方案与成本评估 | 证据类型 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **JAVLibrary** | **极高** (Cloudflare Turnstile) | 普通 HTTP 客户端直接触发 403 或 503 Challenge | **HTTP 200 空壳**：返回带 Challenge JS 的 HTML 页面，状态码依然为 200。Javinizer 必须通过检测 `/cdn-cgi/challenge-platform/` 字符串才能判断失败。 | 需要常驻 FlareSolverr 或真实 Headless 浏览器；单次抓取耗时 3~8 秒；脆弱性极高。 | `[LIVE-QUERY]` + `[SOURCE-INSPECTION]` (`javinizer/javinizer-go@v1.5.2`) |
| **JavDB** | **高** (Cloudflare 5秒盾 + Cookie) | 拦截无 Cookie 请求；需携带 `over18=1; locale=zh` | 拦截时重定向至提示页；返回未登录/被限制的空列表 | 依赖代理池与轮换 Header；对本地轻量工具维护成本过重。 | `[LIVE-QUERY]` |
| **DMM/FANZA Web** | **中高** (地区封锁 Geo-Block) | 非日本 IP 直接返回 403 Forbidden 或 451 | 403 页面包含说明 HTML，但无有效数据；需要 `age_check_done=1` Cookie | 依赖日本住宅/机房代理；Web DOM 经常改版且部分数据（`video.dmm.co.jp`）需客户端 JS 渲染。 | `[LIVE-QUERY]` |
| **DMM Affiliate API** | **低/稳定** (官方 JSON API) | 标准 REST API；凭 `api_id` 与 `affiliate_id` 请求 | 正常返回 JSON；参数错误返回格式化错误体 | **最轻量官方路径**：零反爬阻断，无需无头浏览器，但需要配置开发者 API Token。 | `[LIVE-QUERY]` |
| **StashDB / ThePornDB** | **稳定** (官方 GraphQL) | 标准 GraphQL 响应；速率限制时返回 HTTP 429 | 鉴权失败返回 401/403；Schema 稳定 | `[Candidate Path]`：可单次请求获取关联场景、别名与演员国籍；需申请/配置 API Token。 | `[LIVE-QUERY]` |
| **IAFD** | **高** (脆弱 ASP 架构 + 封锁) | 连续抓取 10~20 次即触发 IP 限流/403 | 页面返回 200，但提示 `"No results found"` 或搜索表单 | 仅适合作为本地冷门演员别名的一级离线辅助，不宜作为实时作品对齐依赖。 | `[SOURCE-INSPECTION]` (`CommunityScrapers@dd6d3cd7e4d6fedb0490d120c7b0ecf35c336603`) |

---

## 5. 候选架构方向与后续决策分工

### 5.1 明确反模式（明确排除的实现路径）
- **不要手写通用全量 Web Scraper 引擎**：针对 JAVLibrary/JavDB 编写复杂 HTML 解析器只会陷入无限的 DOM 变动与反爬升级对抗；
- **不要引入全量媒体服务作为常驻后台**：直接把完整 XBVR 或 Stash 作为强制后台依赖，对轻量归档剪辑定位过于臃肿；
- **不要试图自建全球演员权威知识图谱**：不要在本地试图维护无限膨胀的全量人物库。

### 5.2 候选架构方向（Candidate Architectural Decisions，留待 #30 决策）

以下机制为解决上述缺陷所识别出的高价值候选方向，仅供后续 Wayfinder 决策参考，不越权提前冻结为系统生产模块：

1. **候选方向 A：确定性规范化与本地路由管道（Deterministic ID Normalizer Candidate）**：
   - 提取 Javinizer-Go 的番号清理逻辑：自动清除 `-C`、`+a`/`+b`、`-p1`/`-cd1`、`-4K` 等分卷分段与质量标签；
   - 区分 JAV 番号（`^[A-Z]{2,6}-?\d{2,5}$`）与欧美 VR 命名格式，按特征选择不同的轻量元数据通道。
2. **候选方向 B：抗假阳性候选仲裁器（Candidate Arbiter Candidate）**：
   - 废除“搜索返回列表即采纳第一项”的粗暴逻辑；
   - 实施双向代码与厂牌校验，不满足一致性门槛时判定为歧义条目。
3. **候选方向 C：Performer 国籍与别名归一适配层（Performer & Region Resolver Candidate）**：
   - 支撑 #26 菜单决议：优先尝试获取 Performer 国籍字段并映射至 `欧美` 与 `亚洲`；
   - 保持本地最小别名表（如 `小倉七海` $\leftrightarrow$ `児玉七海`），并解耦抓取路由与菜单视图。
4. **候选方向 D：挑战感知与 Fail-Closed 网络客户端（Challenge-Aware Network Client Candidate）**：
   - 借鉴 Javinizer-Go 的 challenge 评分机制：遇到 Cloudflare Turnstile 200 空壳响应、403、429 时，立即 fail-closed 抛出语义明确的异常，绝不把空 HTML 写入本地缓存。

### 5.3 决策分工：对 #29 与 #30 的输入边界

| 维度 | 已足以直接支撑 #29（身份边界）的结论 | 仍需留待 #30（Catalog 所有权与持久化）决定的问题 |
| :--- | :--- | :--- |
| **作品与文件** | **作品条目（Work Entry）与本地物理文件（File）身份必须严格解耦**。<br>真实样本（`SIVR340+b`、`IPVR276-p1`）证明单部作品常存在多段/分卷文件，文件名包含分卷标签不代表作品条目分裂。 | 本地分卷文件与作品条目的关联存储模型（单表关联、多对一表结构或 JSON 阵列）。 |
| **人物身份** | **Performer 身份独立于单部作品**。<br>真实样本（`Kodama Nanami (Ogura Nanami)`）证明艺人存在跨时期别名与移籍更替，Performer 必须是可被多部作品引用的独立实体。 | 是否在本地持久化独立的 Performer Table，还是以 Work 条目内嵌入式的形式存储。 |
| **事件与日期** | **作品发行事件（Release Event）与拍摄事件（Shoot Event）解耦**。<br>Release Date 与 Shoot Date 必须独立建模，缺失时不阻塞 Library Ready。 | 派生展示年龄（Release-Age / Shoot-Age）是否落库持久化，还是纯内存计算展示（#26 倾向纯内存动态计算）。 |
| **可信度状态** | **检索候选状态（Candidate Match）与确信身份（Confirmed Identity）解耦**。<br>三方搜索结果仅为待确认候选，不能直接覆盖本地已有身份。 | 待整理素材（Quarantine/Review Queue）的具体存储与用户确认交互持久化契约。 |
| **服务与凭据** | 明确不以单一外部站点为绝对权威源。 | 是否自建 Candidate Arbiter 模块；三方 API 凭据（DMM/Stash-Box Token）的配置与管理机制。 |

---

## 6. Evidence Gaps & 后续建议 (Next Steps)

1. **存量命名分布的独立审计输入衔接**：
   - 本票（#27）仅基于工作区脚本提取的 11 部代表性困难样本验证外部工具与来源机制。关于全量素材库的历史命名分布、极端非标准命名（如纯数字 hash、无演员纯标题、无厂牌纯自制片段）与物理存储形态，已由已结单的 #28（抽样审计真实存量素材与历史命名分布）提供独立审计输入，本票不重新声称验证 #28 的全量本地数据。
2. **DMM Affiliate API 官方接入权限与无凭据降级**：
   - 官方 Affiliate API 是最干净、零反爬成本的途径，但需要有效的 `api_id` 与 `affiliate_id`。需在后续票中决定无凭据状态下的确定性离线解析降级路径。
3. **StashDB / ThePornDB API Token 策略**：
   - StashDB 与 ThePornDB 的高质量 GraphQL 接口均需 Token。后续需要明确：默认走无需鉴权的精简公开端点，还是在配置层提供可选的 API Token 注入通道。
4. **与后续 Wayfinder 票的衔接**：
   - 本报告修订版已明确区分对 #29 的身份边界输入，以及交由 #30 处理的架构实现问题，为下一阶段决策提供了收敛、严密的一手证据输入。
