# AstalaVR Source Capability Boundary Research

> **Target Issue**: [#3 Turn AstalaVR reconnaissance into a source capability boundary](https://github.com/carllx/javr-sourcecut/issues/3)  
> **Research Branch**: `research/astalavr-capability-boundary`  
> **Primary Evidence**: [`docs/research/evidence/astalavr-pO1k7-probe.md`](./evidence/astalavr-pO1k7-probe.md)  
> **Status**: Rework Complete / Ready for Browser Lead Review  
> **Evidence Classification**: `[VERIFIED]` / `[REPORTED]` / `[INFERRED]` / `[UNKNOWN]`

## 1. Executive Summary & Objective

本调研的目标是将 AstalaVR 的侦察证据与受控实验结果转化为一份严格定级的 Source Capability Boundary，为 `javr-sourcecut` 的核心架构决策提供依据。

### 核心定界原则
1. 平台特有的页面/会话/Token 机制与跨平台的 MP4 Range/切片机制分开。
2. 这里只定义能力与边界，不预设最终类名或实现结构。
3. `[VERIFIED]` 仅用于当前 repo 中可复核的一手证据直接支持的事实；历史抽样为 `[REPORTED]`；跨平台抽象为 `[INFERRED]`；待实现验证点为 `[UNKNOWN]`。
4. 只做受控 probing；不下载完整视频，不研究 DRM 或访问控制绕过。

## 2. Primary Reproducible Evidence Base

当前直接证据是 [`docs/research/evidence/astalavr-pO1k7-probe.md`](./evidence/astalavr-pO1k7-probe.md)：

- Sample ID: `pO1k7`
- Player: Delight VR `<dl8-video>`，`format="STEREO_180_TB"`, `fps="30"`
- Quality list: `720P`, `1080P`; highest declared quality `1080P`
- Transport: `HTTP 206 Partial Content`, `Content-Range: bytes 0-5242879/531002202`, 5 MiB transferred under 8 MiB cap
- FFprobe: H.264 High `2160x2160 @ 30fps`; AAC LC stereo; duration about 1698s
- DRM observation: no EME/license flow on this sample only
- Session observation: non-browser probe returned 403 while browser-mediated access with the tokenized media URL succeeded; exact Cookie/Referer binding remains unknown

## 3. Capability Boundary Matrix

### 3.1 ASTALAVR-SPECIFIC

| Capability | Evidence | Boundary |
| --- | --- | --- |
| Page Resolver | `[VERIFIED]` | Resolve AstalaVR page URL and page/video metadata in browser context. |
| Player / Source Discovery | `[VERIFIED]` | Read `<dl8-video>` and the quality/source declarations actually exposed by the page. |
| Quality Inspector | `[VERIFIED]` on `pO1k7`; broader catalog `[REPORTED]` | Do not equate label with coded dimensions and do not guess undeclared qualities. |
| Browser-mediated session / anti-bot handling | `[VERIFIED]` on `pO1k7` | Source-side responsibility to obtain a currently usable media access context. Exact header/cookie requirements remain unknown. |
| Ephemeral media URL lifecycle | `[VERIFIED]` | Tokenized media URL is runtime access data, not durable source identity. |
| Token acquisition / refresh | `[UNKNOWN]` for runtime semantics | Adapter must be able to reacquire media access, but exact expiry/refresh contract is not yet proven. |

### 3.2 POSSIBLE SHARED SEAM

| Capability | Evidence | Boundary |
| --- | --- | --- |
| Normalized Source Identity | `[INFERRED]` | Shared model should retain provider + durable provider locator; tokenized URL is not identity. |
| Edit Decision / Time Ranges | `[INFERRED]` cross-source, supported by PikPak audit | Core should consume normalized time ranges; LLC remains an input-format adapter. |
| Direct MP4 Bounded Probe | `[VERIFIED]` on AstalaVR sample | A resolved direct MP4 can be probed with bounded Range/ffprobe. |
| HTTP Range transport | `[VERIFIED]` on AstalaVR sample | Direct MP4 transport can use standard 206/Content-Range semantics after source-specific access resolution. |
| Transfer budgeting | `[INFERRED]` cross-source, PikPak implementation already verified | Candidate shared control; AstalaVR-specific limits/headers are not assumed. |
| Concurrency controls | `[INFERRED]` | Candidate shared control; provider/CDN limit is still unknown. |
| FFmpeg segment extraction | `[INFERRED]` for AstalaVR compatibility; PikPak implementation verified | Likely shared once a seekable Direct MP4 handle is available, but `pO1k7` probe did not itself perform segment extraction. |
| Output verification | `[INFERRED]` for AstalaVR compatibility; PikPak implementation verified | Likely shared, but AstalaVR-specific end-to-end output validation remains implementation-stage evidence. |

### 3.3 UNKNOWN / NEEDS HOOK

- Exact header/session propagation across processes and external FFmpeg workers.
- Token expiry during long or repeated segment pulls and refresh/retry semantics.
- CDN Range granularity, rate limiting and safe concurrency defaults.
- Multi-range/resumability behavior.
- Catalog-wide source uniformity; historical sampling remains `[REPORTED]`.
- HLS/DASH/DRM handling: unsupported cases must fail safely; no bypass design.

## 4. Cross-Source Boundary Conclusion

1. **Source resolution is provider-specific.** AstalaVR resolves from page/browser/token context; PikPak resolves from Share/API/authenticated transport.
2. **The durable identity must be separated from ephemeral media access.** A page/video ID or file ID can persist; signed media URLs/tokens cannot.
3. **Direct MP4 probing and HTTP Range are genuinely shared candidates.** Both platforms have evidence supporting a seam after source-specific resolution.
4. **Budget, concurrency, FFmpeg extraction and output verification remain shared-core candidates, not yet universal truths.** PikPak provides verified implementation evidence; AstalaVR compatibility beyond bounded MP4 probing is still an architectural inference to be tested during implementation.

## 5. Gate

Issue #3 has enough evidence to answer its capability-boundary question. Remaining runtime unknowns belong in implementation hooks/fog, not in additional reconnaissance before Issue #4.