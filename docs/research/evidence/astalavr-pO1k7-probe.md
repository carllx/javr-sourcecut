# AstalaVR Probe Evidence: Sample `pO1k7`

> **Sample Page ID**: `pO1k7`  
> **Timestamp (UTC)**: `2026-08-21T15:23:00Z`  
> **Target Page URL**: `https://astalavr.com/videos/pO1k7/...` (Sanitized)  
> **Scope**: Primary reproducible evidence for Issue #3 source capability boundary.

---

## 1. Page & Player Discovery

- **Page Title**: `Super Luxury Yukata Massage Parlor Where Charming Japanese Beauties With Colossal Tits Service You | AstalaVR`
- **Player Element**: Delight VR `<dl8-video>`
- **Observed DL8 Attributes**:
  - `format`: `STEREO_180_TB` (Stereo 180° Top-Bottom)
  - `fps`: `30`
  - `aspect`: `1080:610`
  - `display-mode`: `inline`
  - `poster`: `https://cdn2.astalavr.com/pO1k7/poster_mini.jpg`
  - `data-poster-full`: `https://cdn2.astalavr.com/pO1k7/poster.jpg`
  - `dl8-element-id`: `dl8--34622395888`
  - `dl8-id`: `12d06f30-b8c4-4823-b4da-95a1c1c0343d`
- **Observed Quality Labels in DOM**:
  - `720P` (CDN URL path: `/pO1k7/720P.mp4`)
  - `1080P` (CDN URL path: `/pO1k7/1080P.mp4`)
- **Selected Quality for Probing**: `1080P` (Highest declared quality on this page)

---

## 2. Media Transport & Bounded Range Probe

- **Sanitized Media URL**: `https://cdn3.astalavr.com/pO1k7/1080P.mp4?cb=3&token=[REDACTED]`
- **Media Host**: `cdn3.astalavr.com`
- **Media Path**: `/pO1k7/1080P.mp4`
- **HTTP Status**: `206 Partial Content` (No fallback to HTTP 200)
- **Response Headers**:
  - `content-range`: `bytes 0-5242879/531002202`
  - `accept-ranges`: `bytes`
  - `content-length`: `5242880`
  - `content-type`: `video/mp4`
  - `server`: `cloudflare`
  - `etag`: `"0b10c7c2363c193a5327f4eaa03c097f-11"`
  - `access-control-allow-origin`: `https://astalavr.com`
- **Total Full File Size**: `531,002,202 bytes` (~506.40 MiB)
- **Actual Bytes Transferred**: `5,242,880 bytes` (5.00 MiB, strictly within 8 MiB hard cap)

---

## 3. Session & Header Propagation Observation

- **Direct Non-Browser Probe (No Cloudflare clearance)**: Returns `HTTP/1.1 403 Forbidden`.
- **Authorized Browser Session**: Inside the authorized browser session, Cloudflare clearance cookies and token allow HTTP 206 Partial Content streaming and chunked retrieval.
- **Transport Requirement Summary**: Media URL token is tied to short-lived browser session credentials managed by Cloudflare protection.

---

## 4. DRM / EME Inspection

- **EME Interception (`navigator.requestMediaKeySystemAccess`)**: `0` calls recorded (`[]`).
- **License / Key Exchange Requests**: None observed in network logs.
- **DRM Observation**: No DRM detected on sample `pO1k7`.
- **Boundary Constraint**: This observation applies **only to sample `pO1k7`** and cannot be extrapolated to the entire site.

---

## 5. FFprobe Stream Analysis (From 5MB Bounded FastStart Slice)

FFprobe successfully parsed the moov atom from the 5MB slice without full video download:

```json
{
  "streams": [
    {
      "index": 0,
      "codec_name": "h264",
      "codec_long_name": "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
      "profile": "High",
      "codec_type": "video",
      "codec_tag_string": "avc1",
      "width": 2160,
      "height": 2160,
      "coded_width": 2160,
      "coded_height": 2160,
      "sample_aspect_ratio": "1:1",
      "display_aspect_ratio": "1:1",
      "pix_fmt": "yuv420p",
      "level": 50,
      "field_order": "progressive",
      "r_frame_rate": "30/1",
      "avg_frame_rate": "763305/25469",
      "duration": "1697.933333",
      "bit_rate": "2364351"
    },
    {
      "index": 1,
      "codec_name": "aac",
      "codec_long_name": "AAC (Advanced Audio Coding)",
      "profile": "LC",
      "codec_type": "audio",
      "codec_tag_string": "mp4a",
      "sample_rate": "48000",
      "channels": 2,
      "channel_layout": "stereo",
      "duration": "1697.962667",
      "bit_rate": "128834"
    }
  ],
  "format": {
    "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
    "duration": "1698.000000",
    "size": "5242880",
    "tags": {
      "major_brand": "isom",
      "minor_version": "512",
      "compatible_brands": "isomiso2avc1mp41",
      "encoder": "Lavf60.16.100"
    }
  }
}
```

- **Video Coded Resolution**: `2160x2160` (Top-Bottom format, corresponding to dual 2160x1080 eyes)
- **Video Codec**: `h264 (High Profile, Level 5.0, avc1)` @ `30 fps`
- **Audio Codec**: `aac (LC, mp4a, 48000 Hz, stereo)`
- **Duration**: `1698.0s` (~28.3 minutes)

---

## 6. Classification for Sample `pO1k7`

| Capability / Observation | Evidence Level | Notes |
| :--- | :---: | :--- |
| **Page Resolver (DOM extraction)** | `[VERIFIED]` | Verified on sample `pO1k7` |
| **Delight VR `<dl8-video>` Discovery** | `[VERIFIED]` | Verified on sample `pO1k7` (`format="STEREO_180_TB"`) |
| **Quality Enumeration (`720P`, `1080P`)** | `[VERIFIED]` | Verified on sample `pO1k7` (No 4K/8K on this page) |
| **Direct MP4 HTTP 206 Range Transport** | `[VERIFIED]` | Verified on sample `pO1k7` (5MB bounded chunk, status 206) |
| **FFprobe Metadata from Bounded Moov** | `[VERIFIED]` | Verified on sample `pO1k7` (FastStart parsed in 5MB) |
| **No DRM on Sample** | `[VERIFIED]` | Verified on sample `pO1k7` only |
| **Cloudflare Protection Dependency** | `[VERIFIED]` | Non-session request triggers 403; session required |
| **Catalog-Wide Format Uniformity** | `[REPORTED]` | Historical 10-sample survey; not verified on whole site |
| **Token Refresh & Resumability** | `[UNKNOWN]` | Needs runtime hook during implementation |
