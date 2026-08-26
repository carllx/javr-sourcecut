# Eporner Browser Companion

A lightweight browser userscript for filtering 4K+ candidate videos and detecting AV1 format availability on Eporner.

## Language

### Core Filtering

**Hard Filter (4K+ Filter)**:
The irreversible removal from the DOM of video cards whose advertised resolution is strictly below 2160p (4K).
_Avoid_: Soft delete, hide, mute

**Soft Filter (Only-AV1 View)**:
The reversible temporary hiding (via display toggling) of 4K+ video cards confirmed to lack an AV1 rendition.
_Avoid_: Hard filter, permanent delete, DOM removal

**Candidate Video**:
An Eporner video card that has passed the 4K+ Hard Filter and is eligible for AV1 format probing.
_Avoid_: Download job, target, item

**Optimistic Visibility**:
The display policy where non-conclusive cards (`pending`, `probing`, `unknown`, `error`) remain visible in Only-AV1 View until confirmed as `no_av1`.
_Avoid_: Strict filtering, speculative hiding

### Format Detection & Lifecycle

**AV1 Rendition**:
A video stream encoded in AV1 format available for a given video on Eporner.
_Avoid_: Video quality, download format

**Rendition Profile**:
The structured detection result for a candidate video, containing maximum advertised resolution, AV1 available resolutions, highest AV1 resolution, 4K AV1 existence flag, and probe status.
_Avoid_: Video info, format metadata

**Probe Status**:
The lifecycle state of AV1 detection for a candidate card: `pending`, `probing`, `detected`, `no_av1`, `unknown`, or `error`.
_Avoid_: Progress, load state

**Format Badge**:
The visual in-card status indicator displaying resolution and AV1 availability (e.g., `4K · AV1 4K`, `4K · AV1 1080p`, `4K · NO AV1`, `4K · ?`), which can be clicked to manually retry when in an error state.
_Avoid_: Tag, label, chip

**Floating Toolbar**:
The simple, fixed-position screen overlay containing the Hard Filter toggle, Soft Filter toggle, and compact status counters.
_Avoid_: Modal, sidebar, floating dock

