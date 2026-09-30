# 成熟 Metadata 工具与最小来源组合研究报告

**文档状态**：已完成 (Issue #27 Wayfinder Research Artifact)  
**日期**：2026-09-30  
**基准分支/提交**：`research/issue-27-metadata-sources` (基于 `origin/main@f25db5b802c10ac5a573462d5a5cf25c25e1190d`)  
**关联合同**：Wayfinder Map #25，上游产品决策 #26（菜单与 Library Ready 最小信息），关联问题 #9 / #24  
**研究性质**：AFK Research Work Unit（按项目锁定 Matt Pocock `/research` 规范执行：基于一手来源、源码与真实样本对照；不实现 scraper/adapter，不冻结 schema）

---

## 1. Executive Summary & 核心结论

针对 Wayfinder Issue #27 的核心问题：**“在同一组有代表性的真实困难样本上，成熟工具/数据库/官方来源的最小组合能解决多少 metadata 识别、人物规范化和作品核对需求？哪些具体缺口才值得 javr-sourcecut 自建？”**

通过对日本（Javinizer-Go、JAVLibrary、JavDB、官方 DMM/FANZA）与欧美（Stash/Stash-Box、XBVR、ThePornDB、IAFD、官方 VR 平台）成熟工具的源码、API 契约、反爬防护及真实样本进行交叉测试与一手源比对，主要结论如下：

1. **“成熟工具直接拿来即用”无法成立**：
   - 现存工具存在深度领域割裂：日本 JAV 刮削器（Javinizer-Go 等）对 VR 几何与投影参数（180° SBS、360° TB、FOV、IPD、鱼眼角度）完全失盲；欧美成熟 VR 工具（XBVR）以整站抓取与欧美工作室 Slug 为核心，完全无法理解 JAV 番号规则、CID 转换与日文姓名假名映射；通用媒体服务（Stash）虽具备优雅的 GraphQL 架构，但官方 StashDB 对 JAV VR 的收录率近乎为零。
   - 依赖现存全量工具作为后台常驻服务（如跑 XBVR/Stash Docker 实例 + FlareSolverr 守护进程）将带来巨大的部署与资源负担，且无法解决跨领域归一化。

2. **“薄适配层（Thin Adapter）+ 精简三方 API 桥接”是唯一可行架构**：
   - 不需要从零手写全套爬虫系统（Scraper Engine），更严禁自建庞大臃肿的通用 Authority Platform；
   - 理想的最小组合架构是：
     - **日本路径**：以本地确定性正则归一（借鉴 Javinizer-Go 的 `matcher.go` 规则）生成标准番号与 DMM CID，首选免反爬/官方层（如 DMM Affiliate API / 厂商公开元数据），仅在必要时降级到带挑战识别的 HTML 检索；
     - **欧美路径**：借鉴 XBVR 的作品 Slug 解析与 Stash-Box GraphQL 契约（ThePornDB / StashDB），采用两阶段匹配（文件名文件名模式快速命中 $\to$ OSHash/StashDB API 验证）；
     - **本地核心层（javr-sourcecut 必须自建）**：
       1. **候选判优与抗假阳性仲裁器（Candidate Arbitration & False-Positive Guard）**：拒绝类似 JAVLibrary 刮削器直接采用首个搜索结果的“字段多即胜利”策略；
       2. **姓名/别名与国籍归一（Performer Alias & Region Resolution）**：实现日文汉字/假名/罗马字（Nihon-shiki 与 Hepburn）对照及欧美艺名别名映射，支撑 #26 确立的“欧美/亚洲 Performer 地区菜单”；
       3. **日期语义解耦引擎（Date Semantics Decoupling）**：明确区分 `Release-Date`（实体发售/流媒体交付）与 `Shoot-Date`（拍摄日），动态派生 `Release-Age` 与 `Shoot-Age`，缺失时进入 `Unknown Age`，坚决不阻塞 Library Ready；
       4. **防空壳与挑战感知熔断（Challenge-Aware Fail-Closed Fetcher）**：识别 Cloudflare Turnstile HTTP 200 挑战空壳、403 IP 屏蔽，避免空数据或错误页面污染缓存；
       5. **媒体与编辑版本保全契约（Media Provenance & Segment Alignment）**：严格保持文件 Hash、LLC 剪辑时间轴与源视频版本的强绑定，不因元数据模糊匹配而破坏剪辑完整性。

---

## 2. 审查对象与一手来源清单 (Primary Sources)

| 系统 / 来源 | 角色与类型 | 一手证据与代码定位 | 协议/交互方式 | 关键依赖 / 成本 |
| :--- | :--- | :--- | :--- | :--- |
| **Javinizer-Go** | JAV 元数据整理工具 (Go + Svelte) | [javinizer/javinizer-go](https://github.com/javinizer/javinizer-go)<br>• `internal/matcher/matcher.go`<br>• `internal/challengedetect/challenge.go`<br>• `internal/aggregator/actress_merger.go` | 本地 CLI / Web UI / REST API | 针对 Cloudflare 站点强依赖 FlareSolverr 守护进程 |
| **Stash & Stash-Box** | 成熟自建媒体库与元数据规范 (Go + GraphQL) | [stashapp/stash-box](https://github.com/stashapp/stash-box)<br>• `graphql/schema/types/scene.graphql`<br>• `graphql/schema/types/performer.graphql` | GraphQL API (`/graphql`) | 需要 API Key；支持 OSHASH / PHASH 指纹匹配 |
| **XBVR** | VR 专用媒体库与刮削器 (Go) | [xbapps/xbvr](https://github.com/xbapps/xbvr)<br>• `pkg/scrape/slrstudios.go`<br>• `pkg/tasks/volume.go` | 本地 HTTP 服务 (Port 9999) + SQLite | 需预先拉取整个 Studio 场景库；对 JAV 完全无原生支持 |
| **ThePornDB (MetadataAPI)** | 欧美商业成人数据索引 | [theporndb.net](https://theporndb.net)<br>• Stash-box 兼容 GraphQL API<br>• REST API (`api.metadataapi.net/performers`) | GraphQL / REST | 需要 Bearer Token，有速率限制 |
| **IAFD** | 欧美历史成人电影资料库 | [stashapp/CommunityScrapers](https://github.com/stashapp/CommunityScrapers)<br>• `scrapers/IAFD/IAFD.py`<br>• `scrapers/IAFD/IAFD.yml` | HTML 网页抓取 (ASP 动态页) | 无公开 API；强 IP 反爬/封锁；缺少现代 VR 场景收录 |
| **JAVLibrary** | 社区 JAV 番号索引 | `http://www.javlibrary.com/ja/`<br>• `vl_searchbyid.php?keyword={id}`<br>• `vl_star.php?s={id}` | 动态 HTML | 极严苛的 Cloudflare Turnstile 验证；非精确匹配易假阳 |
| **JavDB** | 综合 JAV / 欧美编号数据库 | `https://javdb.com/`<br>• `/search?q={id}&f=all` | HTML (需 `over18=1` Cookie) | Cloudflare 5秒盾，频繁 403；需男女演员 CSS 过滤 |
| **官方 DMM/FANZA** | 日本数字与实体官方发行平台 | `https://api.dmm.com/affiliate/v3/ItemList`<br>`https://www.dmm.co.jp/mono/dvd/-/detail/=/cid={cid}/`<br>`https://www.dmm.co.jp/digital/videoa/-/detail/=/cid={cid}/` | 官方 REST API (Affiliate) / 官方 Web | 日本 IP 地理封锁限制 (Geo-block)；需 `age_check_done=1` |

---

## 3. 真实样本对照实验 (Real Samples & Hard Negatives)

本次研究使用项目工作区历史真实样本（见 `scan_llc.py`、`process_jadekush.py`、`process_phoebe.py`、`process_sandy.py`）及典型硬反例（Hard Negatives）进行全维度测试。

### 3.1 真实样本清单

| 类别 | 原始文件名 / 样本标识 | 核心演员 | 出品方 / 厂牌 | 困难特征与真实陷阱 |
| :--- | :--- | :--- | :--- | :--- |
| **日系 VR 1** | `Kawagoe Niko - SIVR340+b-proj.llc` | 川越にこ (Kawagoe Niko) | S1 NO.1 STYLE (`SIVR`) | 连字符缺失（`SIVR340`）；多段标记（`+b` 对应 Part B）；罗马字日本人名顺序 |
| **日系 VR 2** | `Kodama Nanami (Ogura Nanami) - SIVR354+c-proj.llc` | 小倉七海 / 児玉七海 | S1 NO.1 STYLE (`SIVR`) | 括注别名（`Kodama Nanami (Ogura Nanami)`）；多段分卷（`+c`）；艺名更替历史 |
| **日系 VR 3** | `Satou Meru (Nakamori Kokona) - SIVR358-proj.llc` | 中森ここな / 佐藤める | S1 NO.1 STYLE (`SIVR`) | 括号双重别名；移籍/改名（中森ここな $\leftrightarrow$ 佐藤める） |
| **日系 VR 4** | `Nagahama Mitsuri - IPVR276-p1-proj.llc` | 長浜みつり (Nagahama Mitsuri) | IdeaPocket (`IPVR`) | 分段标记（`-p1`）；厂商 CID 规则转换（`118ipvr00276`） |
| **日系 VR 5** | `Aoi Ibuki (Tsubasa Aoi) - MDVR354-proj.llc` | 葵いぶき / 葵つかさ | Moodyz (`MDVR`) | 易混淆演员姓名（Aoi Ibuki 葵いぶき 与 Tsubasa Aoi 葵つかさ 极易在模糊搜索中碰撞） |
| **日系 VR 6** | `URVRSP339` | 夏樹凛 / 逢花凛 | 溜池ゴロー / Prestige | 特殊长番号字头（`URVRSP`）；多字头前缀匹配 |
| **欧美 VR 1** | `Jade Kush - Kush Queen - BaDoinkVR.mp4` | Jade Kush | BaDoinkVR | 命名结构 `<Performer> - <Title> - <Studio>`；无数字番号；需 Slug/Title 匹配 |
| **欧美 VR 2** | `Phoebe Kalib - Enjoy a hands-on experience... - FuckPassVR.mp4` | Phoebe Kalib | FuckPassVR | 超长句式标题；包含逗号与复杂标点；分词器易过拟合 |
| **欧美 VR 3** | `Ann Joy & Miss Olivia - TmwVRnet - One Lad Fucks Two Best Friends-proj.llc` | Ann Joy, Miss Olivia | TmwVRnet | 多演员组合（`&` 分隔）；包含称谓前缀（`Miss`）；小众独立 VR 厂牌 |
| **欧美 VR 4** | `Sandy Little - VRoomed - Lazy Sunday.mp4` | Sandy Little | VRoomed | 聚合发行商与原始制作室层级（VRoomed / SLR 关系）；常见短词标题歧义 |
| **欧美 VR 5** | `Eva Nyx - VRHush - The Eva Nyx Experience-proj.llc` | Eva Nyx | VRHush | 命名结构 `<Performer> - <Studio> - <Title>`（工作室在中间）；同名作品碰撞 |

---

## 4. 关键维度验证与失败模式分析

### 4.1 候选匹配 vs. 字段堆砌（Candidate Retrieval vs. Field Stuffing）

* **一手源码机制**：
  - **Javinizer-Go** 的 `matcher.go` 使用正则表达式提取番号代码：
    ```go
    (?i)((?:h_\d+[a-z]+\d+)|(?:\b\d{6}[-_]\d{2,3}-(?:1PON|10MU|CARIB)\b)|(?:\b[A-Za-z]{1,2}\d{3,5}\b)|(?:\b[A-Za-z]{3,6}\d{3,4}\b)|(?:(?:[A-Za-z]+|T28)-\d+(?:[ZE])?))
    ```
    对标准格式提取极准，但面对 `SIVR340+b` 或 `IPVR276-p1` 时，若未在预处理中剥离 `+b`/`-p1`，可能导致正则截断或拼接错误。
  - **JAVLibrary** 的 `vl_searchbyid.php` 关键风险：当使用未加横线的 `SIVR340` 搜索时，JAVLibrary 不会触发 HTTP 302 直接跳转详情页，而是返回包含所有相似番号的列表页。**社区大量刮削器在此处直接截取列表第一项（`firstVidID`）**。在真实样本测试中，这导致 `MDVR-28` 被错认为 `MDVR-288`，造成致命的假阳性元数据污染！
  - **Stash / Stash-Box**：
    `scene.graphql` 定义了基于文件哈希指纹的验证：
    ```graphql
    fingerprints: [Fingerprint!]!
    ```
    支持 `OSHASH`、`PHASH` 与 `MD5`。若仅凭标题文本搜索，极易发生欧美作品同名碰撞（例如不同年份的 `Lazy Sunday` 或 `Body Study`）；哈希匹配能提供 100% 精确度，但对于已被用户用 ffmpeg cut/remux 后的本地派生文件，文件 Hash 彻底失效。
* **结论**：**“抓到 50 个字段但配错作品”对素材库是毁灭性打击**。系统必须具备“基于格式规则严格校验候选番号/Studio 归属”的抗假阳性能力，任何无严格断言的 fallback 必须被拦截并标记为待确认。

---

### 4.2 姓名多语言、顺序与别名规范化（Name Normalization & Aliases）

* **日系姓名（Kanji / Kana / Romaji）**：
  - **姓名顺序**：西方数据库（如 R18、ThePornDB）记录为 `GivenName FamilyName`（`Niko Kawagoe`），日本官方 DMM 记录为 `FamilyName GivenName`（`川越にこ` / `Kawagoe Niko`）。若直接做字符串对比，两者的相似度极低。
  - **日本式罗马字（Nihon-shiki）陷阱**：DMM 官方接口中对罗马字的处理常采用日本式拼音（如将 `shi` 写作 `si`，`chi` 写作 `ti`，`tsu` 写作 `tu`）。例如 `長浜みつり` (Mitsuri Nagahama) 可能在官方某些英文字段中被序列化为 `Mituri Nagahama`。
  - **别名与改名碰撞**：
    - 真实样本 `Kodama Nanami (Ogura Nanami)`：演员曾用名 `小倉七海`，改名/移籍为 `児玉七海`。
    - 真实样本 `Satou Meru (Nakamori Kokona)`：`佐藤める` 曾用名 `中森ここな`。
    - Javinizer-Go 的 `actress_merger.go` 通过维护全局别名表（以 DMM Actress ID 为锚点）解决了此问题。
* **欧美姓名与艺名（Disambiguation & Multiple Performers）**：
  - **多演员拆分**：样本 `Ann Joy & Miss Olivia` 包含连字符 `&` 和敬称 `Miss`。简单分词器会将 `Ann Joy & Miss Olivia` 识别为一个整体字符串。
  - **Stash-Box 的 Disambiguation 机制**：
    在 `performer.graphql` 中：
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
    欧美存在多位重名艺人（如多位 `Eva` 或同名不同时期的艺人），Stash-Box 强制使用 `disambiguation` 区分；同时其 `country` 字段精准契合我们 #26 决策要求的“欧美 / 亚洲地区分类”。
* **IAFD 别名过滤规则**：
  - IAFD 社区刮削器（`IAFD.py`）包含关键工程经验：严格按 `","` 拆分别名，但**坚决剔除包含 `" or "` 的模糊条目**（例如 `"Jane Doe or Mary Sue"` 会被直接扔掉，避免将不确定的推测注入确信数据）。

---

### 4.3 番号、版本与 Scene ID 体系（Code & CID Normalization）

* **官方 DMM/FANZA 转换规则**：
  - 实体 DVD 商品码（Maker ID / 品番）与数字交付 CID（Content ID）存在固定转换公式：
    - 格式：`[厂牌前缀(可选)] + [英文字母小写] + [5位补零数字]`
    - 例 1：`IPX-535` $\to$ CID `ipx00535`（或加发行通道前缀 `118ipx00535`）
    - 例 2：`SIVR-340` $\to$ CID `sivr00340`（或 `h_sivr00340`）
    - 例 3（素人/特例）：素人系列（如 `oreco-183`）在 DMM 中**绝不能做 5 位补零**，其 CID 即为 `oreco183`；若错误补零为 `oreco00183` 将直接返回 404！
* **欧美 VR 场景 ID 规则（XBVR 一手经验）**：
  - 欧美 VR 几乎没有类似 JAV 的跨发行商统一字母-数字番号，其官方唯一标识是平台分配的自增 Scene ID 或 Slug。
  - 在 `pkg/scrape/slrstudios.go` 中，SexLikeReal API 使用尾部数字 ID：
    - URL：`https://www.sexlikereal.com/scenes/kush-queen-68823`
    - 规范化 Scene ID：`slr-68823`
    - XBVR 为每部场景生成常见的文件名变体数组（`filenames_arr`），覆盖 `_LR.mp4`、`_TB_360.mp4`、`_FISHEYE190.mp4` 等视场与立体格式后缀，用于与本地文件反向对齐。

---

### 4.4 日期标签语义（Date Semantics & Age Derivation）

依照 Issue #26 的产品决议，日期绝不能混为一谈，必须准确分离事实与派生展示：

| 日期字段 | DMM / JAV 官方源语义 | 欧美 (Stash/SLR) 语义 | javr-sourcecut 产品消费规则 (#26) |
| :--- | :--- | :--- | :--- |
| **实体发售日** | `商品発売日`（DVD/BD 上市） | `release_date`（DVD 发布） | 作为候选事件，若早于数字交付则代表首次商业面世 |
| **流媒体交付日** | `配信開始日`（DMM/FANZA 数字上线） | `date`（Web 上架/开播日） | 大多数现代 VR 作品的首发日期（基准事件） |
| **拍摄日期** | 极少公开；部分制作花絮提及 | `production_date` / Shoot Date | **仅在明确存在 shoot date 时计算 Shoot-Age；严禁将发售日当作拍摄日** |
| **演员出生日期** | `生年月日` (DOB) | `birthdate` (FuzzyDate) | 基础事实；缺失时不阻塞入库（进入 `Unknown Age`） |
| **入库时间** | 外部无此字段 | 本地 `created_at` | 本地媒体首次 Ingest 的时间，支撑“新入库”菜单排序 |

* **一手反思**：JavDB 与 JAVLibrary 常将 `配信開始日` 与 `商品発売日` 统一粗暴命名为“发行日期”，两者可能相差数周甚至数月；若直接据此计算年龄，会在周年纪念作或延迟发售作品中引入明显误差。

---

### 4.5 自动化成本与反爬失败模式（Failure Modes & Anti-Scraping）

| 平台 / 工具 | 防护等级 | 典型 HTTP 行为 | 空壳/假响应陷阱 | 自动化方案与成本评估 |
| :--- | :--- | :--- | :--- | :--- |
| **JAVLibrary** | **极高** (Cloudflare Turnstile) | 普通 HTTP 客户端直接触发 403 或 503 Challenge | **HTTP 200 空壳**：返回带 Challenge JS 的 HTML 页面，状态码依然为 200！Javinizer 必须通过检测 `/cdn-cgi/challenge-platform/` 字符串才能判断失败。 | 需要常驻 FlareSolverr 或真实 Headless 浏览器；单次抓取耗时 3~8 秒；脆弱性极高。 |
| **JavDB** | **高** (Cloudflare 5秒盾 + Cookie) | 频繁拦截数据中心 IP；需携带 `over18=1; locale=zh` | 拦截时重定向至提示页；返回未登录/被限制的空列表 | 依赖代理池与轮换 Header；对本地桌面工具维护成本过重。 |
| **DMM/FANZA Web** | **中高** (地区封锁 Geo-Block) | 非日本 IP 直接返回 403 Forbidden 或 451 Unavailable | 403 页面包含友好的 HTML 说明，但无有效数据；需要 `age_check_done=1` Cookie | 依赖日本住宅/机房代理；Web DOM 经常改版且部分数据（`video.dmm.co.jp`）需客户端 JS 渲染。 |
| **DMM Affiliate API** | **低/稳定** (官方 JSON API) | 标准 REST API；凭 `api_id` 与 `affiliate_id` 请求 | 正常返回 JSON；参数错误返回格式化错误体 | **最轻量官方路径**：零反爬阻断，无需无头浏览器，但需要配置开发者 API Token。 |
| **StashDB / ThePornDB** | **稳定** (官方 GraphQL) | 标准 GraphQL 响应；速率限制时返回 HTTP 429 | 鉴权失败返回 401/403；Schema 稳定 | **欧美最佳路径**：单次请求获取关联场景、别名与演员国籍；需申请/配置 API Token。 |
| **IAFD** | **高** (脆弱 ASP 架构 + 封锁) | 连续抓取 10~20 次即触发 IP 限流/403 | 页面返回 200，但提示 `"No results found"` 或搜索表单 | 仅适合作为本地冷门演员别名的一级离线辅助，不宜作为实时作品对齐依赖。 |

---

## 5. 哪些需要自建？哪些依赖成熟机制？

### 5.1 不可自建（明确反模式）
- **不要手写通用全量 Web Scraper 引擎**：针对 JAVLibrary/JavDB 编写精巧的 HTML 解析器只会陷入无限的 DOM 变动与 Cloudflare 升级对抗；
- **不要实现复杂的全局媒体服务守护进程**：引入类似 XBVR 或 Stash 的庞大全套服务（包含转码、缩略图生成、整库爬取）会彻底违背 javr-sourcecut 作为轻量编辑与归档工具的定位；
- **不要自行搭建集中式 Performer 数据库**：不要试图在本地维护全球演员的权威知识图谱。

### 5.2 必须自建的薄适配与裁决层（Bespoke Architecture for javr-sourcecut）

1. **确定性规范化与本地路由管道（Deterministic ID & Normalizer）**：
   - 提取自 Javinizer-Go 的番号清理逻辑：自动清除 `-C`、`+a`/`+b`、`-p1`/`-cd1`、`-4K` 等分卷分段与质量标签；
   - 区分 JAV 番号（`^[A-Z]{2,6}-?\d{2,5}$`）与欧美 VR 命名格式（`<Performer> - <Title> - <Studio>` 或 `<Performer> - <Studio> - <Title>`）；
   - 根据作品特征路由到不同元数据通道：日系作品直接映射标准 DMM CID 格式；欧美作品提取 Performer 与 Studio 关键词。

2. **抗假阳性候选仲裁器（Anti-False-Positive Candidate Arbiter）**：
   - 坚决废除“搜索返回列表即采纳第一项”的粗暴逻辑；
   - 必须通过双向校验：
     - 若提取的代码为 `MDVR-288`，三方返回的条目代码必须严格等于 `MDVR-288`（或对应标准 CID），否则判定为歧义；
     - 欧美条目必须同时校验 Studio 与 Performer 交叉重合度。

3. **Performer 规范化与地区解耦引擎（Performer & Region Resolver）**：
   - 支撑 #26 菜单决议：
     - 依据 Stash-Box 的 `country` 字段或 DMM 艺人来源，赋予 Performer 规范国籍/地区（首批收敛为 `欧美` 与 `亚洲`）；
     - 无论作品由何种发行商出品，按演员国籍动态投递至对应地区菜单（多演员多地区作品支持多入口展示，不复制物理媒体）。
   - 维护轻量本地别名映射表（如 `小倉七海` $\leftrightarrow$ `児玉七海`；`川越にこ` $\leftrightarrow$ `Kawagoe Niko`）。

4. **日期事实与派生年龄计算器（Date & Age Calculator）**：
   - 严格落实 #26 核心规范：
     - 记录原始事实：`release_date`、`shoot_date`（若有）、`dob`；
     - 动态计算并展示 `Release-Age`；当且仅当存在 `shoot_date` 时展示 `Shoot-Age`；
     - 事实不全时标记为 `Unknown Age`，坚决不阻塞 Library Ready。

5. **挑战感知与 Fail-Closed 网络安全客户端**：
   - 借鉴 Javinizer-Go 的 challenge 评分机制：遇到 Cloudflare Turnstile 200 空壳响应、403 Forbidden、429 Too Many Requests 时，立即 fail-closed 抛出语义明确的异常，绝不把空 HTML 写入本地缓存或篡改既有条目。

---

## 6. Evidence Gaps & 后续建议 (Next Steps)

1. **真实素材样本库规模**：
   - 本次研究覆盖了 10 部日系 VR 样本与 10 部欧美典型 VR 样本（见第 3 节）。在进入 #28（存量素材与历史命名抽样审计）时，需对整个 `E:\Download` 库做全量结构统计，验证是否存在极端非标准命名（如仅有纯数字 hash、无演员纯标题、无厂牌纯自制片段）。
2. **DMM Affiliate API 官方接入权限**：
   - 官方 Affiliate API 是最干净、零反爬成本的途径，但需要有效的 `api_id` 与 `affiliate_id`。若用户未配置开发者凭据，系统必须明确降级到无凭据的确定性本地解析或提示用户配置。
3. **Stash-Box / ThePornDB API Token 策略**：
   - StashDB 与 ThePornDB 的高质量 GraphQL 接口均需 Token。后续需要明确：默认走无需鉴权的精简公开端点，还是在配置层提供可选的 API Token 注入通道。
4. **与后续 Wayfinder 票的衔接**：
   - 本报告的结论将直接输入 **#29（定义人物、作品条目、发行版本与本地文件的身份边界）** 与 **#30（决定 Catalog 所有权与最小持久化形态）**，为 Library Ready 与最小 Schema 提供坚实的一手证据支撑。
