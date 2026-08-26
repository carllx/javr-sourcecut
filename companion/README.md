# Eporner Browser Companion

> 用于 Eporner 页面的 4K+ 候选视频筛选与 AV1 格式能力探测轻量 Tampermonkey 油猴脚本。

---

## 1. 工具定位 (What it is)

**Eporner Browser Companion** 是运行在浏览器前端的辅助扩展脚本，用于加速与简化 Eporner 上的候选高画质视频查找：
- **4K+ 候选视频硬筛选 (Hard Filter)**：在客户端直接将低于 4K (2160p) 的视频卡片从 DOM 永久移除，仅保留 4K+ 候选视频。
- **AV1 格式能力异步探测 (AV1 Format Probing)**：在后台并发探测剩余 4K+ 候选视频的详情页，提取是否包含 AV1 rendition 以及最高 AV1 分辨率（例如 2160p / 1080p）。
- **「只看 AV1」持续软筛选 (Soft Filter & Continuous View State)**：一键临时隐藏确认无 AV1 (NO AV1) 的视频；未探测完成 (Pending/Probing) 或探测异常 (Error/Unknown) 的卡片保持乐观可见 (Optimistic Visibility)。**Only-AV1 为持续视图状态，即使在探测进行中提前开启，后续异步探测确认为 NO AV1 的卡片也会自动隐藏，无需二次点击。**

> [!NOTE]
> **非下载工具**：Browser Companion **不包含** 视频下载、FFmpeg 剪辑或取代 SourceCut 核心 CLI/daemon 的功能。它专注于浏览器前端的视频候选筛选与格式探测。

---

## 2. 安装方法 (Installation)

### 前置要求
- Chrome、Edge、Firefox 或任何主流 Chromium 内核浏览器；
- 已安装并启用 [Tampermonkey (油猴插件)](https://www.tampermonkey.net/)。

### 正式安装地址
直接在 Tampermonkey 中打开并安装生产版用户脚本：
- [https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js](https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js)

*(注：在开发与 PR 验收阶段，可临时安装 feature 分支构建产物，但后续长期更新来源固定为 `main` 分支。)*

---

## 3. 推荐使用流程 (Recommended Usage)

### 推荐使用入口
查找 VR 及超高清视频时，推荐直接进入带有 Eporner 原生最高画质筛选的页面：
- [https://www.eporner.com/cat/vr-porn/?quality=2160](https://www.eporner.com/cat/vr-porn/?quality=2160)

### 工作机制
1. **带有 `quality=2160` 的页面 (原生 4K 预过滤)**：
   - Companion 初始化时自动识别 URL 参数中的 `quality=2160`；
   - 悬浮工具栏显示 `✓ Eporner 4K+`（无需用户手动点击）；
   - 本地 4K 解析器自动作为防漏兜底 (Leakage Guard)，移除意外漏入的 `<4K` 卡片；
   - 自动启动 AV1 探测生命周期，并结合视口监听 (IntersectionObserver) 优先探测当前可见卡片。
2. **普通页面 (无 `quality=2160`)**：
   - 默认保留所有卡片可见；
   - 用户点击悬浮工具栏中的 **`[筛选 4K+]`** 按钮，单向永久移除 `<4K` 卡片，并开始对剩余 4K+ 卡片进行 AV1 探测。
3. **开启 `[只看 AV1]`**：
   - 随时点击开启。已确认无 AV1 的卡片立即隐藏；
   - 正在探测中、排队中或报错的卡片保持显示；
   - 随后新探测完成并判定为 NO AV1 的卡片会自动追加隐藏。

---

## 4. 工具栏与状态徽章语义 (Toolbar & Badge Semantics)

### 悬浮工具栏 (Floating Toolbar)

| 控件 / 显示项 | 语义说明 |
| :--- | :--- |
| **`✓ Eporner 4K+`** | 已识别 URL 中的原生 4K 过滤 (`quality=2160`)；Hard Filter 与 AV1 探测已自动激活。 |
| **`[筛选 4K+]`** | 普通页面的单向激活按钮。点击后永久删除 `<4K` DOM 卡片并启动 AV1 探测。 |
| **`[只看 AV1]`** | 软筛选持续切换按钮。激活后隐藏已确认 NO AV1 的卡片（具有持续视图状态）。 |
| **`4K: N`** | 当前页面保留的 4K+ 候选视频数量。 |
| **`AV1: X (Y 4K)`** | 确认具备 AV1 的视频总数 (`X`) 与其中具备 4K (2160p) AV1 的视频数 (`Y`)。 |
| **`探测: N`** | 当前正在排队或进行后台探测的卡片数量。 |
| **`失败: N`** | 自动重试耗尽后仍探测失败的卡片数量。 |

### 卡片格式徽章 (Card Format Badges)

| 徽章文本 | 样式 / 颜色 | 语义说明 |
| :--- | :--- | :--- |
| **`4K · AV1 4K`** | 金绿渐变 | 视频为 4K+，且确认提供 **2160p (4K) AV1** 流。 |
| **`4K · AV1 1080p`** | 蓝色渐变 | 视频为 4K+，但 AV1 流最高仅到 **1080p**。 |
| **`4K · NO AV1`** | 灰色暗底 | 详情页已探测完毕，确认**无任何 AV1** 流（仅 H.264/WebM）。 |
| **`4K · ⏳`** | 呼吸闪烁青色 | 正在后台异步请求并解析详情页。 |
| **`4K · ⚠️ 重试`** | 红色高亮 (可点击) | 网络异常或解析失败。点击徽章可立即手动重试探测。 |

---

## 5. 缓存机制 (Cache)

- **探测能力缓存**：已确认的格式结果（`detected` 与 `no_av1`）会持久化保存至 Tampermonkey 存储 (`GM_setValue` / `GM_getValue`)；
- **缓存有效期 (TTL)**：7 天 (604,800,000 ms)。过期记录会在再次浏览时重新探测；
- **错误永不误存**：`error` 与 `unknown` 状态**绝不会**被持久化为 `no_av1`，确保临时网络抖动可在刷新或重试时恢复。

---

## 6. 自动化更新机制 (Automatic Updates)

生产版脚本内嵌了 Tampermonkey 标准元数据头：
```javascript
// @updateURL   https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js
// @downloadURL https://raw.githubusercontent.com/carllx/javr-sourcecut/main/userscripts/eporner-companion.user.js
```
- Tampermonkey 会定期根据 `@updateURL` 检查 `main` 分支上的 `@version`；
- 正式发布提升 `@version` 后，用户浏览器将自动接收更新提示并无缝升级，无需重新手动复制粘贴代码。

---

## 7. 已知警告说明 (Known Warnings)

### Chromium 关于媒体移除的 AbortError 警告
在打开浏览器开发者工具 (F12 Console) 时，可能会观察到如下报错信息：
```text
Uncaught (in promise) AbortError: The play() request was interrupted because the media was removed from the document.
```

#### 原因分析与判定
- **触发机理**：Eporner 页面原生脚本会在缩略图加载或鼠标悬停时触发异步 `HTMLMediaElement.play()` 视频预览请求。当 Companion 的 Hard Filter 将低于 4K 的卡片从 DOM 永久移除时，被移除节点的 pending `play()` promise 会被 Chromium 引擎正常中断并抛出 `AbortError`。
- **判定标准**：在满足以下所有条件时，该现象确认为**非阻塞良性警告 (benign non-blocking warning)**：
  1. 页面保留的 4K 视频卡片悬停与点击播放功能完全正常；
  2. Companion 工具栏、徽章与 AV1 探测正常工作；
  3. 页面无持续性功能性中断或报错。

> [!IMPORTANT]
> **架构设计原则**：不得为了消除该 Console 警告而将 Hard Filter 降级为软隐藏，也不得在全局捕获吞掉 `unhandledrejection`。如未来发现保留视频出现实际播放异常，再针对性单独立项排查。

---

## 8. 常见问题排查 (Troubleshooting)

| 异常现象 | 可能原因 | 解决办法 |
| :--- | :--- | :--- |
| **悬浮工具栏未出现** | 油猴插件未启用或当前页面 URL 不在匹配范围内。 | 检查 Tampermonkey 扩展是否已启用，确认网址匹配 `*://*.eporner.com/*`。 |
| **卡片长时间处于 `⏳` 或 `⚠️ 重试`** | 本地网络连接受限或遇到临时限流。 | 探测器具备并发限制 (2) 与自动退避机制（最多 2 次）。可检查网络，或直接点击红色的 `4K · ⚠️ 重试` 徽章触发手动重试。 |
| **点击安装链接直接显示纯文本** | 浏览器未关联 `.user.js` 到 Tampermonkey。 | 打开 Tampermonkey 管理面板 -> *实用工具 -> 从 URL 安装*，粘贴 raw 地址并点击安装。 |
| **如何区分良性 `AbortError` 与真故障** | 控制台抛错类型不同。 | 包含 `media was removed from the document` 的 `AbortError` 为卡片移除引起的良性提示；若出现 `GM_xmlhttpRequest`、`TypeError` 或解析异常，则属于需修复的程序缺陷。 |
